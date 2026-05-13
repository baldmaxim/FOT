-- 091_manager_obj_restrictions.sql
-- Ограничения для роли manager_obj («Руководитель (строительство)»):
--   1. Новый флаг system_roles.hide_sidebar — полностью скрывает боковое меню.
--   2. Дефолты role_page_access для manager_obj:
--      • /employees                — нет доступа (карточка сотрудника со СКУД-проходами заблокирована)
--      • /timesheet/events         — нет доступа (таб «События СКУД» в модалке клика по дню табеля скрыт)
--      • /staff-control/department — view (показ есть, edit запрещён → кнопка смены отдела скрыта)
--      • /staff-control/position   — view (то же для смены должности)
--      • /staff-control/schedule   — view (то же для смены графика)
--
-- Семантика «view, без edit» удобна: страница `/staff-control` остаётся доступна
-- для просмотра, но конкретные операции запрещены и на фронте, и на бэке.
--
-- Сам каталог page_access регистрируется через DEFAULT_ACCESS_PAGE_CATALOG
-- в fot-server/src/config/access-control.ts — таблицы access_pages нет.

BEGIN;

-- 1) Флаг скрытия Sidebar
ALTER TABLE system_roles
  ADD COLUMN IF NOT EXISTS hide_sidebar BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN system_roles.hide_sidebar IS
  'true → у пользователей роли полностью скрывается боковое меню (Sidebar). Для is_admin игнорируется.';

-- 2) Включаем флаг для manager_obj
UPDATE system_roles
   SET hide_sidebar = true,
       updated_at   = NOW()
 WHERE code = 'manager_obj';

-- 3) Дефолты доступов
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
VALUES
  ('manager_obj', '/staff-control/department', true, false),
  ('manager_obj', '/staff-control/position',   true, false),
  ('manager_obj', '/staff-control/schedule',   true, false)
ON CONFLICT (role_code, page_path) DO UPDATE
  SET can_view = EXCLUDED.can_view,
      can_edit = EXCLUDED.can_edit;

-- Гарантируем отсутствие доступа к карточке сотрудника и табу СКУД.
DELETE FROM role_page_access
 WHERE role_code = 'manager_obj'
   AND page_path IN ('/employees', '/timesheet/events');

-- 4) Автогрант /employees view ВСЕМ ролям, у которых уже есть /staff-control view,
--    КРОМЕ manager_obj. Это сохраняет привычное поведение (admin/manager/header
--    могут открывать карточку сотрудника /employees/:id) после переключения
--    бэк-роута GET /api/employees/:id на проверку '/employees'.
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
SELECT role_code, '/employees', true, false
  FROM role_page_access
 WHERE page_path = '/staff-control'
   AND can_view = true
   AND role_code <> 'manager_obj'
ON CONFLICT (role_code, page_path) DO NOTHING;

-- 5) Автогрант edit-доступа на под-ключи /staff-control/{department,position,schedule}
--    для всех ролей, у которых уже есть /staff-control edit, КРОМЕ manager_obj.
--    Бэк-роуты move-department, batch-move, change-position и schedule employee
--    переключены на эти под-ключи (см. employees.routes.ts, schedule.routes.ts).
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
SELECT role_code, sub.page_path, true, true
  FROM role_page_access
 CROSS JOIN (VALUES
   ('/staff-control/department'),
   ('/staff-control/position'),
   ('/staff-control/schedule')
 ) AS sub(page_path)
 WHERE role_page_access.page_path = '/staff-control'
   AND role_page_access.can_edit = true
   AND role_page_access.role_code <> 'manager_obj'
ON CONFLICT (role_code, page_path) DO NOTHING;

COMMIT;
