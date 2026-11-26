-- Rollback of docs/manual-migrations/compensation_history_restore_2026-11-25.sql.
-- ASCII on purpose. NO COMMIT in this file.
--
-- Returns the five "Kompensatsiya arendy" stays to the state the 25.11.2026 edits left them in
-- (dates, pause, no since_on). One audit_logs row per stay. Stops if the fix is not applied or the stays
-- were edited after it.
--
-- Run in interactive psql:
--   psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL"
--   \i ~/compensation_history_restore_2026-11-25_rollback.sql
-- Compare the output, then type COMMIT; or ROLLBACK;

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL idle_in_transaction_session_timeout = '3min';

DO $undo$
DECLARE
  c_fix       CONSTANT text := 'compensation_history_restore_2026-11-25';
  c_employees CONSTANT integer[] := ARRAY[1661, 229, 60, 1265, 822];
  v_actual    text;
  v_count     integer;
BEGIN
  PERFORM 1 FROM employee_dormitory_stays WHERE employee_id = ANY(c_employees) ORDER BY id FOR UPDATE;

  SELECT string_agg(
           id::text || ' ' || employee_id::text || ' ' || check_in::text || ' '
             || COALESCE(check_out::text, 'open') || ' ' || suspended::text || ' ' || COALESCE(since_on::text, '-'),
           E'\n' ORDER BY id)
    INTO v_actual
    FROM employee_dormitory_stays
   WHERE employee_id = ANY(c_employees);
  IF v_actual IS DISTINCT FROM concat_ws(E'\n',
    '7 1661 2026-09-01 open false 2024-10-08',
    '75 229 2026-09-01 2026-11-01 true -',
    '457 60 2026-11-01 open false 2023-04-19',
    '458 1265 2026-11-01 open false 2019-01-31',
    '460 822 2026-09-01 open false -'
  ) THEN
    RAISE EXCEPTION 'STOP: stays differ from the restored state (not applied or edited since):%',
      E'\n' || COALESCE(v_actual, '(none)');
  END IF;

  INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
  SELECT NULL, 'DORMITORY_STAY_UPDATED', 'employee_dormitory_stays', s.id::text, jsonb_build_object(
           'source', 'manual_sql',
           'fix', c_fix || '_rollback',
           'from', jsonb_build_object('employee_id', s.employee_id, 'full_name', e.full_name, 'kind', s.kind,
             'check_in', s.check_in::text, 'check_out', s.check_out::text, 'suspended', s.suspended,
             'since_on', s.since_on::text),
           'to', jsonb_build_object('employee_id', s.employee_id, 'full_name', e.full_name, 'kind', s.kind,
             'check_in', t.check_in::text, 'check_out', t.check_out::text, 'suspended', s.suspended,
             'since_on', NULL))
    FROM employee_dormitory_stays s
    JOIN employees e ON e.id = s.employee_id
    JOIN (VALUES
      (460, DATE '2018-09-01', DATE '2026-02-19'),
      (7,   DATE '2024-10-08', NULL::date),
      (457, DATE '2023-04-19', DATE '2026-11-30'),
      (458, DATE '2019-01-31', NULL::date),
      (75,  DATE '2026-09-01', DATE '2026-10-01')
    ) AS t(id, check_in, check_out) ON t.id = s.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 5 THEN
    RAISE EXCEPTION 'STOP: % audit rows, expected 5', v_count;
  END IF;

  -- since_on first: CHECK since_on < check_in would fail on the earlier check_in.
  UPDATE employee_dormitory_stays SET since_on = NULL WHERE id IN (7, 457, 458);
  UPDATE employee_dormitory_stays SET check_in = DATE '2018-09-01', check_out = DATE '2026-02-19', updated_at = now() WHERE id = 460;
  UPDATE employee_dormitory_stays SET check_in = DATE '2024-10-08', updated_at = now() WHERE id = 7;
  UPDATE employee_dormitory_stays SET check_in = DATE '2023-04-19', check_out = DATE '2026-11-30', updated_at = now() WHERE id = 457;
  UPDATE employee_dormitory_stays SET check_in = DATE '2019-01-31', updated_at = now() WHERE id = 458;
  UPDATE employee_dormitory_stays SET check_out = DATE '2026-10-01', updated_at = now() WHERE id = 75;
END
$undo$;

SELECT s.id, s.employee_id, e.full_name, s.check_in, s.check_out, s.suspended, s.since_on
  FROM employee_dormitory_stays s
  JOIN employees e ON e.id = s.employee_id
 WHERE s.id IN (7, 75, 457, 458, 460)
 ORDER BY s.id;

\echo
\echo 'Expected: 7 2024-10-08 open; 75 2026-09-01 2026-10-01 paused; 457 2023-04-19 2026-11-30;'
\echo '          458 2019-01-31 open; 460 2018-09-01 2026-02-19; since_on empty. Then COMMIT; or ROLLBACK;'
