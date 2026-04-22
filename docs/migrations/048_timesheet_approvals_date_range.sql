-- 048_timesheet_approvals_date_range.sql
-- Переход с периодов вида "YYYY-MM-H1/H2" на произвольные диапазоны дат (start_date, end_date).
-- Обнуляем историю согласований — пользователь подтвердил, что историю можно стереть.

-- 1. Чистим старые записи. CASCADE уберёт и timesheet_approval_events.
TRUNCATE timesheet_approvals, timesheet_approval_events RESTART IDENTITY CASCADE;

-- 2. timesheet_approvals: убираем уникальность (department_id, period), колонку period и добавляем диапазон.
ALTER TABLE timesheet_approvals
  DROP CONSTRAINT IF EXISTS timesheet_approvals_department_id_period_key;

ALTER TABLE timesheet_approvals
  DROP COLUMN IF EXISTS period;

ALTER TABLE timesheet_approvals
  ADD COLUMN start_date DATE NOT NULL,
  ADD COLUMN end_date   DATE NOT NULL;

ALTER TABLE timesheet_approvals
  ADD CONSTRAINT timesheet_approvals_range_check CHECK (end_date >= start_date);

-- 3. timesheet_approval_events: аналогично period -> start_date/end_date.
ALTER TABLE timesheet_approval_events
  DROP COLUMN IF EXISTS period;

ALTER TABLE timesheet_approval_events
  ADD COLUMN start_date DATE NOT NULL,
  ADD COLUMN end_date   DATE NOT NULL;

DROP INDEX IF EXISTS idx_timesheet_approval_events_period;
CREATE INDEX IF NOT EXISTS idx_timesheet_approval_events_range
  ON timesheet_approval_events (department_id, start_date, end_date, created_at DESC);

-- 4. Запрет пересечений для «живых» согласований одного отдела.
--    Черновики (draft) и отклонённые (rejected) пересекаться могут, так как не блокируют редактирование.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

ALTER TABLE timesheet_approvals
  ADD CONSTRAINT timesheet_approvals_no_overlap
  EXCLUDE USING gist (
    department_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  ) WHERE (status IN ('submitted', 'approved', 'returned'));

CREATE INDEX IF NOT EXISTS idx_timesheet_approvals_dept_range
  ON timesheet_approvals (department_id, start_date, end_date);
