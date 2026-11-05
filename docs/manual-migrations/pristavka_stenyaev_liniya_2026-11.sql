-- One-off data fix, not a migration. ASCII on purpose. NO COMMIT in this file.
--
-- Pristavka E.S. (6550) and Stenyaev D.V. (1700) belong to LINIYA, not LINIYA-Obshchestroy.
-- On 2026-07-08 both were moved to LINIYA dated 2026-04-01. The old code (fixed 2026-07-14)
-- inserted a closed period before the later assignment and left that one open in
-- Obshchestroy, while the employee card became LINIYA. Result: two departments at once,
-- and the "Unified 1C" file lists them under Obshchestroy.
--
-- 6550, dates from 1C document UPR00000439 (transfer from 2026-07-01):
--   Before                             After
--   LINIYA       2026-04-01..05-21     Obshchestroy 2026-05-22..06-30
--   Obshchestroy 2026-05-22..open      LINIYA       2026-07-01..open
--   The false period row 570522ed is not deleted: it carries the real transfer
--   (reason, created_at 2026-07-08) and only gets the right dates.
--
-- 1700:
--   LINIYA       2026-04-01..07-05     not touched
--   Obshchestroy 2026-07-06..open      LINIYA 2026-07-06..open
--
-- Closed approvals are NOT changed here. In the same sitting, after COMMIT, run
--   fot-server/scripts/fix-liniya-version-employees.ts
-- which moves their hours from the Obshchestroy revisions to the LINIYA ones. Payroll
-- does not change in between (checked on a copy), but until then the days belong to
-- LINIYA while the hours lie in Obshchestroy: closing LINIYA again at that moment would
-- put the same days into two approvals, and the script would refuse.
--
-- Any difference from the expected state raises STOP and nothing is applied.
--
-- Run in interactive psql (see DEPLOY.md for DATABASE_URL and PGSSLROOTCERT):
--   psql "$DATABASE_URL"
--   \i /opt/fot-build/docs/manual-migrations/pristavka_stenyaev_liniya_2026-11.sql
-- Compare the output with the \echo text at the end, then type one of:
--   COMMIT;
--   ROLLBACK;
-- Rows stay locked until then, so do not leave the session open.
--
-- Undo after COMMIT:
--   docs/rollbacks/pristavka_stenyaev_liniya_2026-11_rollback.sql

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $fix$
DECLARE
  c_liniya CONSTANT uuid := '60e94f0c-7b39-4c5c-be92-6d8c0ad0d7c4';
  c_obsh   CONSTANT uuid := '0b24809e-5f04-45e1-bbe2-8a82990d6bdd';
  c_p_transfer CONSTANT uuid := '570522ed-d8b5-46f6-88ff-a336b3e52814';
  c_p_obsh     CONSTANT uuid := '72935066-9280-408c-97f7-eae219e01126';
  c_s_open     CONSTANT uuid := 'bb46a137-54a6-4e56-ae98-ca16508b8764';
  v_actual text;
BEGIN
  PERFORM 1 FROM employees WHERE id IN (6550, 1700) FOR UPDATE;
  PERFORM 1 FROM employee_assignments WHERE employee_id IN (6550, 1700) FOR UPDATE;
  PERFORM 1 FROM timesheet_approvals WHERE id IN (2304, 2305, 2512, 2513, 2772, 2773, 2806, 2807) FOR UPDATE;

  -- Preconditions
  IF (SELECT count(*) FROM employees
       WHERE id IN (6550, 1700) AND org_department_id = c_liniya AND employment_status = 'active') <> 2 THEN
    RAISE EXCEPTION 'STOP: 6550 and 1700 must both be active with the card in LINIYA';
  END IF;

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
    'bb46a137-54a6-4e56-ae98-ca16508b8764 0b24809e-5f04-45e1-bbe2-8a82990d6bdd 2026-07-06 open',
    '570522ed-d8b5-46f6-88ff-a336b3e52814 60e94f0c-7b39-4c5c-be92-6d8c0ad0d7c4 2026-04-01 2026-05-21',
    '72935066-9280-408c-97f7-eae219e01126 0b24809e-5f04-45e1-bbe2-8a82990d6bdd 2026-05-22 open'
  ) THEN
    RAISE EXCEPTION 'STOP: assignments differ from expected:%', E'\n' || COALESCE(v_actual, '(none)');
  END IF;

  SELECT string_agg(
           a.id::text || ' ' || a.status
             || CASE WHEN a.unlocked_at IS NULL AND a.version_dirty_at IS NULL
                     THEN ' closed' ELSE ' open_or_dirty' END
             || ' v' || (SELECT max(v.id)::text FROM timesheet_versions v WHERE v.approval_id = a.id),
           ', ' ORDER BY a.id)
    INTO v_actual
    FROM timesheet_approvals a
   WHERE a.id IN (2304, 2305, 2512, 2513, 2772, 2773, 2806, 2807);
  IF v_actual IS DISTINCT FROM
     '2304 approved closed v1711, 2305 approved closed v1713, 2512 approved closed v1817, '
     || '2513 approved closed v1819, 2772 approved closed v1948, 2773 approved closed v1949, '
     || '2806 approved closed v2022, 2807 approved closed v2023' THEN
    RAISE EXCEPTION 'STOP: approvals differ from expected: %', COALESCE(v_actual, '(none)');
  END IF;

  IF EXISTS (
    SELECT 1 FROM timesheet_1c_exports x
      JOIN timesheet_versions v ON v.id = x.version_id
     WHERE v.approval_id IN (2304, 2305, 2512, 2513, 2772, 2773, 2806, 2807)
  ) THEN
    RAISE EXCEPTION 'STOP: 1C has already acknowledged one of the approvals';
  END IF;

  -- Assignments: this order keeps the overlap trigger satisfied at every step.
  UPDATE employee_assignments SET effective_to = DATE '2026-06-30'
   WHERE id = c_p_obsh AND employee_id = 6550;
  UPDATE employee_assignments SET effective_from = DATE '2026-07-01', effective_to = NULL
   WHERE id = c_p_transfer AND employee_id = 6550;
  UPDATE employee_assignments SET org_department_id = c_liniya
   WHERE id = c_s_open AND employee_id = 1700;

  INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
  VALUES
    (NULL, 'UPDATE_TRANSFER', 'employee', '6550', jsonb_build_object(
       'source', 'manual_sql',
       'employee_id', 6550,
       'employee_full_name', (SELECT full_name FROM employees WHERE id = 6550),
       'assignment_new_id', c_p_transfer,
       'assignment_old_id', c_p_obsh,
       'new_effective_from', '2026-07-01',
       'new_effective_to_old', '2026-06-30')),
    (NULL, 'UPDATE_TRANSFER', 'employee', '1700', jsonb_build_object(
       'source', 'manual_sql',
       'employee_id', 1700,
       'employee_full_name', (SELECT full_name FROM employees WHERE id = 1700),
       'assignment_new_id', c_s_open,
       'from_department_id', c_obsh,
       'to_department_id', c_liniya));

  -- Postconditions
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
    RAISE EXCEPTION 'STOP: unexpected result:%', E'\n' || COALESCE(v_actual, '(none)');
  END IF;

  IF (SELECT count(*) FROM employees e
        JOIN employee_assignments a ON a.employee_id = e.id AND a.effective_to IS NULL
       WHERE e.id IN (6550, 1700) AND a.org_department_id = e.org_department_id) <> 2 THEN
    RAISE EXCEPTION 'STOP: the open assignment does not match the card';
  END IF;
END
$fix$;

SELECT a.employee_id, d.name AS department, a.effective_from, a.effective_to
  FROM employee_assignments a
  LEFT JOIN org_departments d ON d.id = a.org_department_id
 WHERE a.employee_id IN (6550, 1700)
 ORDER BY a.employee_id, a.effective_from;

\echo
\echo Expected 6 rows.
\echo 1700: Obshchestroy 2025-12-31 .. 2025-12-31, Obshchestroy 2026-01-01 .. 2026-03-31,
\echo LINIYA 2026-04-01 .. 2026-07-05, LINIYA 2026-07-06 .. empty.
\echo 6550: Obshchestroy 2026-05-22 .. 2026-06-30, LINIYA 2026-07-01 .. empty.
\echo If it matches type COMMIT; otherwise type ROLLBACK;
\echo After COMMIT run fix-liniya-version-employees.ts in the same sitting.
