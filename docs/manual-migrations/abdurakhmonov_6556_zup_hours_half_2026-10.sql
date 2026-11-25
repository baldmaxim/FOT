-- One-off data fix, not a migration. ASCII on purpose. NO COMMIT in this file.
--
-- Abdurakhmonov S.M.U. (employee_id = 6556, tab 06078), October 2026, object "ZhK Dom 56".
-- The ZUP align run 6ec1adb4 (13.11) wrote the hours of the 1C timesheet into his days,
-- and 1C had them doubled. The brigade result fixed on 05.11 counted 105 h = 9 x 11 + 6.
--
--   attendance_adjustments id   date         before   after
--   1145643 .. 1145645          01-03.10     22.00    11.00
--   1145646                     04.10        12.00     6.00
--   1145647 .. 1145652          05-10.10     22.00    11.00
--   month total                              210 h    105 h
--
-- Same row, same object, same comment (reason) and author (none): only hours_override and
-- updated_at change. metadata.zup_align stays; metadata.hours_half_fix keeps the previous hours
-- and updated_at for the rollback. One audit_logs row per day (UPDATE_TIMESHEET_ENTRY).
-- Days 11-20.10 are not touched.
--
-- No approval covers him in October (checked below), so nothing to rebuild.
-- Any difference from the expected state raises STOP and nothing is applied.
-- A second run stops with "already applied".
--
-- Run in interactive psql (see DEPLOY.md for DATABASE_URL and PGSSLROOTCERT):
--   psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL"
--   \i ~/abdurakhmonov_6556_zup_hours_half_2026-10.sql
-- Compare the output with the \echo text at the end, then type one of:
--   COMMIT;
--   ROLLBACK;
-- Rows stay locked until then, so do not leave the session open
-- (idle_in_transaction_session_timeout rolls it back after 3 minutes).
--
-- Undo after COMMIT:
--   docs/rollbacks/abdurakhmonov_6556_zup_hours_half_2026-10_rollback.sql

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL idle_in_transaction_session_timeout = '3min';

DO $fix$
DECLARE
  c_employee CONSTANT integer := 6556;
  c_object   CONSTANT text := '484ff35d-6518-472d-ad6d-e2cb6cb1c4ce';
  c_run      CONSTANT text := '6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a';
  c_fix      CONSTANT text := 'abdurakhmonov_6556_zup_hours_half_2026-10';
  c_ids      CONSTANT bigint[] := ARRAY[1145643, 1145644, 1145645, 1145646, 1145647,
                                        1145648, 1145649, 1145650, 1145651, 1145652];
  -- 'ZUP' in Cyrillic, as UTF-8 bytes (the file stays ASCII).
  c_reason   CONSTANT text := convert_from('\xd097d0a3d09f'::bytea, 'UTF8');
  v_actual   text;
  v_count    integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM employees
     WHERE id = c_employee AND tab_number = '06078' AND sigur_employee_id = 143060
  ) THEN
    RAISE EXCEPTION 'STOP: employee 6556 (tab 06078) not found';
  END IF;

  PERFORM 1 FROM attendance_adjustments
   WHERE employee_id = c_employee
     AND work_date BETWEEN DATE '2026-10-01' AND DATE '2026-10-10'
   ORDER BY id
     FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM attendance_adjustments
     WHERE id = ANY(c_ids) AND metadata ? 'hours_half_fix'
  ) THEN
    RAISE EXCEPTION 'STOP: already applied (metadata.hours_half_fix is present), nothing to do';
  END IF;

  -- Preconditions: exactly these 10 rows on 01-10.10, one per day, as written by run 6ec1adb4.
  SELECT string_agg(
           id::text || ' ' || work_date::text || ' ' || status || ' ' || source_type || ' '
             || source_id || ' ' || COALESCE(hours_override::text, 'null') || ' '
             || COALESCE(metadata->>'object_id', '-') || ' '
             || COALESCE(metadata->'zup_align'->>'run_id', '-') || ' '
             || approval_status || ' ' || COALESCE(created_by::text, 'nobody') || ' '
             || (reason IS NOT DISTINCT FROM c_reason)::text || ' '
             || to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           E'\n' ORDER BY work_date, id)
    INTO v_actual
    FROM attendance_adjustments
   WHERE employee_id = c_employee
     AND work_date BETWEEN DATE '2026-10-01' AND DATE '2026-10-10';
  IF v_actual IS DISTINCT FROM concat_ws(E'\n',
    '1145643 2026-10-01 manual manual_object 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 22.00 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a auto_approved nobody true 2026-11-13T14:26:59.797000Z',
    '1145644 2026-10-02 manual manual_object 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 22.00 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a auto_approved nobody true 2026-11-13T14:26:59.815000Z',
    '1145645 2026-10-03 manual manual_object 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 22.00 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a auto_approved nobody true 2026-11-13T14:26:59.833000Z',
    '1145646 2026-10-04 manual manual_object 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 12.00 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a auto_approved nobody true 2026-11-13T14:26:59.857000Z',
    '1145647 2026-10-05 manual manual_object 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 22.00 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a auto_approved nobody true 2026-11-13T14:26:59.875000Z',
    '1145648 2026-10-06 manual manual_object 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 22.00 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a auto_approved nobody true 2026-11-13T14:26:59.894000Z',
    '1145649 2026-10-07 manual manual_object 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 22.00 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a auto_approved nobody true 2026-11-13T14:26:59.912000Z',
    '1145650 2026-10-08 manual manual_object 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 22.00 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a auto_approved nobody true 2026-11-13T14:26:59.930000Z',
    '1145651 2026-10-09 manual manual_object 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 22.00 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a auto_approved nobody true 2026-11-13T14:26:59.948000Z',
    '1145652 2026-10-10 manual manual_object 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 22.00 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a auto_approved nobody true 2026-11-13T14:26:59.977000Z'
  ) THEN
    RAISE EXCEPTION 'STOP: days 01-10.10 differ from expected:%', E'\n' || COALESCE(v_actual, '(none)');
  END IF;

  IF EXISTS (
    SELECT 1 FROM document_links
     WHERE entity_type = 'attendance_adjustment' AND entity_id = ANY(c_ids::text[])
  ) THEN
    RAISE EXCEPTION 'STOP: files are attached to these days';
  END IF;

  SELECT string_agg(a.id::text || ' ' || a.status, ', ' ORDER BY a.id)
    INTO v_actual
    FROM timesheet_approvals a
    JOIN timesheet_approval_employees t ON t.approval_id = a.id
   WHERE t.employee_id = c_employee
     AND a.end_date >= DATE '2026-10-01'
     AND a.start_date <= DATE '2026-10-31';
  IF v_actual IS NOT NULL THEN
    RAISE EXCEPTION 'STOP: approvals now cover his October: %', v_actual;
  END IF;

  INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
  SELECT NULL, 'UPDATE_TIMESHEET_ENTRY', 'timesheet', a.id::text, jsonb_build_object(
           'source', 'manual_sql',
           'fix', c_fix,
           'employee_id', c_employee,
           'work_date', a.work_date::text,
           'object_id', c_object,
           'hours_before', a.hours_override,
           'hours_after', CASE a.hours_override WHEN 22 THEN 11 WHEN 12 THEN 6 END,
           'zup_run_id', c_run,
           'note', '1C (ZUP) hours were doubled: 22 -> 11, 12 -> 6')
    FROM attendance_adjustments a
   WHERE a.id = ANY(c_ids);

  UPDATE attendance_adjustments a
     SET hours_override = CASE a.hours_override WHEN 22 THEN 11 WHEN 12 THEN 6 END,
         updated_at = now(),
         metadata = a.metadata || jsonb_build_object('hours_half_fix', jsonb_build_object(
           'fix', c_fix,
           'prev_hours', a.hours_override,
           'prev_updated_at', to_char(a.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           'note', '1C (ZUP) hours were doubled: 22 -> 11, 12 -> 6',
           'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
   WHERE a.id = ANY(c_ids)
     AND a.employee_id = c_employee
     AND a.hours_override IN (22, 12);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 10 THEN
    RAISE EXCEPTION 'STOP: updated % rows, expected 10', v_count;
  END IF;

  -- Postconditions
  SELECT string_agg(work_date::text || ' ' || hours_override::text, ', ' ORDER BY work_date)
    INTO v_actual
    FROM attendance_adjustments
   WHERE employee_id = c_employee
     AND work_date BETWEEN DATE '2026-10-01' AND DATE '2026-10-10';
  IF v_actual IS DISTINCT FROM
     '2026-10-01 11.00, 2026-10-02 11.00, 2026-10-03 11.00, 2026-10-04 6.00, 2026-10-05 11.00, '
     || '2026-10-06 11.00, 2026-10-07 11.00, 2026-10-08 11.00, 2026-10-09 11.00, 2026-10-10 11.00' THEN
    RAISE EXCEPTION 'STOP: unexpected result: %', v_actual;
  END IF;
END
$fix$;

SELECT a.id, a.work_date, a.hours_override,
       a.metadata->'hours_half_fix'->>'prev_hours' AS prev_hours,
       a.metadata->>'object_name' AS object
  FROM attendance_adjustments a
 WHERE a.employee_id = 6556
   AND a.work_date BETWEEN DATE '2026-10-01' AND DATE '2026-10-10'
 ORDER BY a.work_date;

SELECT sum(hours_override) AS total_hours_01_10
  FROM attendance_adjustments
 WHERE employee_id = 6556
   AND work_date BETWEEN DATE '2026-10-01' AND DATE '2026-10-10';

\echo
\echo 'Expected: 10 rows 1145643..1145652; hours 11.00 on 01-03.10 and 05-10.10, 6.00 on 04.10;'
\echo 'prev_hours 22 / 12; total_hours_01_10 = 105.00.'
\echo 'If so, type COMMIT;   otherwise ROLLBACK;'
