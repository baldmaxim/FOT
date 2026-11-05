-- Undo of docs/manual-migrations/pristavka_stenyaev_liniya_2026-11.sql and of
-- fot-server/scripts/fix-liniya-version-employees.ts. ASCII on purpose. NO COMMIT in this file.
--
-- Restores the assignments of 6550 and 1700. If the script already ran, also removes exactly
-- the revisions it created and returns both people to the rosters of the source approvals.
-- It finds them in the audit: the latest fix row with latest_versions, and the move rows after
-- that row. Older rows, already undone, are not used. Revisions made by HR are never removed.
--
-- Refuses with STOP when the state is not exactly what the fix left behind:
--   - any of the 8 approvals has a newer version than the fix or the script made. HR rebuilt it
--     after the fix, so going back would break their work: the only way is forward;
--   - an approval is open or waits for a rebuild, or 1C has acknowledged one.
--
-- Run in interactive psql:
--   \i /opt/fot-build/docs/rollbacks/pristavka_stenyaev_liniya_2026-11_rollback.sql
-- Check the output, then type COMMIT; or ROLLBACK;

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $undo$
DECLARE
  c_obsh       CONSTANT uuid := '0b24809e-5f04-45e1-bbe2-8a82990d6bdd';
  c_p_transfer CONSTANT uuid := '570522ed-d8b5-46f6-88ff-a336b3e52814';
  c_p_obsh     CONSTANT uuid := '72935066-9280-408c-97f7-eae219e01126';
  c_s_open     CONSTANT uuid := 'bb46a137-54a6-4e56-ae98-ca16508b8764';
  v_actual   text;
  v_fix_id   bigint;
  v_latest   jsonb;
  v_expected jsonb;
  v_move     jsonb;
  v_remove   bigint[] := ARRAY[]::bigint[];
  v_bad      text;
  v_count    integer;
BEGIN
  PERFORM 1 FROM employees WHERE id IN (6550, 1700) FOR UPDATE;
  PERFORM 1 FROM employee_assignments WHERE employee_id IN (6550, 1700) FOR UPDATE;
  PERFORM 1 FROM timesheet_approvals WHERE id IN (2304, 2305, 2512, 2513, 2772, 2773, 2806, 2807) FOR UPDATE;

  -- A repeated undo stops here: the assignments are already back.
  SELECT string_agg(
           id::text || ' ' || org_department_id::text || ' ' || effective_from::text
             || ' ' || COALESCE(effective_to::text, 'open'),
           E'\n' ORDER BY employee_id, effective_from)
    INTO v_actual
    FROM employee_assignments
   WHERE employee_id IN (6550, 1700);
  IF v_actual IS DISTINCT FROM concat_ws(E'\n',
    'f4c08f6d-e760-4d3d-8512-ffa877c05576 0b24809e-5f04-45e1-bbe2-8a82990d6bdd 2025-12-31 2025-12-31',
    'ba656d1e-d19b-4ad6-bad8-1207086da5eb 0b24809e-5f04-45e1-bbe2-8a82990d6bdd 2026-01-01 2026-03-31',
    '78b5fe86-6838-4b63-b713-f3eb4657defc 60e94f0c-7b39-4c5c-be92-6d8c0ad0d7c4 2026-04-01 2026-07-05',
    'bb46a137-54a6-4e56-ae98-ca16508b8764 60e94f0c-7b39-4c5c-be92-6d8c0ad0d7c4 2026-07-06 open',
    '72935066-9280-408c-97f7-eae219e01126 0b24809e-5f04-45e1-bbe2-8a82990d6bdd 2026-05-22 2026-06-30',
    '570522ed-d8b5-46f6-88ff-a336b3e52814 60e94f0c-7b39-4c5c-be92-6d8c0ad0d7c4 2026-07-01 open'
  ) THEN
    RAISE EXCEPTION 'STOP: assignments differ from the fixed state:%', E'\n' || COALESCE(v_actual, '(none)');
  END IF;

  SELECT id, details->'latest_versions'
    INTO v_fix_id, v_latest
    FROM audit_logs
   WHERE action = 'UPDATE_TRANSFER'
     AND entity_id = '6550'
     AND details->>'source' = 'manual_sql'
     AND details ? 'latest_versions'
   ORDER BY id DESC
   LIMIT 1;
  IF v_latest IS NULL THEN
    RAISE EXCEPTION 'STOP: the audit row of the fix with latest_versions was not found';
  END IF;

  -- What must be the latest version of each approval if only the fix and the script touched it.
  v_expected := v_latest;
  FOR v_move IN
    SELECT details FROM audit_logs
     WHERE action = 'TIMESHEET_VERSION_EMPLOYEES_MOVED' AND id > v_fix_id
     ORDER BY id
  LOOP
    v_expected := v_expected || jsonb_build_object(
      v_move->>'from_approval_id', (v_move->>'from_version_after')::bigint,
      v_move->>'to_approval_id', (v_move->>'to_version_after')::bigint);
    v_remove := v_remove || (v_move->>'from_version_after')::bigint || (v_move->>'to_version_after')::bigint;
  END LOOP;

  SELECT string_agg(
           a.id::text || ': latest ' || COALESCE(l.id::text, 'none')
             || ', expected ' || COALESCE(v_expected->>(a.id::text), 'none'),
           '; ' ORDER BY a.id)
    INTO v_bad
    FROM timesheet_approvals a
    LEFT JOIN LATERAL (
      SELECT v.id FROM timesheet_versions v
       WHERE v.approval_id = a.id
       ORDER BY v.revision DESC
       LIMIT 1
    ) l ON true
   WHERE a.id IN (2304, 2305, 2512, 2513, 2772, 2773, 2806, 2807)
     AND l.id::text IS DISTINCT FROM v_expected->>(a.id::text);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'STOP: an approval was rebuilt after the fix, the only way is forward: %', v_bad;
  END IF;

  SELECT string_agg(id::text, ', ' ORDER BY id)
    INTO v_bad
    FROM timesheet_approvals
   WHERE id IN (2304, 2305, 2512, 2513, 2772, 2773, 2806, 2807)
     AND (status <> 'approved' OR unlocked_at IS NOT NULL OR version_dirty_at IS NOT NULL);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'STOP: approvals are open or wait for a rebuild: %', v_bad;
  END IF;

  IF EXISTS (
    SELECT 1 FROM timesheet_1c_exports x
      JOIN timesheet_versions v ON v.id = x.version_id
     WHERE v.approval_id IN (2304, 2305, 2512, 2513, 2772, 2773, 2806, 2807)
  ) THEN
    RAISE EXCEPTION 'STOP: 1C has already acknowledged one of the approvals';
  END IF;

  -- Dependent rows of a version go by ON DELETE CASCADE.
  DELETE FROM timesheet_versions WHERE id = ANY(v_remove);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> cardinality(v_remove) THEN
    RAISE EXCEPTION 'STOP: removed % versions instead of %', v_count, cardinality(v_remove);
  END IF;

  -- A plain INSERT on purpose: a person already in the roster is an unexpected state.
  INSERT INTO timesheet_approval_employees (approval_id, employee_id, full_name)
  SELECT (m.details->>'from_approval_id')::bigint, r.employee_id::bigint, e.full_name
    FROM audit_logs m
   CROSS JOIN LATERAL jsonb_array_elements_text(m.details->'moved_employees') AS r(employee_id)
    JOIN employees e ON e.id = r.employee_id::integer
   WHERE m.action = 'TIMESHEET_VERSION_EMPLOYEES_MOVED' AND m.id > v_fix_id;

  -- Reverse order of the fix: the overlap trigger holds at every step.
  UPDATE employee_assignments SET effective_from = DATE '2026-04-01', effective_to = DATE '2026-05-21'
   WHERE id = c_p_transfer AND employee_id = 6550;
  UPDATE employee_assignments SET effective_to = NULL
   WHERE id = c_p_obsh AND employee_id = 6550;
  UPDATE employee_assignments SET org_department_id = c_obsh
   WHERE id = c_s_open AND employee_id = 1700;

  -- Postcondition: each approval is back on the version it had at the fix.
  SELECT string_agg(a.id::text, ', ' ORDER BY a.id)
    INTO v_bad
    FROM timesheet_approvals a
    LEFT JOIN LATERAL (
      SELECT v.id FROM timesheet_versions v
       WHERE v.approval_id = a.id
       ORDER BY v.revision DESC
       LIMIT 1
    ) l ON true
   WHERE a.id IN (2304, 2305, 2512, 2513, 2772, 2773, 2806, 2807)
     AND l.id::text IS DISTINCT FROM v_latest->>(a.id::text);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'STOP: approvals are not on the version of the fix: %', v_bad;
  END IF;

  INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
  VALUES
    (NULL, 'UPDATE_TRANSFER', 'employee', '6550', jsonb_build_object(
       'source', 'manual_sql_rollback', 'employee_id', 6550,
       'employee_full_name', (SELECT full_name FROM employees WHERE id = 6550),
       'fix_audit_id', v_fix_id,
       'removed_versions', to_jsonb(v_remove))),
    (NULL, 'UPDATE_TRANSFER', 'employee', '1700', jsonb_build_object(
       'source', 'manual_sql_rollback', 'employee_id', 1700,
       'employee_full_name', (SELECT full_name FROM employees WHERE id = 1700),
       'fix_audit_id', v_fix_id,
       'removed_versions', to_jsonb(v_remove)));
END
$undo$;

SELECT a.employee_id, d.name AS department, a.effective_from, a.effective_to
  FROM employee_assignments a
  LEFT JOIN org_departments d ON d.id = a.org_department_id
 WHERE a.employee_id IN (6550, 1700)
 ORDER BY a.employee_id, a.effective_from;

SELECT a.id, l.id AS latest_version, l.revision, l.total_hours,
       (SELECT count(*) FROM timesheet_approval_employees t
         WHERE t.approval_id = a.id AND t.employee_id IN (6550, 1700)) AS ours_in_roster
  FROM timesheet_approvals a
  LEFT JOIN LATERAL (
    SELECT v.id, v.revision, v.total_hours FROM timesheet_versions v
     WHERE v.approval_id = a.id
     ORDER BY v.revision DESC
     LIMIT 1
  ) l ON true
 WHERE a.id IN (2304, 2305, 2512, 2513, 2772, 2773, 2806, 2807)
 ORDER BY a.id;

\echo
\echo Expected first table, 6 rows.
\echo 1700: Obshchestroy, Obshchestroy .. 2026-03-31, LINIYA 2026-04-01 .. 2026-07-05, Obshchestroy 2026-07-06 .. empty.
\echo 6550: LINIYA 2026-04-01 .. 2026-05-21, Obshchestroy 2026-05-22 .. empty.
\echo Expected second table, ours_in_roster: 2304 2, 2305 2, 2512 1, 2513 1, 2772 2, 2773 2, 2806 2, 2807 2.
\echo If it matches type COMMIT; otherwise type ROLLBACK;
