-- One-off data fix, not a migration. ASCII on purpose. NO COMMIT in this file.
--
-- Mustafaev M.F. (employee_id = 1218, tab 05183), October 2026, object "ZhK Dom 56".
-- The ZUP align run 6ec1adb4 (13.11) wrote the hours of the 1C timesheet into his days,
-- and 1C had exactly twice the FOT hours on these days (rows 19677-19693 of the 1C file,
-- column "V FOT seychas" of Korrektirovki_ZUP_oktyabr_2026.xlsx).
--
--   attendance_adjustments id   date                 before   after
--   1146537 1146539             01.10, 03.10         22.00    11.00
--   1146541 .. 1146543          05-07.10             22.00    11.00
--   1146545 1146546 1146547     09.10, 10.10, 12.10  22.00    11.00
--   1146549 .. 1146552          14-17.10             22.00    11.00
--   1146538 1146544             02.10, 08.10         20.00    10.00
--   1146540                     04.10 (day off)      12.00     6.00
--   1146553                     18.10 (day off)      10.00     5.00
--   1146548                     13.10                11.00    11.00  NOT touched: in FOT that day
--                                                                    was an absence, not doubled
--   total 01-18.10                                   337 h    174 h
--
-- Same row, same object, same comment (reason) and author (none): only hours_override and
-- updated_at change. metadata.zup_align stays; metadata.hours_half_fix keeps the previous hours
-- and updated_at for the rollback. One audit_logs row per changed day (UPDATE_TIMESHEET_ENTRY).
-- Days from 19.10 on are not touched.
--
-- No approval covers him in October (checked below), so nothing to rebuild.
-- Any difference from the expected state raises STOP and nothing is applied.
-- A second run stops with "already applied".
--
-- Run in interactive psql (see DEPLOY.md for DATABASE_URL and PGSSLROOTCERT):
--   psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL"
--   \i ~/mustafaev_1218_zup_hours_half_2026-10.sql
-- Compare the output with the \echo text at the end, then type one of:
--   COMMIT;
--   ROLLBACK;
-- Rows stay locked until then, so do not leave the session open
-- (idle_in_transaction_session_timeout rolls it back after 3 minutes).
--
-- Undo after COMMIT:
--   docs/rollbacks/mustafaev_1218_zup_hours_half_2026-10_rollback.sql

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL idle_in_transaction_session_timeout = '3min';

DO $fix$
DECLARE
  c_employee CONSTANT integer := 1218;
  c_object   CONSTANT text := '484ff35d-6518-472d-ad6d-e2cb6cb1c4ce';
  c_run      CONSTANT text := '6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a';
  c_fix      CONSTANT text := 'mustafaev_1218_zup_hours_half_2026-10';
  -- 16 days to halve; 1146548 (13.10) is deliberately not in the list.
  c_ids      CONSTANT bigint[] := ARRAY[1146537, 1146538, 1146539, 1146540, 1146541, 1146542,
                                        1146543, 1146544, 1146545, 1146546, 1146547, 1146549,
                                        1146550, 1146551, 1146552, 1146553];
  -- 'ZUP' in Cyrillic, as UTF-8 bytes (the file stays ASCII).
  c_reason   CONSTANT text := convert_from('\xd097d0a3d09f'::bytea, 'UTF8');
  v_actual   text;
  v_count    integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM employees
     WHERE id = c_employee AND tab_number = '05183' AND sigur_employee_id = 137745
  ) THEN
    RAISE EXCEPTION 'STOP: employee 1218 (tab 05183) not found';
  END IF;

  PERFORM 1 FROM attendance_adjustments
   WHERE employee_id = c_employee
     AND work_date BETWEEN DATE '2026-10-01' AND DATE '2026-10-18'
   ORDER BY id
     FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM attendance_adjustments
     WHERE employee_id = c_employee
       AND work_date BETWEEN DATE '2026-10-01' AND DATE '2026-10-18'
       AND metadata ? 'hours_half_fix'
  ) THEN
    RAISE EXCEPTION 'STOP: already applied (metadata.hours_half_fix is present), nothing to do';
  END IF;

  -- Preconditions: exactly these 17 rows on 01-18.10 (none on 11.10), one per day, as written
  -- by run 6ec1adb4.
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
     AND work_date BETWEEN DATE '2026-10-01' AND DATE '2026-10-18';
  IF v_actual IS DISTINCT FROM concat_ws(E'\n',
    '1146537 2026-10-01 manual manual_object 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 22.00 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a auto_approved nobody true 2026-11-13T14:27:20.465000Z',
    '1146538 2026-10-02 manual manual_object 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 20.00 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a auto_approved nobody true 2026-11-13T14:27:20.489000Z',
    '1146539 2026-10-03 manual manual_object 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 22.00 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a auto_approved nobody true 2026-11-13T14:27:20.507000Z',
    '1146540 2026-10-04 manual manual_object 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 12.00 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a auto_approved nobody true 2026-11-13T14:27:20.532000Z',
    '1146541 2026-10-05 manual manual_object 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 22.00 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a auto_approved nobody true 2026-11-13T14:27:20.551000Z',
    '1146542 2026-10-06 manual manual_object 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 22.00 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a auto_approved nobody true 2026-11-13T14:27:20.569000Z',
    '1146543 2026-10-07 manual manual_object 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 22.00 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a auto_approved nobody true 2026-11-13T14:27:20.586000Z',
    '1146544 2026-10-08 manual manual_object 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 20.00 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a auto_approved nobody true 2026-11-13T14:27:20.610000Z',
    '1146545 2026-10-09 manual manual_object 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 22.00 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a auto_approved nobody true 2026-11-13T14:27:20.628000Z',
    '1146546 2026-10-10 manual manual_object 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 22.00 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a auto_approved nobody true 2026-11-13T14:27:20.646000Z',
    '1146547 2026-10-12 manual manual_object 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 22.00 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a auto_approved nobody true 2026-11-13T14:27:20.670000Z',
    '1146548 2026-10-13 manual manual manual 11.00 - 6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a auto_approved nobody true 2026-11-13T14:27:20.687000Z',
    '1146549 2026-10-14 manual manual_object 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 22.00 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a auto_approved nobody true 2026-11-13T14:27:20.715000Z',
    '1146550 2026-10-15 manual manual_object 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 22.00 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a auto_approved nobody true 2026-11-13T14:27:20.733000Z',
    '1146551 2026-10-16 manual manual_object 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 22.00 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a auto_approved nobody true 2026-11-13T14:27:20.750000Z',
    '1146552 2026-10-17 manual manual_object 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 22.00 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a auto_approved nobody true 2026-11-13T14:27:20.768000Z',
    '1146553 2026-10-18 manual manual_object 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 10.00 484ff35d-6518-472d-ad6d-e2cb6cb1c4ce 6ec1adb4-32c5-4c19-b78e-c0ebdd3e272a auto_approved nobody true 2026-11-13T14:27:20.792000Z'
  ) THEN
    RAISE EXCEPTION 'STOP: days 01-18.10 differ from expected:%', E'\n' || COALESCE(v_actual, '(none)');
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
           'hours_after', CASE a.hours_override WHEN 22 THEN 11 WHEN 20 THEN 10 WHEN 12 THEN 6 WHEN 10 THEN 5 END,
           'zup_run_id', c_run,
           'note', '1C (ZUP) hours were twice the FOT hours: halved')
    FROM attendance_adjustments a
   WHERE a.id = ANY(c_ids);

  UPDATE attendance_adjustments a
     SET hours_override = CASE a.hours_override WHEN 22 THEN 11 WHEN 20 THEN 10 WHEN 12 THEN 6 WHEN 10 THEN 5 END,
         updated_at = now(),
         metadata = a.metadata || jsonb_build_object('hours_half_fix', jsonb_build_object(
           'fix', c_fix,
           'prev_hours', a.hours_override,
           'prev_updated_at', to_char(a.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           'note', '1C (ZUP) hours were twice the FOT hours: halved',
           'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
   WHERE a.id = ANY(c_ids)
     AND a.employee_id = c_employee
     AND a.hours_override IN (22, 20, 12, 10);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 16 THEN
    RAISE EXCEPTION 'STOP: updated % rows, expected 16', v_count;
  END IF;

  -- Postconditions (13.10 stays 11.00 and unmarked)
  SELECT string_agg(to_char(work_date, 'DD') || ' ' || hours_override::text
                    || CASE WHEN metadata ? 'hours_half_fix' THEN '' ELSE ' -' END,
                    ', ' ORDER BY work_date)
    INTO v_actual
    FROM attendance_adjustments
   WHERE employee_id = c_employee
     AND work_date BETWEEN DATE '2026-10-01' AND DATE '2026-10-18';
  IF v_actual IS DISTINCT FROM
     '01 11.00, 02 10.00, 03 11.00, 04 6.00, 05 11.00, 06 11.00, 07 11.00, 08 10.00, 09 11.00, '
     || '10 11.00, 12 11.00, 13 11.00 -, 14 11.00, 15 11.00, 16 11.00, 17 11.00, 18 5.00' THEN
    RAISE EXCEPTION 'STOP: unexpected result: %', v_actual;
  END IF;
END
$fix$;

SELECT a.id, a.work_date, a.hours_override,
       a.metadata->'hours_half_fix'->>'prev_hours' AS prev_hours,
       COALESCE(a.metadata->>'object_name', '-') AS object
  FROM attendance_adjustments a
 WHERE a.employee_id = 1218
   AND a.work_date BETWEEN DATE '2026-10-01' AND DATE '2026-10-18'
 ORDER BY a.work_date;

SELECT sum(hours_override) AS total_hours_01_18
  FROM attendance_adjustments
 WHERE employee_id = 1218
   AND work_date BETWEEN DATE '2026-10-01' AND DATE '2026-10-18';

\echo
\echo 'Expected: 17 rows 01-18.10 (no 11.10). Hours 11.00, except 10.00 on 02 and 08.10,'
\echo '6.00 on 04.10, 5.00 on 18.10; 13.10 = 11.00 with empty prev_hours (not changed);'
\echo 'total_hours_01_18 = 174.00.'
\echo 'If so, type COMMIT;   otherwise ROLLBACK;'
