-- 021_timesheet_half_month_reminders.sql
-- Полумесячные периоды табеля, ответственные по отделам и журнал напоминаний.

CREATE TABLE IF NOT EXISTS timesheet_responsibles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id UUID NOT NULL REFERENCES org_departments(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('primary', 'backup')),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(department_id, role)
);

CREATE INDEX IF NOT EXISTS idx_timesheet_responsibles_user
  ON timesheet_responsibles (user_id, is_active);

CREATE TABLE IF NOT EXISTS timesheet_reminder_log (
  id            BIGSERIAL PRIMARY KEY,
  department_id UUID NOT NULL REFERENCES org_departments(id) ON DELETE CASCADE,
  period        TEXT NOT NULL,
  user_id       UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  stage         TEXT NOT NULL,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(department_id, period, user_id, stage)
);

CREATE INDEX IF NOT EXISTS idx_timesheet_reminder_log_period
  ON timesheet_reminder_log (period, stage);

CREATE INDEX IF NOT EXISTS idx_timesheet_approvals_period_status
  ON timesheet_approvals (period, status);
