-- Preflight checks for 020_attendance_access_refactor.sql
-- Run this before applying migration 020 on staging / production.
-- Expected result: every query should return 0 problematic rows unless noted otherwise.

-- 1. Duplicates that would block unique indexes
SELECT 'skud_daily_summary duplicates' AS check_name, employee_id, date, COUNT(*) AS duplicates
FROM skud_daily_summary
GROUP BY employee_id, date
HAVING COUNT(*) > 1;

SELECT 'payslips duplicates' AS check_name, employee_id, period, COUNT(*) AS duplicates
FROM payslips
GROUP BY employee_id, period
HAVING COUNT(*) > 1;

SELECT 'role_page_access duplicates by system role target' AS check_name, sr.id AS system_role_id, rpa.page_path, COUNT(*) AS duplicates
FROM role_page_access rpa
JOIN system_roles sr ON sr.code = rpa.role_code
GROUP BY sr.id, rpa.page_path
HAVING COUNT(*) > 1;

-- 2. Rows that cannot be backfilled cleanly to canonical role model
SELECT 'user_profiles without matching system role' AS check_name, up.id, up.position_type
FROM user_profiles up
LEFT JOIN system_roles sr ON sr.code = up.position_type
WHERE up.position_type IS NOT NULL
  AND sr.id IS NULL;

SELECT 'role_page_access without matching system role' AS check_name, rpa.id, rpa.role_code, rpa.page_path
FROM role_page_access rpa
LEFT JOIN system_roles sr ON sr.code = rpa.role_code
WHERE rpa.role_code IS NOT NULL
  AND sr.id IS NULL;

-- 3. Overlapping periods that would be blocked by new triggers
SELECT
  'employee_assignments overlap' AS check_name,
  a.employee_id,
  a.id AS left_id,
  b.id AS right_id,
  a.effective_from AS left_from,
  a.effective_to AS left_to,
  b.effective_from AS right_from,
  b.effective_to AS right_to
FROM employee_assignments a
JOIN employee_assignments b
  ON a.employee_id = b.employee_id
 AND a.id <> b.id
 AND daterange(a.effective_from, COALESCE(a.effective_to, 'infinity'::date), '[]')
     && daterange(b.effective_from, COALESCE(b.effective_to, 'infinity'::date), '[]')
 AND a.effective_from <= b.effective_from;

SELECT
  'employee_schedule_assignments overlap' AS check_name,
  a.employee_id,
  a.id AS left_id,
  b.id AS right_id,
  a.effective_from AS left_from,
  a.effective_to AS left_to,
  b.effective_from AS right_from,
  b.effective_to AS right_to
FROM employee_schedule_assignments a
JOIN employee_schedule_assignments b
  ON a.employee_id = b.employee_id
 AND a.id <> b.id
 AND daterange(a.effective_from, COALESCE(a.effective_to, 'infinity'::date), '[]')
     && daterange(b.effective_from, COALESCE(b.effective_to, 'infinity'::date), '[]')
 AND a.effective_from <= b.effective_from;

SELECT
  'category_schedules overlap' AS check_name,
  a.category,
  a.id AS left_id,
  b.id AS right_id,
  a.effective_from AS left_from,
  a.effective_to AS left_to,
  b.effective_from AS right_from,
  b.effective_to AS right_to
FROM category_schedules a
JOIN category_schedules b
  ON a.category = b.category
 AND a.id <> b.id
 AND daterange(a.effective_from, COALESCE(a.effective_to, 'infinity'::date), '[]')
     && daterange(b.effective_from, COALESCE(b.effective_to, 'infinity'::date), '[]')
 AND a.effective_from <= b.effective_from;

-- 4. Legacy tails that migration 020 will normalize / remove
SELECT 'tender_timesheet rows to backfill' AS check_name, COUNT(*) AS rows_count
FROM tender_timesheet;

SELECT 'skud_access_point_settings has organization_id' AS check_name, COUNT(*) AS rows_count
FROM information_schema.columns
WHERE table_name = 'skud_access_point_settings'
  AND column_name = 'organization_id';

SELECT 'skud_sync_employee_filter has organization_id' AS check_name, COUNT(*) AS rows_count
FROM information_schema.columns
WHERE table_name = 'skud_sync_employee_filter'
  AND column_name = 'organization_id';

-- 5. Useful sanity checks after preflight
SELECT 'attendance_adjustments already exists' AS check_name, COUNT(*) AS rows_count
FROM information_schema.tables
WHERE table_name = 'attendance_adjustments';

SELECT 'employee_history is a view' AS check_name, COUNT(*) AS rows_count
FROM information_schema.views
WHERE table_name = 'employee_history';

SELECT 'skud_events has event_at column' AS check_name, COUNT(*) AS rows_count
FROM information_schema.columns
WHERE table_name = 'skud_events'
  AND column_name = 'event_at';

CREATE TEMP TABLE IF NOT EXISTS preflight_runtime_results (
  check_name TEXT NOT NULL,
  rows_count BIGINT
) ON COMMIT DROP;

DELETE FROM preflight_runtime_results
WHERE check_name = 'skud_events rows missing event_date/time for event_at backfill';

DO $$
DECLARE
  v_rows_count BIGINT;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'skud_events'
      AND column_name = 'event_at'
  ) THEN
    EXECUTE $sql$
      SELECT COUNT(*)
      FROM skud_events
      WHERE event_at IS NULL
        AND (event_date IS NULL OR event_time IS NULL)
    $sql$
    INTO v_rows_count;

    INSERT INTO preflight_runtime_results (check_name, rows_count)
    VALUES ('skud_events rows missing event_date/time for event_at backfill', v_rows_count);
  ELSE
    INSERT INTO preflight_runtime_results (check_name, rows_count)
    VALUES ('skud_events rows missing event_date/time for event_at backfill', NULL);
  END IF;
END $$;

SELECT check_name, rows_count
FROM preflight_runtime_results;
