-- 103_contractor_role_and_pages.sql
-- Роль «Подрядчик» + страницы /contractor и /admin/contractor-approvals
-- в каталоге access_pages, переименование /skud-card-reader → «Пропуск»,
-- доступы ролям в role_page_access.
--
-- ВАЖНО: бывший 098_contractor_role_and_pages.sql использовал колонки
-- system_roles.permissions/level/is_system, которые удалены миграцией
-- 044_simplify_roles.sql → на проде INSERT падал, роль не создавалась.
-- Здесь — актуальный набор колонок. Плюс ЛК подрядчика оформлен как
-- тип кабинета: system_roles.employee_variant='contractor'.

BEGIN;

-- 1. Роль «Подрядчик» (актуальная схема после 044_simplify_roles.sql).
--    employee_variant='contractor' — тип личного кабинета (как office/object).
INSERT INTO system_roles (code, name, description, is_admin, employee_variant, is_active)
VALUES ('contractor', 'Подрядчик', null, false, 'contractor', true)
ON CONFLICT (code) DO UPDATE SET
  employee_variant = 'contractor',
  is_active = true;

-- 2. Расширяем CHECK employee_variant (был IN ('object','office') из 044).
ALTER TABLE system_roles DROP CONSTRAINT IF EXISTS system_roles_employee_variant_check;
ALTER TABLE system_roles ADD CONSTRAINT system_roles_employee_variant_check
  CHECK (employee_variant IN ('object', 'office', 'contractor'));

-- 3. Каталог страниц (формат как 079_skud_card_reader_page_access.sql).
INSERT INTO access_pages (key, label, group_code, group_label, surface, supports_edit, sort_order, is_active)
VALUES
  ('/skud-card-reader',          'Пропуск',                  'admin', 'Администрирование','page', true, 240, true),
  ('/contractor',                'Подрядчик: пропуска',      'admin', 'Администрирование','page', true, 241, true),
  ('/admin/contractor-approvals','Согласование подрядчиков', 'admin', 'Администрирование','page', true, 242, true)
ON CONFLICT (key) DO UPDATE SET
  label = EXCLUDED.label,
  group_code = EXCLUDED.group_code,
  group_label = EXCLUDED.group_label,
  surface = EXCLUDED.surface,
  supports_edit = EXCLUDED.supports_edit,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

-- 4. Доступы: contractor → /contractor; admin — только выпуск и согласование.
--    super_admin — флаг is_admin (bypass в коде), строки не нужны.
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
VALUES
  ('contractor', '/contractor',                 true, true),
  ('admin',      '/skud-card-reader',           true, true),
  ('admin',      '/admin/contractor-approvals', true, true)
ON CONFLICT (role_code, page_path) DO UPDATE SET
  can_view = EXCLUDED.can_view,
  can_edit = EXCLUDED.can_edit;

-- 5. ЛК подрядчика (/contractor) недоступен админу: убираем грант, если был.
DELETE FROM role_page_access WHERE role_code = 'admin' AND page_path = '/contractor';

NOTIFY pgrst, 'reload schema';

COMMIT;
