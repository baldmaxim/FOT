-- 219_mts_manager_role.sql
-- Роль «Менеджер МТС» — управляет разделом «МТС Бизнес» и больше ничем.
--
-- Не админ (is_admin=false), но с обычным личным кабинетом офисного сотрудника
-- (employee_variant='office'), поэтому лендинг после логина — /employee.
--
-- Страница /mts-business уже есть в access_pages (миграция 197), поэтому каталог
-- не трогаем. Все роуты /api/mts-business/* закрыты requirePageAccess('/mts-business'),
-- так что доступ включается одной строкой в role_page_access — правок бэкенда не нужно.
--
-- Набор ключей личного кабинета скопирован с роли 'office'. /dashboard намеренно
-- НЕ даём — иначе роль увидит общий обзор компании.

BEGIN;

-- 1. Роль (схема актуальна после 044_simplify_roles.sql).
INSERT INTO system_roles (code, name, description, is_admin, employee_variant, is_active)
VALUES ('mts_manager', 'Менеджер МТС', 'Управление разделом «МТС Бизнес»: тарифы, детализация, абоненты, аккаунты', false, 'office', true)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  is_admin = false,
  employee_variant = EXCLUDED.employee_variant,
  is_active = true;

-- 2. Доступ: вся страница «МТС Бизнес» на редактирование + базовый личный кабинет.
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
VALUES
  ('mts_manager', '/mts-business',         true, true),
  ('mts_manager', '/employee',             true, false),
  ('mts_manager', '/employee/documents',   true, true),
  ('mts_manager', '/employee/requests',    true, true),
  ('mts_manager', '/employee/tasks',       true, true),
  ('mts_manager', '/employee/feedback',    true, true),
  ('mts_manager', '/employee/phonebook',   true, false),
  ('mts_manager', '/employee/sim',         true, false)
ON CONFLICT (role_code, page_path) DO UPDATE SET
  can_view = EXCLUDED.can_view,
  can_edit = EXCLUDED.can_edit;

NOTIFY pgrst, 'reload schema';

COMMIT;
