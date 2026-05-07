-- 084_manager_obj_role.sql
-- Фиксация роли manager_obj (Руководитель строительства) в схеме.
--
-- На проде роль уже создана через UI (страница управления ролями), но в репо
-- её нет — а значит на dev/staging/fresh-окружениях её не существует. Эта
-- миграция:
--   1) Идемпотентно вставляет system_roles.code='manager_obj'.
--   2) Копирует право на /timesheet и /timesheet-hr с роли manager — но только
--      если у manager_obj ещё нет НИ ОДНОЙ строки в role_page_access.
--      Это защищает уже сделанные через UI ручные настройки прав на проде.
--
-- Семантика отличия от manager: для manager_obj подача табеля с работой в
-- выходные требует приложить служебную записку (см. weekend-check сервис).

BEGIN;

-- 1) Сама роль (idempotent).
INSERT INTO system_roles (code, name, description, is_admin, employee_variant, show_actual_hours)
VALUES (
  'manager_obj',
  'Руководитель (строительство)',
  'Руководитель строительного объекта. Работа в выходные требует подписанной служебной записки.',
  false,
  'office',
  true
)
ON CONFLICT (code) DO NOTHING;

-- 2) Копируем page_access от manager только если у manager_obj пусто.
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
SELECT 'manager_obj', page_path, can_view, can_edit
FROM role_page_access
WHERE role_code = 'manager'
  AND NOT EXISTS (
    SELECT 1 FROM role_page_access WHERE role_code = 'manager_obj'
  )
ON CONFLICT (role_code, page_path) DO NOTHING;

-- Заставляем PostgREST перечитать схему (на всякий случай — добавления rows не требуют).
NOTIFY pgrst, 'reload schema';

COMMIT;
