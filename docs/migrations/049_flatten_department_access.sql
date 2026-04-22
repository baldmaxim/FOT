-- Migration 049: backfill employee_department_access из employees.org_department_id
--
-- Контекст: удаляем понятие «основной отдел» из UI и логики портала. Все
-- назначенные сотруднику отделы равноправны и живут в employee_department_access.
-- org_department_id остаётся техническим полем (источник: Sigur sync).
--
-- Миграция идемпотентна:
--   - ON CONFLICT DO UPDATE не создаёт дубликатов (UNIQUE по employee_id, department_id);
--   - source не перезаписываем: manual_admin_ui важнее sigur_sync;
--   - только активные сотрудники (уволенные остаются без записей — они скрыты
--     из scope, и при rehire запись добавит employee-lifecycle.controller).

BEGIN;

INSERT INTO public.employee_department_access
  (employee_id, department_id, source, is_active, created_by, created_at, updated_at)
SELECT
  e.id,
  e.org_department_id,
  'sigur_sync',
  TRUE,
  NULL,
  now(),
  now()
FROM public.employees e
WHERE e.org_department_id IS NOT NULL
  AND e.employment_status = 'active'
  AND e.is_archived = FALSE
ON CONFLICT (employee_id, department_id)
DO UPDATE SET
  is_active = TRUE,
  updated_at = now();
-- source у существующих рядов НЕ трогаем (manual_admin_ui не превращаем в sigur_sync).

COMMIT;

-- Санитарный запрос (запустить после миграции; должен вернуть 0):
-- SELECT count(*)
-- FROM public.employees e
-- WHERE e.employment_status = 'active'
--   AND e.is_archived = FALSE
--   AND e.org_department_id IS NOT NULL
--   AND NOT EXISTS (
--     SELECT 1 FROM public.employee_department_access a
--     WHERE a.employee_id = e.id
--       AND a.department_id = e.org_department_id
--       AND a.is_active = TRUE
--   );
