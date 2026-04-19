-- 044_simplify_roles.sql
-- Радикальное упрощение системы ролей.
--
-- ЧТО ДЕЛАЕТ:
-- 1. Добавляет system_roles.is_admin + system_roles.employee_variant.
-- 2. Переименовывает базовые роли: super_admin → admin, header → manager,
--    worker_office → office, worker_object → worker. Удаляет устаревшие
--    дубликаты hr и старый admin (hr-юзеров переносит в admin).
-- 3. Удаляет user_profiles.position_type (единый источник роли — system_role_id).
-- 4. Удаляет system_roles.permissions / level / is_system — поведение роли
--    выводится из page_access + is_admin + employee_variant.
-- 5. Удаляет таблицу user_department_access (0 строк, не используется).
-- 6. Гарантирует права manager на /leave-requests и /timesheet-hr (edit).

BEGIN;

-- ────────────────────────────────────────────────────────────────────────
-- 1) Досинхронизация system_role_id для профилей, где он NULL.
-- ────────────────────────────────────────────────────────────────────────
UPDATE user_profiles up
SET system_role_id = sr.id
FROM system_roles sr
WHERE up.system_role_id IS NULL
  AND up.position_type = sr.code;

-- ────────────────────────────────────────────────────────────────────────
-- 2) Новые колонки на system_roles.
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE system_roles
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS employee_variant TEXT
    CHECK (employee_variant IN ('object','office'));

-- Заполнение is_admin: роль сейчас считается админской, если у неё либо code
-- 'super_admin'/'admin', либо permissions включают data.scope.all + timesheet.workflow.review.
UPDATE system_roles
SET is_admin = true
WHERE code IN ('super_admin', 'admin');

-- employee_variant из старых permissions
UPDATE system_roles
SET employee_variant = 'office'
WHERE (permissions)::jsonb @> '["portal.employee.variant.office"]'::jsonb;

UPDATE system_roles
SET employee_variant = 'object'
WHERE (permissions)::jsonb @> '["portal.employee.variant.object"]'::jsonb;

-- ────────────────────────────────────────────────────────────────────────
-- 3) Убираем дубликаты ролей.
--    Старый admin (0 юзеров) — удаляем. hr (1 юзер) — переносим в super_admin.
-- ────────────────────────────────────────────────────────────────────────

-- 3a) Старый admin: удаляем его page_access и саму роль.
DELETE FROM role_page_access WHERE role_code = 'admin';
DELETE FROM system_roles   WHERE code = 'admin';

-- 3b) hr: юзеры переходят в super_admin (который станет новым admin).
UPDATE user_profiles
SET system_role_id = (SELECT id FROM system_roles WHERE code = 'super_admin'),
    position_type  = 'super_admin'
WHERE position_type = 'hr';

DELETE FROM role_page_access WHERE role_code = 'hr';
DELETE FROM system_roles   WHERE code = 'hr';

-- ────────────────────────────────────────────────────────────────────────
-- 4) Переименование ролей.
--    super_admin → admin, header → manager, worker_office → office,
--    worker_object → worker.
--    FK role_page_access.role_code и fk_position_type ссылаются на
--    system_roles.code — снимаем, обновляем, ставим обратно.
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE role_page_access DROP CONSTRAINT role_page_access_role_code_fkey;
ALTER TABLE user_profiles   DROP CONSTRAINT IF EXISTS fk_position_type;

UPDATE system_roles     SET code = 'admin'   WHERE code = 'super_admin';
UPDATE role_page_access SET role_code = 'admin'   WHERE role_code = 'super_admin';

UPDATE system_roles     SET code = 'manager' WHERE code = 'header';
UPDATE role_page_access SET role_code = 'manager' WHERE role_code = 'header';

UPDATE system_roles     SET code = 'office'  WHERE code = 'worker_office';
UPDATE role_page_access SET role_code = 'office'  WHERE role_code = 'worker_office';

UPDATE system_roles     SET code = 'worker'  WHERE code = 'worker_object';
UPDATE role_page_access SET role_code = 'worker'  WHERE role_code = 'worker_object';

ALTER TABLE role_page_access
  ADD CONSTRAINT role_page_access_role_code_fkey
  FOREIGN KEY (role_code) REFERENCES system_roles(code) ON UPDATE CASCADE;

-- 4a) user_profiles.position_type приводим к новым кодам, чтобы FK fk_position_type не падал.
UPDATE user_profiles SET position_type = 'admin'   WHERE position_type = 'super_admin';
UPDATE user_profiles SET position_type = 'manager' WHERE position_type = 'header';
UPDATE user_profiles SET position_type = 'office'  WHERE position_type = 'worker_office';
UPDATE user_profiles SET position_type = 'worker'  WHERE position_type = 'worker_object';

-- 4b) Обновляем человекочитаемые имена.
UPDATE system_roles SET name = 'Администратор',    description = 'Доступ ко всем данным и страницам'                             WHERE code = 'admin';
UPDATE system_roles SET name = 'Руководитель',     description = 'Доступ к назначенным отделам, согласование табеля и заявлений' WHERE code = 'manager';
UPDATE system_roles SET name = 'Офисный сотрудник',description = 'Полный личный кабинет'                                          WHERE code = 'office';
UPDATE system_roles SET name = 'Рабочий',          description = 'Ограниченный личный кабинет рабочего на объекте'                WHERE code = 'worker';

-- После переименований убеждаемся что флаги выставлены правильно.
UPDATE system_roles SET is_admin = true,  employee_variant = 'office' WHERE code = 'admin';
UPDATE system_roles SET is_admin = false, employee_variant = 'office' WHERE code = 'manager';
UPDATE system_roles SET is_admin = false, employee_variant = 'office' WHERE code = 'office';
UPDATE system_roles SET is_admin = false, employee_variant = 'object' WHERE code = 'worker';

-- ────────────────────────────────────────────────────────────────────────
-- 5) Manager должен иметь edit на /leave-requests и полный доступ к /timesheet-hr
--    (согласование табеля и заявлений).
-- ────────────────────────────────────────────────────────────────────────
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
VALUES
  ('manager', '/leave-requests', true, true),
  ('manager', '/timesheet-hr',   true, true)
ON CONFLICT (role_code, page_path)
DO UPDATE SET can_view = EXCLUDED.can_view, can_edit = EXCLUDED.can_edit;

-- ────────────────────────────────────────────────────────────────────────
-- 6) system_role_id NOT NULL — единственный источник роли.
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE user_profiles
  ALTER COLUMN system_role_id SET NOT NULL;

-- ────────────────────────────────────────────────────────────────────────
-- 7) Удаляем position_type (колонку, триггер синхронизации и функцию).
-- ────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_sync_user_profile_role_fields ON user_profiles;
DROP FUNCTION IF EXISTS sync_user_profile_role_fields();
ALTER TABLE user_profiles DROP COLUMN IF EXISTS position_type;

-- ────────────────────────────────────────────────────────────────────────
-- 8) Удаляем отжившие колонки из system_roles.
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE system_roles
  DROP COLUMN IF EXISTS permissions,
  DROP COLUMN IF EXISTS level,
  DROP COLUMN IF EXISTS is_system;

-- ────────────────────────────────────────────────────────────────────────
-- 9) Удаляем неиспользуемую таблицу user_department_access.
-- ────────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS user_department_access;

-- ────────────────────────────────────────────────────────────────────────
-- 10) Документация.
-- ────────────────────────────────────────────────────────────────────────
COMMENT ON COLUMN system_roles.is_admin IS
  'true — роль видит все данные и обходит фильтр по employee_department_access';
COMMENT ON COLUMN system_roles.employee_variant IS
  'Вариант /employee: object (рабочий на объекте) или office (офисный ЛК)';
COMMENT ON COLUMN user_profiles.system_role_id IS
  'Единственный источник роли; position_type удалён';

COMMIT;
