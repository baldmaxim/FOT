-- Миграция 077: per-role переключатель «фактические vs урезанные часы».
--
-- Зачем: до этой миграции фронт жёстко выбирал display_hours_worked
-- (часы, обрезанные сверху плановой нормой дня через clampToScheduleHours).
-- Реальные часы по СКУД (hours_worked) всем были скрыты. Суперадмин теперь
-- может на уровне роли включить показ фактических часов — пользователи этой
-- роли увидят hours_worked везде: табель, дашборды, approvals, экспорт 1С/Excel.
-- Дефолт false — поведение для существующих ролей не меняется.

ALTER TABLE system_roles
  ADD COLUMN IF NOT EXISTS show_actual_hours BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN system_roles.show_actual_hours IS
  'true → пользователи роли видят фактические часы по СКУД (hours_worked); false → урезанные по графику (display_hours_worked = min(hours_worked, planned_day_hours)).';
