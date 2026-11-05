-- Undo of docs/manual-migrations/pristavka_stenyaev_liniya_2026-11.sql and of
-- fot-server/scripts/fix-liniya-version-employees.ts. ASCII on purpose. NO COMMIT in this file.
--
-- Restores the assignments of 6550 and 1700. If the script already ran, also removes its
-- revisions 2 (dependent rows go by ON DELETE CASCADE) and returns both people to the
-- rosters of the Obshchestroy approvals, so revisions 1 are current again.
-- Refuses to run if the state is not exactly what the fix left behind.
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
  v_actual text;
  v_rev2   integer;
BEGIN
  PERFORM 1 FROM employees WHERE id IN (6550, 1700) FOR UPDATE;
  PERFORM 1 FROM employee_assignments WHERE employee_id IN (6550, 1700) FOR UPDATE;
  PERFORM 1 FROM timesheet_approvals WHERE id IN (2304, 2305, 2512, 2513, 2772, 2773, 2806, 2807) FOR UPDATE;

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

  -- Only the revisions of the script: nothing newer, nothing 1C has seen.
  IF EXISTS (
    SELECT 1 FROM timesheet_versions
     WHERE approval_id IN (2304, 2305, 2512, 2513, 2772, 2773, 2806, 2807)
       AND (revision > 2 OR (revision = 2 AND source <> 'rebuild'))
  ) THEN
    RAISE EXCEPTION 'STOP: a revision other than the script ones appeared';
  END IF;
  IF EXISTS (
    SELECT 1 FROM timesheet_1c_exports x
      JOIN timesheet_versions v ON v.id = x.version_id
     WHERE v.approval_id IN (2304, 2305, 2512, 2513, 2772, 2773, 2806, 2807)
  ) THEN
    RAISE EXCEPTION 'STOP: 1C has already acknowledged one of the approvals';
  END IF;
  IF EXISTS (
    SELECT 1 FROM timesheet_approvals
     WHERE id IN (2304, 2305, 2512, 2513, 2772, 2773, 2806, 2807)
       AND (status <> 'approved' OR unlocked_at IS NOT NULL OR version_dirty_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'STOP: one of the approvals is no longer closed';
  END IF;

  DELETE FROM timesheet_versions
   WHERE approval_id IN (2304, 2305, 2512, 2513, 2772, 2773, 2806, 2807) AND revision = 2;
  GET DIAGNOSTICS v_rev2 = ROW_COUNT;
  IF v_rev2 NOT IN (0, 2, 4, 6, 8) THEN
    RAISE EXCEPTION 'STOP: removed % revisions, expected a pair per moved approval', v_rev2;
  END IF;

  INSERT INTO timesheet_approval_employees (approval_id, employee_id, full_name)
  SELECT r.approval_id, r.employee_id, e.full_name
    FROM (VALUES (2512, 6550), (2513, 6550), (2806, 6550), (2806, 1700), (2807, 6550), (2807, 1700))
         AS r(approval_id, employee_id)
    JOIN employees e ON e.id = r.employee_id
  ON CONFLICT DO NOTHING;

  -- Reverse order of the fix: the overlap trigger holds at every step.
  UPDATE employee_assignments SET effective_from = DATE '2026-04-01', effective_to = DATE '2026-05-21'
   WHERE id = c_p_transfer AND employee_id = 6550;
  UPDATE employee_assignments SET effective_to = NULL
   WHERE id = c_p_obsh AND employee_id = 6550;
  UPDATE employee_assignments SET org_department_id = c_obsh
   WHERE id = c_s_open AND employee_id = 1700;

  INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
  VALUES
    (NULL, 'UPDATE_TRANSFER', 'employee', '6550', jsonb_build_object(
       'source', 'manual_sql_rollback', 'employee_id', 6550,
       'employee_full_name', (SELECT full_name FROM employees WHERE id = 6550),
       'removed_revisions', v_rev2)),
    (NULL, 'UPDATE_TRANSFER', 'employee', '1700', jsonb_build_object(
       'source', 'manual_sql_rollback', 'employee_id', 1700,
       'employee_full_name', (SELECT full_name FROM employees WHERE id = 1700),
       'removed_revisions', v_rev2));
END
$undo$;

SELECT a.employee_id, d.name AS department, a.effective_from, a.effective_to
  FROM employee_assignments a
  LEFT JOIN org_departments d ON d.id = a.org_department_id
 WHERE a.employee_id IN (6550, 1700)
 ORDER BY a.employee_id, a.effective_from;

SELECT v.approval_id, max(v.revision) AS latest_revision,
       (SELECT count(*) FROM timesheet_approval_employees t
         WHERE t.approval_id = v.approval_id AND t.employee_id IN (6550, 1700)) AS ours_in_roster
  FROM timesheet_versions v
 WHERE v.approval_id IN (2304, 2305, 2512, 2513, 2772, 2773, 2806, 2807)
 GROUP BY v.approval_id
 ORDER BY v.approval_id;

\echo
\echo Expected first table, 6 rows.
\echo 1700: Obshchestroy, Obshchestroy .. 2026-03-31, LINIYA 2026-04-01 .. 2026-07-05, Obshchestroy 2026-07-06 .. empty.
\echo 6550: LINIYA 2026-04-01 .. 2026-05-21, Obshchestroy 2026-05-22 .. empty.
\echo Expected second table: latest_revision 1 everywhere. ours_in_roster: 2304 2, 2305 2, 2512 1, 2513 1, 2772 2, 2773 2, 2806 2, 2807 2.
\echo If it matches type COMMIT; otherwise type ROLLBACK;
