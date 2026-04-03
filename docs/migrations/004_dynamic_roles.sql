-- Migration: dynamic_roles_phase1
-- Создание динамической системы ролей

-- 1. Заполнить system_roles начальными данными
INSERT INTO system_roles (code, name, description, permissions, level, is_active, is_system)
VALUES
  ('worker',      'Сотрудник',     null, '[]', 1, true, true),
  ('header',      'Руководитель',  null, '[]', 2, true, true),
  ('hr',          'Отдел кадров',  null, '[]', 3, true, true),
  ('admin',       'Администратор', null, '[]', 4, true, true),
  ('super_admin', 'Супер-админ',   null, '[]', 5, true, true)
ON CONFLICT (code) DO NOTHING;

-- 2. Создать таблицу role_page_access
CREATE TABLE IF NOT EXISTS role_page_access (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_code TEXT NOT NULL REFERENCES system_roles(code) ON DELETE CASCADE,
  page_path TEXT NOT NULL,
  can_view  BOOLEAN DEFAULT true,
  can_edit  BOOLEAN DEFAULT false,
  UNIQUE(role_code, page_path)
);

-- 3. Заполнить матрицу доступа начальными данными
INSERT INTO role_page_access (role_code, page_path, can_view) VALUES
  ('worker', '/employee', true),
  ('header', '/employee', true),
  ('header', '/dashboard', true),
  ('header', '/my-employees', true),
  ('header', '/leave-requests', true),
  ('header', '/timesheet', true),
  ('header', '/profile', true),
  ('hr', '/employee', true),
  ('hr', '/dashboard', true),
  ('hr', '/my-employees', true),
  ('hr', '/leave-requests', true),
  ('hr', '/timesheet', true),
  ('hr', '/profile', true),
  ('hr', '/timesheet-review', true),
  ('admin', '/employee', true),
  ('admin', '/dashboard', true),
  ('admin', '/my-employees', true),
  ('admin', '/leave-requests', true),
  ('admin', '/timesheet', true),
  ('admin', '/profile', true),
  ('admin', '/timesheet-review', true),
  ('admin', '/tender', true),
  ('admin', '/skud-raw', true),
  ('admin', '/skud-db', true),
  ('admin', '/discipline', true),
  ('super_admin', '/employee', true),
  ('super_admin', '/dashboard', true),
  ('super_admin', '/my-employees', true),
  ('super_admin', '/leave-requests', true),
  ('super_admin', '/timesheet', true),
  ('super_admin', '/profile', true),
  ('super_admin', '/timesheet-review', true),
  ('super_admin', '/tender', true),
  ('super_admin', '/skud-raw', true),
  ('super_admin', '/skud-db', true),
  ('super_admin', '/discipline', true),
  ('super_admin', '/skud-settings', true),
  ('super_admin', '/admin/users', true),
  ('super_admin', '/admin/manage', true),
  ('super_admin', '/admin/audit', true),
  ('super_admin', '/admin/roles', true)
ON CONFLICT (role_code, page_path) DO NOTHING;

-- 4. Мигрировать position_type с ENUM на TEXT + FK
ALTER TABLE user_profiles ALTER COLUMN position_type DROP DEFAULT;
ALTER TABLE user_profiles ALTER COLUMN position_type TYPE TEXT;
DROP TYPE IF EXISTS employee_position_type;
ALTER TABLE user_profiles ALTER COLUMN position_type SET DEFAULT 'worker';
ALTER TABLE user_profiles ADD CONSTRAINT fk_position_type
  FOREIGN KEY (position_type) REFERENCES system_roles(code);
