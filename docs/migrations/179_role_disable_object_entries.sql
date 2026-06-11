-- 179_role_disable_object_entries.sql
--
-- Новый флаг роли «Запретить корректировки по объектам» в наборе
-- «Ограничения корректировок табеля» (см. миграцию 132).
--
-- Вкладка «По объектам» — отдельный путь записи (PUT/DELETE
-- /api/timesheet/object-entry), который минует ограничения роли и согласование
-- (пишет auto_approved). Этот флаг позволяет полностью запретить роли любые
-- объектные корректировки (внесение/изменение/удаление), не затрагивая вкладку
-- «По сотрудникам» (day-level). Проверяется гардом assertObjectCorrectionsAllowed.
--
-- Дефолт false → существующие роли работают как прежде. Включается вручную
-- через админку для нужной роли (изначально — «Начальник участка»).

BEGIN;

ALTER TABLE public.system_roles
  ADD COLUMN IF NOT EXISTS corrections_disable_object_entries BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.system_roles.corrections_disable_object_entries IS
  'true → роль не может вносить/менять/удалять корректировки «По объектам» (PUT/DELETE /api/timesheet/object-entry). Вкладка «По сотрудникам» не затрагивается.';

NOTIFY pgrst, 'reload schema';

COMMIT;
