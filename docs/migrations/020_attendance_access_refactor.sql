-- Migration: attendance_access_refactor
-- Цели:
-- 1. Ввести каноническую таблицу attendance_adjustments вместо legacy timesheet/tender_timesheet-путаницы
-- 2. Подготовить access-control к system_role_id как каноническому ключу
-- 3. Убрать оставшиеся single-org хвосты
-- 4. Добавить supporting-поля для производительности и консистентности

BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 1. Supporting columns for SKUD aggregation
ALTER TABLE skud_events
  ADD COLUMN IF NOT EXISTS event_at TIMESTAMPTZ;

UPDATE skud_events
SET event_at = ((event_date::text || ' ' || event_time::text)::timestamp AT TIME ZONE 'Europe/Moscow')
WHERE event_at IS NULL
  AND event_date IS NOT NULL
  AND event_time IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_skud_events_event_at
  ON skud_events (event_at);

CREATE INDEX IF NOT EXISTS idx_skud_events_employee_event_at
  ON skud_events (employee_id, event_at);

ALTER TABLE skud_daily_summary
  ADD COLUMN IF NOT EXISTS total_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS break_minutes INTEGER;

UPDATE skud_daily_summary
SET total_minutes = COALESCE(total_minutes, ROUND(COALESCE(total_hours, 0) * 60)::INTEGER),
    break_minutes = COALESCE(break_minutes, ROUND(COALESCE(break_hours, 0) * 60)::INTEGER)
WHERE total_minutes IS NULL
   OR break_minutes IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_skud_daily_summary_total_minutes_non_negative'
  ) THEN
    ALTER TABLE skud_daily_summary
      ADD CONSTRAINT chk_skud_daily_summary_total_minutes_non_negative
      CHECK (total_minutes IS NULL OR total_minutes >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_skud_daily_summary_break_minutes_non_negative'
  ) THEN
    ALTER TABLE skud_daily_summary
      ADD CONSTRAINT chk_skud_daily_summary_break_minutes_non_negative
      CHECK (break_minutes IS NULL OR break_minutes >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM (
      SELECT employee_id, date, COUNT(*) AS cnt
      FROM skud_daily_summary
      GROUP BY employee_id, date
      HAVING COUNT(*) > 1
    ) duplicates
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS uq_skud_daily_summary_employee_date
             ON skud_daily_summary (employee_id, date)';
  ELSE
    RAISE NOTICE 'Skipped uq_skud_daily_summary_employee_date due to existing duplicates';
  END IF;
END $$;

-- 2. Attendance adjustments: canonical overrides for daily attendance status/hours
CREATE TABLE IF NOT EXISTS attendance_adjustments (
  id BIGSERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'work', 'vacation', 'dayoff', 'remote', 'unpaid', 'absent', 'sick', 'business_trip', 'manual'
  )),
  hours_override NUMERIC(5,2),
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL DEFAULT '',
  reason TEXT,
  created_by UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_adjustments_employee_date_source
  ON attendance_adjustments (employee_id, work_date, source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_attendance_adjustments_employee_date
  ON attendance_adjustments (employee_id, work_date);

CREATE INDEX IF NOT EXISTS idx_attendance_adjustments_source
  ON attendance_adjustments (source_type, source_id);

INSERT INTO attendance_adjustments (
  employee_id,
  work_date,
  status,
  hours_override,
  source_type,
  source_id,
  reason,
  created_at,
  updated_at,
  metadata
)
SELECT
  employee_id,
  work_date,
  status,
  hours_worked,
  'legacy_tender_timesheet',
  id::TEXT,
  CASE
    WHEN is_correction THEN 'Backfilled manual correction from tender_timesheet'
    ELSE 'Backfilled legacy attendance row from tender_timesheet'
  END,
  COALESCE(corrected_at, created_at, updated_at, NOW()),
  COALESCE(updated_at, corrected_at, created_at, NOW()),
  jsonb_strip_nulls(
    jsonb_build_object(
      'legacy_table', 'tender_timesheet',
      'legacy_row_id', id,
      'legacy_corrected_by', corrected_by,
      'legacy_is_correction', is_correction
    )
  )
FROM tender_timesheet
ON CONFLICT (employee_id, work_date, source_type, source_id) DO UPDATE
SET
  status = EXCLUDED.status,
  hours_override = EXCLUDED.hours_override,
  reason = EXCLUDED.reason,
  updated_at = EXCLUDED.updated_at,
  metadata = EXCLUDED.metadata;

-- 3. Role/access canonicalization
ALTER TABLE role_page_access
  ADD COLUMN IF NOT EXISTS system_role_id UUID REFERENCES system_roles(id) ON DELETE CASCADE;

UPDATE role_page_access rpa
SET system_role_id = sr.id
FROM system_roles sr
WHERE rpa.system_role_id IS NULL
  AND rpa.role_code = sr.code;

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS system_role_id UUID REFERENCES system_roles(id) ON DELETE SET NULL;

UPDATE user_profiles up
SET system_role_id = sr.id
FROM system_roles sr
WHERE up.system_role_id IS NULL
  AND up.position_type = sr.code;

CREATE INDEX IF NOT EXISTS idx_user_profiles_system_role_id
  ON user_profiles (system_role_id);

CREATE OR REPLACE FUNCTION sync_user_profile_role_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  resolved_code TEXT;
  resolved_id UUID;
BEGIN
  IF NEW.system_role_id IS NULL AND NEW.position_type IS NULL THEN
    RAISE EXCEPTION 'Either system_role_id or position_type must be provided';
  END IF;

  IF NEW.system_role_id IS NOT NULL THEN
    SELECT code INTO resolved_code
    FROM system_roles
    WHERE id = NEW.system_role_id;

    IF resolved_code IS NULL THEN
      RAISE EXCEPTION 'Unknown system_role_id: %', NEW.system_role_id;
    END IF;

    NEW.position_type := resolved_code;
  ELSE
    SELECT id INTO resolved_id
    FROM system_roles
    WHERE code = NEW.position_type;

    IF resolved_id IS NULL THEN
      RAISE EXCEPTION 'Unknown role code: %', NEW.position_type;
    END IF;

    NEW.system_role_id := resolved_id;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_sync_user_profile_role_fields ON user_profiles;
CREATE TRIGGER trg_sync_user_profile_role_fields
BEFORE INSERT OR UPDATE OF system_role_id, position_type
ON user_profiles
FOR EACH ROW
EXECUTE FUNCTION sync_user_profile_role_fields();

CREATE OR REPLACE FUNCTION sync_role_page_access_role_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  resolved_code TEXT;
  resolved_id UUID;
BEGIN
  IF NEW.system_role_id IS NULL AND NEW.role_code IS NULL THEN
    RAISE EXCEPTION 'Either system_role_id or role_code must be provided';
  END IF;

  IF NEW.system_role_id IS NOT NULL THEN
    SELECT code INTO resolved_code
    FROM system_roles
    WHERE id = NEW.system_role_id;

    IF resolved_code IS NULL THEN
      RAISE EXCEPTION 'Unknown system_role_id for role_page_access: %', NEW.system_role_id;
    END IF;

    NEW.role_code := resolved_code;
  ELSE
    SELECT id INTO resolved_id
    FROM system_roles
    WHERE code = NEW.role_code;

    IF resolved_id IS NULL THEN
      RAISE EXCEPTION 'Unknown role_code for role_page_access: %', NEW.role_code;
    END IF;

    NEW.system_role_id := resolved_id;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_sync_role_page_access_role_fields ON role_page_access;
CREATE TRIGGER trg_sync_role_page_access_role_fields
BEFORE INSERT OR UPDATE OF system_role_id, role_code
ON role_page_access
FOR EACH ROW
EXECUTE FUNCTION sync_role_page_access_role_fields();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM (
      SELECT system_role_id, page_path, COUNT(*) AS cnt
      FROM role_page_access
      WHERE system_role_id IS NOT NULL
      GROUP BY system_role_id, page_path
      HAVING COUNT(*) > 1
    ) duplicates
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS uq_role_page_access_system_role_page
             ON role_page_access (system_role_id, page_path)';
  ELSE
    RAISE NOTICE 'Skipped uq_role_page_access_system_role_page due to existing duplicates';
  END IF;
END $$;

-- 4. New admin page key for payments (copied from existing payslip admin access)
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
SELECT role_code, '/admin/payments', can_view, can_edit
FROM role_page_access
WHERE page_path = '/admin/payslips'
ON CONFLICT (role_code, page_path) DO UPDATE
SET
  can_view = role_page_access.can_view OR EXCLUDED.can_view,
  can_edit = role_page_access.can_edit OR EXCLUDED.can_edit;

-- 5. Legacy single-org cleanup remnants
ALTER TABLE skud_access_point_settings
  DROP COLUMN IF EXISTS organization_id;

ALTER TABLE skud_sync_employee_filter
  DROP COLUMN IF EXISTS organization_id;

-- 6. Documents as file registry: generic linking table
CREATE TABLE IF NOT EXISTS document_links (
  id BIGSERIAL PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  purpose TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, entity_type, entity_id, purpose)
);

CREATE INDEX IF NOT EXISTS idx_document_links_entity
  ON document_links (entity_type, entity_id);

INSERT INTO document_links (document_id, entity_type, entity_id, purpose)
SELECT id, 'leave_request', leave_request_id::TEXT, category
FROM documents
WHERE leave_request_id IS NOT NULL
ON CONFLICT (document_id, entity_type, entity_id, purpose) DO NOTHING;

-- 7. Chat read tracking per participant
ALTER TABLE chat_participants
  ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_chat_participants_last_read_at
  ON chat_participants (conversation_id, user_id, last_read_at);

-- 8. Employee history compatibility
-- In live environments employee_history may be a VIEW over underlying history tables.
-- Only apply table-specific alterations when the relation is a real table.
DO $$
DECLARE
  v_relkind "char";
BEGIN
  SELECT c.relkind
  INTO v_relkind
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'employee_history';

  IF v_relkind IN ('r', 'p') THEN
    EXECUTE 'ALTER TABLE employee_history ADD COLUMN IF NOT EXISTS id BIGSERIAL';

    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'employee_history_pkey'
    ) THEN
      EXECUTE 'ALTER TABLE employee_history ADD CONSTRAINT employee_history_pkey PRIMARY KEY (id)';
    END IF;
  ELSE
    RAISE NOTICE 'Skipped employee_history table alterations because relation kind is %', COALESCE(v_relkind, '?');
  END IF;
END $$;

-- 9. Helpful indexes for hot paths
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM (
      SELECT employee_id, period, COUNT(*) AS cnt
      FROM payslips
      GROUP BY employee_id, period
      HAVING COUNT(*) > 1
    ) duplicates
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS uq_payslips_employee_period
             ON payslips (employee_id, period)';
  ELSE
    RAISE NOTICE 'Skipped uq_payslips_employee_period due to existing duplicates';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_leave_requests_employee_status_start
  ON leave_requests (employee_id, status, start_date);

CREATE INDEX IF NOT EXISTS idx_payments_employee_payment_date
  ON payments (employee_id, payment_date);

CREATE INDEX IF NOT EXISTS idx_salary_history_employee_effective_date_desc
  ON salary_history (employee_id, effective_date DESC);

-- 10. Guard against future overlapping active ranges in assignment-like tables
CREATE OR REPLACE FUNCTION ensure_no_overlapping_employee_assignments()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM employee_assignments existing
    WHERE existing.employee_id = NEW.employee_id
      AND (to_jsonb(existing)->>'id') IS DISTINCT FROM (to_jsonb(NEW)->>'id')
      AND daterange(existing.effective_from, COALESCE(existing.effective_to, 'infinity'::date), '[]')
          && daterange(NEW.effective_from, COALESCE(NEW.effective_to, 'infinity'::date), '[]')
  ) THEN
    RAISE EXCEPTION 'Overlapping employee_assignments period for employee_id=%', NEW.employee_id;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_ensure_no_overlapping_employee_assignments ON employee_assignments;
CREATE TRIGGER trg_ensure_no_overlapping_employee_assignments
BEFORE INSERT OR UPDATE ON employee_assignments
FOR EACH ROW
EXECUTE FUNCTION ensure_no_overlapping_employee_assignments();

CREATE OR REPLACE FUNCTION ensure_no_overlapping_employee_schedule_assignments()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM employee_schedule_assignments existing
    WHERE existing.employee_id = NEW.employee_id
      AND (to_jsonb(existing)->>'id') IS DISTINCT FROM (to_jsonb(NEW)->>'id')
      AND daterange(existing.effective_from, COALESCE(existing.effective_to, 'infinity'::date), '[]')
          && daterange(NEW.effective_from, COALESCE(NEW.effective_to, 'infinity'::date), '[]')
  ) THEN
    RAISE EXCEPTION 'Overlapping employee_schedule_assignments period for employee_id=%', NEW.employee_id;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_ensure_no_overlapping_employee_schedule_assignments ON employee_schedule_assignments;
CREATE TRIGGER trg_ensure_no_overlapping_employee_schedule_assignments
BEFORE INSERT OR UPDATE ON employee_schedule_assignments
FOR EACH ROW
EXECUTE FUNCTION ensure_no_overlapping_employee_schedule_assignments();

CREATE OR REPLACE FUNCTION ensure_no_overlapping_category_schedules()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM category_schedules existing
    WHERE existing.category = NEW.category
      AND (to_jsonb(existing)->>'id') IS DISTINCT FROM (to_jsonb(NEW)->>'id')
      AND daterange(existing.effective_from, COALESCE(existing.effective_to, 'infinity'::date), '[]')
          && daterange(NEW.effective_from, COALESCE(NEW.effective_to, 'infinity'::date), '[]')
  ) THEN
    RAISE EXCEPTION 'Overlapping category_schedules period for category=%', NEW.category;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_ensure_no_overlapping_category_schedules ON category_schedules;
CREATE TRIGGER trg_ensure_no_overlapping_category_schedules
BEFORE INSERT OR UPDATE ON category_schedules
FOR EACH ROW
EXECUTE FUNCTION ensure_no_overlapping_category_schedules();

COMMIT;
