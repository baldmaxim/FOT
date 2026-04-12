-- Resolve an adjacent overlap in employee_assignments when:
-- old_row.effective_to = new_row.effective_from
-- and both dates are treated as inclusive.
--
-- For migration 020 we keep inclusive semantics, so the old row should end
-- one day before the next row starts.

BEGIN;

UPDATE employee_assignments
SET
  effective_to = (DATE '2025-11-27' - INTERVAL '1 day')::date,
  updated_at = NOW()
WHERE id = '51f07951-fabb-43bb-a56e-738e0eb52ea5'
  AND employee_id = 1331
  AND effective_to = DATE '2025-11-27';

COMMIT;

-- After this, rerun:
-- /Users/odintsovlive/Desktop/Project/008 FOT/docs/migrations/020_attendance_access_refactor_preflight_summary.sql
