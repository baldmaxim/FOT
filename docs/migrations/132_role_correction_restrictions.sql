-- 132_role_correction_restrictions.sql
--
-- Блок настраиваемых флагов «Ограничения корректировок табеля» в system_roles.
-- Каждый флаг включается/выключается для любой роли независимо — поведение
-- проверяется по полям роли, а не по её коду. Дефолты — выключенные, чтобы
-- существующие роли (manager, manager_obj, admin, …) работали как прежде.
--
-- Поля:
--   * corrections_anomalies_only — корректировка hours > 0 разрешена только
--     в дни-аномалии СКУД (см. функцию is_skud_anomalous_day, миграция 134).
--   * corrections_cap_by_schedule_norm — hours_override не может превысить
--     плановые часы дня (см. getDayNormHours в schedule.service.ts).
--   * corrections_allow_zero_short_attendance — дополнительно разрешает
--     hours_override = 0, если день рабочий по графику и факт по СКУД
--     0 ≤ total_minutes < 240 (явка < 4 ч).
--   * corrections_disable_bulk — запрещает POST /api/timesheet/bulk.
--   * max_corrections_per_month — лимит «корректировок аномалий» (hours > 0)
--     per (created_by, employee_id, календарный месяц). NULL = безлимит.
--
-- Дополнительно — частичный индекс под подсчёт лимита.

BEGIN;

ALTER TABLE public.system_roles
  ADD COLUMN IF NOT EXISTS corrections_anomalies_only BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS corrections_cap_by_schedule_norm BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS corrections_allow_zero_short_attendance BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS corrections_disable_bulk BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS max_corrections_per_month INTEGER NULL;

ALTER TABLE public.system_roles
  DROP CONSTRAINT IF EXISTS chk_max_corrections_non_negative;

ALTER TABLE public.system_roles
  ADD CONSTRAINT chk_max_corrections_non_negative
  CHECK (max_corrections_per_month IS NULL OR max_corrections_per_month >= 0);

COMMENT ON COLUMN public.system_roles.corrections_anomalies_only IS
  'true → корректировка hours > 0 разрешена только в дни-аномалии СКУД (orphan exit, открытый entry, skud_event_failures, пропуск скана при рабочем дне).';
COMMENT ON COLUMN public.system_roles.corrections_cap_by_schedule_norm IS
  'true → hours_override не может превысить плановые часы дня (getDayNormHours).';
COMMENT ON COLUMN public.system_roles.corrections_allow_zero_short_attendance IS
  'Имеет смысл при corrections_anomalies_only=true. true → разрешает hours_override=0, если день рабочий по графику и факт по СКУД 0 ≤ total_minutes < 240.';
COMMENT ON COLUMN public.system_roles.corrections_disable_bulk IS
  'true → роль не может вызывать POST /api/timesheet/bulk.';
COMMENT ON COLUMN public.system_roles.max_corrections_per_month IS
  'Лимит корректировок-аномалий (hours>0) per (created_by, employee_id, календарный месяц). NULL = безлимит. Применяется при corrections_anomalies_only=true.';

CREATE INDEX IF NOT EXISTS idx_attendance_adjustments_anomaly_quota
  ON public.attendance_adjustments (created_by, employee_id, work_date)
  WHERE approval_status IN ('pending','approved','auto_approved')
    AND hours_override > 0;

NOTIFY pgrst, 'reload schema';

COMMIT;
