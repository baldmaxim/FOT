-- One-off data fix, not a migration. ASCII on purpose. NO COMMIT in this file.
--
-- "Kompensatsiya arendy" (employee_dormitory_stays, kind = 'apartment'): restore the history broken by the
-- edits of 25.11.2026 (user decisions 25-26.11.2026). NEEDS MIGRATION 380 (column since_on) and the backend
-- of the same commit (it reads since_on as the reference "Nachalo kompensatsii").
--
--   stay  employee                      now (25.11)                       after
--   460   822  Kilichov Sh. R.          2018-09-01 .. 2026-02-19          2026-09-01 .. open (as before 25.11)
--   7     1661 Smirnov E. A.            2024-10-08 .. open                since_on 2024-10-08, calc from 2026-09-01
--   457   60   Abdukhalimov A. Kh. u.   2023-04-19 .. 2026-11-30          since_on 2023-04-19, calc from 2026-11-01, open
--   458   1265 Nasirdinov S. K.         2019-01-31 .. open                since_on 2019-01-31, calc from 2026-11-01
--   75    229  Barabash V. V.           2026-09-01 .. 2026-10-01 paused   2026-09-01 .. 2026-11-01 paused
--
-- Effect on payroll ("Raschety" compute compensation from these rows on the fly, 630 per day):
--   Kilichov  - September-November back as before 25.11 (stays 42/455 were deleted, 460 ended in February);
--   Barabash  - October back (it is paid), compensation paused from 01.11;
--   Abdukhalimov, Nasirdinov - nothing in September-October (not in the October 1C list), from 01.11;
--   Smirnov   - September-November as before 25.11, June-August get nothing (2024 is a reference date only).
-- Comment, amount and docs date are not touched. One audit_logs row per stay (DORMITORY_STAY_UPDATED,
-- details.source = manual_sql). Any difference from the expected state raises STOP and nothing is applied;
-- a second run stops with "differ from the 25.11 state".
--
-- Run in interactive psql (see DEPLOY.md for DATABASE_URL and PGSSLROOTCERT):
--   psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL"
--   \i ~/compensation_history_restore_2026-11-25.sql
-- Compare the output with the \echo text at the end, then type one of:
--   COMMIT;
--   ROLLBACK;
-- Rows stay locked until then, so do not leave the session open
-- (idle_in_transaction_session_timeout rolls it back after 3 minutes).
--
-- Undo after COMMIT:
--   docs/rollbacks/compensation_history_restore_2026-11-25_rollback.sql

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL idle_in_transaction_session_timeout = '3min';

DO $fix$
DECLARE
  c_fix       CONSTANT text := 'compensation_history_restore_2026-11-25';
  c_ids       CONSTANT integer[] := ARRAY[7, 75, 457, 458, 460];
  c_employees CONSTANT integer[] := ARRAY[1661, 229, 60, 1265, 822];
  v_actual    text;
  v_count     integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'employee_dormitory_stays' AND column_name = 'since_on'
  ) THEN
    RAISE EXCEPTION 'STOP: migration 380 is not applied (no column since_on)';
  END IF;

  PERFORM 1 FROM employee_dormitory_stays WHERE employee_id = ANY(c_employees) ORDER BY id FOR UPDATE;

  -- Preconditions: the five stays exactly as the 25.11 edits left them, and nothing else for these people.
  SELECT string_agg(
           id::text || ' ' || employee_id::text || ' ' || kind || ' ' || check_in::text || ' '
             || COALESCE(check_out::text, 'open') || ' ' || suspended::text || ' '
             || COALESCE(resumed_from_id::text, '-') || ' ' || COALESCE(since_on::text, '-'),
           E'\n' ORDER BY id)
    INTO v_actual
    FROM employee_dormitory_stays
   WHERE employee_id = ANY(c_employees);
  IF v_actual IS DISTINCT FROM concat_ws(E'\n',
    '7 1661 apartment 2024-10-08 open false - -',
    '75 229 apartment 2026-09-01 2026-10-01 true - -',
    '457 60 apartment 2023-04-19 2026-11-30 false - -',
    '458 1265 apartment 2019-01-31 open false - -',
    '460 822 apartment 2018-09-01 2026-02-19 false - -'
  ) THEN
    RAISE EXCEPTION 'STOP: stays differ from the 25.11 state (already applied or edited since):%',
      E'\n' || COALESCE(v_actual, '(none)');
  END IF;

  -- One allowance of two (migration 320): no "Doplata za obshchezhitie" in the restored days.
  IF EXISTS (
    SELECT 1 FROM payroll_dormitory_allowances
     WHERE employee_id = ANY(c_employees)
       AND (date_to IS NULL OR date_to >= DATE '2026-09-01')
  ) THEN
    RAISE EXCEPTION 'STOP: dormitory allowance since 01.09.2026 for one of these employees';
  END IF;

  INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
  SELECT NULL, 'DORMITORY_STAY_UPDATED', 'employee_dormitory_stays', s.id::text, jsonb_build_object(
           'source', 'manual_sql',
           'fix', c_fix,
           'note', 'restore compensation history after the 25.11.2026 edits: closed months as paid',
           'from', jsonb_build_object(
             'employee_id', s.employee_id, 'full_name', e.full_name, 'kind', s.kind,
             'check_in', s.check_in::text, 'check_out', s.check_out::text,
             'suspended', s.suspended, 'since_on', s.since_on::text),
           'to', jsonb_build_object(
             'employee_id', s.employee_id, 'full_name', e.full_name, 'kind', s.kind,
             'check_in', t.check_in::text, 'check_out', t.check_out::text,
             'suspended', s.suspended, 'since_on', t.since_on::text))
    FROM employee_dormitory_stays s
    JOIN employees e ON e.id = s.employee_id
    JOIN (VALUES
      (460, DATE '2026-09-01', NULL::date,        NULL::date),
      (7,   DATE '2026-09-01', NULL::date,        DATE '2024-10-08'),
      (457, DATE '2026-11-01', NULL::date,        DATE '2023-04-19'),
      (458, DATE '2026-11-01', NULL::date,        DATE '2019-01-31'),
      (75,  DATE '2026-09-01', DATE '2026-11-01', NULL::date)
    ) AS t(id, check_in, check_out, since_on) ON t.id = s.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 5 THEN
    RAISE EXCEPTION 'STOP: % audit rows, expected 5', v_count;
  END IF;

  UPDATE employee_dormitory_stays
     SET check_in = DATE '2026-09-01', check_out = NULL, since_on = NULL, updated_at = now()
   WHERE id = 460;
  UPDATE employee_dormitory_stays
     SET check_in = DATE '2026-09-01', since_on = DATE '2024-10-08', updated_at = now()
   WHERE id = 7;
  UPDATE employee_dormitory_stays
     SET check_in = DATE '2026-11-01', check_out = NULL, since_on = DATE '2023-04-19', updated_at = now()
   WHERE id = 457;
  UPDATE employee_dormitory_stays
     SET check_in = DATE '2026-11-01', since_on = DATE '2019-01-31', updated_at = now()
   WHERE id = 458;
  UPDATE employee_dormitory_stays
     SET check_out = DATE '2026-11-01', updated_at = now()
   WHERE id = 75;

  -- Postconditions.
  SELECT string_agg(
           id::text || ' ' || check_in::text || ' ' || COALESCE(check_out::text, 'open') || ' '
             || suspended::text || ' ' || COALESCE(since_on::text, '-'),
           E'\n' ORDER BY id)
    INTO v_actual
    FROM employee_dormitory_stays
   WHERE id = ANY(c_ids);
  IF v_actual IS DISTINCT FROM concat_ws(E'\n',
    '7 2026-09-01 open false 2024-10-08',
    '75 2026-09-01 2026-11-01 true -',
    '457 2026-11-01 open false 2023-04-19',
    '458 2026-11-01 open false 2019-01-31',
    '460 2026-09-01 open false -'
  ) THEN
    RAISE EXCEPTION 'STOP: unexpected result:%', E'\n' || v_actual;
  END IF;
END
$fix$;

SELECT s.id, s.employee_id, e.full_name, s.check_in, s.check_out, s.suspended, s.since_on, s.comment
  FROM employee_dormitory_stays s
  JOIN employees e ON e.id = s.employee_id
 WHERE s.id IN (7, 75, 457, 458, 460)
 ORDER BY s.id;

\echo
\echo 'Expected 5 rows:'
\echo '  7   1661 Smirnov       2026-09-01 open        false since_on 2024-10-08'
\echo '  75  229  Barabash      2026-09-01 2026-11-01  true  (paused from 01.11)'
\echo '  457 60   Abdukhalimov  2026-11-01 open        false since_on 2023-04-19'
\echo '  458 1265 Nasirdinov    2026-11-01 open        false since_on 2019-01-31'
\echo '  460 822  Kilichov Sh.  2026-09-01 open        false'
\echo 'Then type COMMIT; or ROLLBACK;'
