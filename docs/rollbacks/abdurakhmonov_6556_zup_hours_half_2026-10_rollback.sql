-- Rollback of docs/manual-migrations/abdurakhmonov_6556_zup_hours_half_2026-10.sql.
-- ASCII on purpose. NO COMMIT in this file.
--
-- Returns hours_override (22 / 12) and the previous updated_at of the 10 rows exactly from
-- metadata.hours_half_fix and removes that key: the rows become byte-for-byte what run 6ec1adb4
-- wrote, so its --verify / --revert work again. One audit_logs row per day.
-- Stops if the fix is not applied or the rows were edited after it.
--
-- Run in interactive psql:
--   psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL"
--   \i ~/abdurakhmonov_6556_zup_hours_half_2026-10_rollback.sql
-- Compare the output with the \echo text at the end, then type COMMIT; or ROLLBACK;

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL idle_in_transaction_session_timeout = '3min';

DO $undo$
DECLARE
  c_employee CONSTANT integer := 6556;
  c_fix      CONSTANT text := 'abdurakhmonov_6556_zup_hours_half_2026-10';
  c_ids      CONSTANT bigint[] := ARRAY[1145643, 1145644, 1145645, 1145646, 1145647,
                                        1145648, 1145649, 1145650, 1145651, 1145652];
  v_actual   text;
  v_count    integer;
BEGIN
  PERFORM 1 FROM attendance_adjustments
   WHERE id = ANY(c_ids)
   ORDER BY id
     FOR UPDATE;

  -- Preconditions: the fix is applied and nobody touched the rows since.
  SELECT string_agg(
           id::text || ' ' || work_date::text || ' ' || hours_override::text || ' '
             || COALESCE(metadata->'hours_half_fix'->>'fix', '-') || ' '
             || COALESCE(metadata->'hours_half_fix'->>'prev_hours', '-') || ' '
             || (updated_at = (metadata->'hours_half_fix'->>'at')::timestamptz)::text,
           E'\n' ORDER BY work_date)
    INTO v_actual
    FROM attendance_adjustments
   WHERE id = ANY(c_ids) AND employee_id = c_employee;
  IF v_actual IS DISTINCT FROM concat_ws(E'\n',
    '1145643 2026-10-01 11.00 ' || c_fix || ' 22.00 true',
    '1145644 2026-10-02 11.00 ' || c_fix || ' 22.00 true',
    '1145645 2026-10-03 11.00 ' || c_fix || ' 22.00 true',
    '1145646 2026-10-04 6.00 '  || c_fix || ' 12.00 true',
    '1145647 2026-10-05 11.00 ' || c_fix || ' 22.00 true',
    '1145648 2026-10-06 11.00 ' || c_fix || ' 22.00 true',
    '1145649 2026-10-07 11.00 ' || c_fix || ' 22.00 true',
    '1145650 2026-10-08 11.00 ' || c_fix || ' 22.00 true',
    '1145651 2026-10-09 11.00 ' || c_fix || ' 22.00 true',
    '1145652 2026-10-10 11.00 ' || c_fix || ' 22.00 true'
  ) THEN
    RAISE EXCEPTION 'STOP: rows are not in the state left by the fix:%', E'\n' || COALESCE(v_actual, '(none)');
  END IF;

  INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
  SELECT NULL, 'UPDATE_TIMESHEET_ENTRY', 'timesheet', a.id::text, jsonb_build_object(
           'source', 'manual_sql',
           'fix', c_fix || '_rollback',
           'employee_id', c_employee,
           'work_date', a.work_date::text,
           'hours_before', a.hours_override,
           'hours_after', (a.metadata->'hours_half_fix'->>'prev_hours')::numeric)
    FROM attendance_adjustments a
   WHERE a.id = ANY(c_ids);

  UPDATE attendance_adjustments a
     SET hours_override = (a.metadata->'hours_half_fix'->>'prev_hours')::numeric,
         updated_at = (a.metadata->'hours_half_fix'->>'prev_updated_at')::timestamptz,
         metadata = a.metadata - 'hours_half_fix'
   WHERE a.id = ANY(c_ids)
     AND a.employee_id = c_employee
     AND a.metadata->'hours_half_fix'->>'fix' = c_fix;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 10 THEN
    RAISE EXCEPTION 'STOP: restored % rows, expected 10', v_count;
  END IF;
END
$undo$;

SELECT id, work_date, hours_override,
       to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_utc,
       metadata ? 'hours_half_fix' AS fix_mark
  FROM attendance_adjustments
 WHERE employee_id = 6556
   AND work_date BETWEEN DATE '2026-10-01' AND DATE '2026-10-10'
 ORDER BY work_date;

\echo
\echo 'Expected: 10 rows; 22.00 everywhere except 12.00 on 04.10; updated_at_utc 2026-11-13T14:26:59.*; fix_mark f.'
\echo 'If so, type COMMIT;   otherwise ROLLBACK;'
