-- 169_timesheet_timekeeper_review.sql
-- Отметка табельщицы «Проверено» по табелю бригады за период (диапазон дат).
-- Per (department_id, start_date, end_date) — зеркалит модель timesheet_approvals.
-- Табельщица ставит/снимает отметку; остальные роли видят её read-only.
-- Применяется вручную через psql на проде (авто-миграций нет). Идемпотентно.

BEGIN;

CREATE TABLE IF NOT EXISTS public.timesheet_timekeeper_review (
  id          bigserial PRIMARY KEY,
  department_id uuid NOT NULL REFERENCES public.org_departments(id) ON DELETE CASCADE,
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  checked_by  uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  checked_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT timesheet_timekeeper_review_unique UNIQUE (department_id, start_date, end_date),
  CONSTRAINT timesheet_timekeeper_review_range CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_timesheet_timekeeper_review_dept_range
  ON public.timesheet_timekeeper_review (department_id, start_date, end_date);

NOTIFY pgrst, 'reload schema';

COMMIT;
