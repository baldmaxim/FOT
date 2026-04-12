-- Summary preflight for 020_attendance_access_refactor.sql
-- Safe to run before migration 020.
-- Returns one result set with counts for each blocking/non-blocking check.

CREATE TEMP TABLE IF NOT EXISTS preflight_020_summary (
  check_name TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  problem_rows BIGINT,
  note TEXT NOT NULL
) ON COMMIT DROP;

TRUNCATE preflight_020_summary;

INSERT INTO preflight_020_summary (check_name, category, severity, problem_rows, note)
SELECT
  'skud_daily_summary duplicates',
  'duplicates',
  'blocker',
  COUNT(*),
  'Must be 0 before creating unique index on (employee_id, date)'
FROM (
  SELECT employee_id, date
  FROM skud_daily_summary
  GROUP BY employee_id, date
  HAVING COUNT(*) > 1
) t;

INSERT INTO preflight_020_summary (check_name, category, severity, problem_rows, note)
SELECT
  'payslips duplicates',
  'duplicates',
  'blocker',
  COUNT(*),
  'Must be 0 before creating unique index on (employee_id, period)'
FROM (
  SELECT employee_id, period
  FROM payslips
  GROUP BY employee_id, period
  HAVING COUNT(*) > 1
) t;

INSERT INTO preflight_020_summary (check_name, category, severity, problem_rows, note)
SELECT
  'role_page_access duplicates by system role target',
  'duplicates',
  'blocker',
  COUNT(*),
  'Must be 0 before creating unique index on (system_role_id, page_path)'
FROM (
  SELECT sr.id, rpa.page_path
  FROM role_page_access rpa
  JOIN system_roles sr ON sr.code = rpa.role_code
  GROUP BY sr.id, rpa.page_path
  HAVING COUNT(*) > 1
) t;

INSERT INTO preflight_020_summary (check_name, category, severity, problem_rows, note)
SELECT
  'user_profiles without matching system role',
  'role-mapping',
  'blocker',
  COUNT(*),
  'Every user_profiles.position_type must map to system_roles.code'
FROM user_profiles up
LEFT JOIN system_roles sr ON sr.code = up.position_type
WHERE up.position_type IS NOT NULL
  AND sr.id IS NULL;

INSERT INTO preflight_020_summary (check_name, category, severity, problem_rows, note)
SELECT
  'role_page_access without matching system role',
  'role-mapping',
  'blocker',
  COUNT(*),
  'Every role_page_access.role_code must map to system_roles.code'
FROM role_page_access rpa
LEFT JOIN system_roles sr ON sr.code = rpa.role_code
WHERE rpa.role_code IS NOT NULL
  AND sr.id IS NULL;

INSERT INTO preflight_020_summary (check_name, category, severity, problem_rows, note)
SELECT
  'employee_assignments overlap',
  'period-overlap',
  'blocker',
  COUNT(*),
  'Must be 0 before enabling no-overlap trigger'
FROM (
  SELECT 1
  FROM employee_assignments a
  JOIN employee_assignments b
    ON a.employee_id = b.employee_id
   AND a.id <> b.id
   AND daterange(a.effective_from, COALESCE(a.effective_to, 'infinity'::date), '[]')
       && daterange(b.effective_from, COALESCE(b.effective_to, 'infinity'::date), '[]')
   AND a.effective_from <= b.effective_from
) t;

INSERT INTO preflight_020_summary (check_name, category, severity, problem_rows, note)
SELECT
  'employee_schedule_assignments overlap',
  'period-overlap',
  'blocker',
  COUNT(*),
  'Must be 0 before enabling no-overlap trigger'
FROM (
  SELECT 1
  FROM employee_schedule_assignments a
  JOIN employee_schedule_assignments b
    ON a.employee_id = b.employee_id
   AND a.id <> b.id
   AND daterange(a.effective_from, COALESCE(a.effective_to, 'infinity'::date), '[]')
       && daterange(b.effective_from, COALESCE(b.effective_to, 'infinity'::date), '[]')
   AND a.effective_from <= b.effective_from
) t;

INSERT INTO preflight_020_summary (check_name, category, severity, problem_rows, note)
SELECT
  'category_schedules overlap',
  'period-overlap',
  'blocker',
  COUNT(*),
  'Must be 0 before enabling no-overlap trigger'
FROM (
  SELECT 1
  FROM category_schedules a
  JOIN category_schedules b
    ON a.category = b.category
   AND a.id <> b.id
   AND daterange(a.effective_from, COALESCE(a.effective_to, 'infinity'::date), '[]')
       && daterange(b.effective_from, COALESCE(b.effective_to, 'infinity'::date), '[]')
   AND a.effective_from <= b.effective_from
) t;

INSERT INTO preflight_020_summary (check_name, category, severity, problem_rows, note)
SELECT
  'tender_timesheet rows to backfill',
  'legacy-data',
  'info',
  COUNT(*),
  'Not a blocker by itself; migration 020 will backfill these rows into attendance_adjustments'
FROM tender_timesheet;

INSERT INTO preflight_020_summary (check_name, category, severity, problem_rows, note)
SELECT
  'skud_access_point_settings has organization_id',
  'legacy-schema',
  'info',
  COUNT(*),
  '1 means the legacy column still exists and migration 020 should remove it'
FROM information_schema.columns
WHERE table_name = 'skud_access_point_settings'
  AND column_name = 'organization_id';

INSERT INTO preflight_020_summary (check_name, category, severity, problem_rows, note)
SELECT
  'skud_sync_employee_filter has organization_id',
  'legacy-schema',
  'info',
  COUNT(*),
  '1 means the legacy column still exists and migration 020 should remove it'
FROM information_schema.columns
WHERE table_name = 'skud_sync_employee_filter'
  AND column_name = 'organization_id';

INSERT INTO preflight_020_summary (check_name, category, severity, problem_rows, note)
SELECT
  'attendance_adjustments already exists',
  'migration-state',
  CASE WHEN COUNT(*) > 0 THEN 'warning' ELSE 'info' END,
  COUNT(*),
  'If 1, migration 020 may have been applied fully or partially already'
FROM information_schema.tables
WHERE table_name = 'attendance_adjustments';

INSERT INTO preflight_020_summary (check_name, category, severity, problem_rows, note)
SELECT
  'employee_history is a view',
  'schema-compat',
  'info',
  COUNT(*),
  '1 means employee_history is a VIEW; migration 020 will now skip table-specific alterations for it'
FROM information_schema.views
WHERE table_name = 'employee_history';

INSERT INTO preflight_020_summary (check_name, category, severity, problem_rows, note)
SELECT
  'skud_events has event_at column',
  'migration-state',
  'info',
  COUNT(*),
  '0 before migration is normal; 1 means event_at already exists'
FROM information_schema.columns
WHERE table_name = 'skud_events'
  AND column_name = 'event_at';

DO $$
DECLARE
  v_event_at_exists BOOLEAN;
  v_problem_rows BIGINT;
  v_note TEXT;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'skud_events'
      AND column_name = 'event_at'
  )
  INTO v_event_at_exists;

  IF v_event_at_exists THEN
    SELECT COUNT(*)
    INTO v_problem_rows
    FROM skud_events
    WHERE event_at IS NULL
      AND (event_date IS NULL OR event_time IS NULL);

    v_note := 'Must be 0 before relying on event_at backfill completeness';
  ELSE
    v_problem_rows := NULL;
    v_note := 'Skipped because event_at does not exist yet; this is normal before migration 020';
  END IF;

  INSERT INTO preflight_020_summary (check_name, category, severity, problem_rows, note)
  VALUES (
    'skud_events rows missing event_date/time for event_at backfill',
    'sanity',
    CASE WHEN v_problem_rows IS NULL THEN 'skipped' ELSE 'blocker' END,
    v_problem_rows,
    v_note
  );
END $$;

SELECT
  check_name,
  category,
  severity,
  problem_rows,
  note
FROM preflight_020_summary
ORDER BY
  CASE severity
    WHEN 'blocker' THEN 1
    WHEN 'warning' THEN 2
    WHEN 'info' THEN 3
    WHEN 'skipped' THEN 4
    ELSE 5
  END,
  check_name;
