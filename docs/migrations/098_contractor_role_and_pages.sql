-- 098_contractor_role_and_pages.sql
-- Роль «Подрядчик» + страницы /contractor и /admin/contractor-approvals
-- в каталоге access_pages, переименование /skud-card-reader → «Пропуск»,
-- доступы ролям в role_page_access.

BEGIN;

-- 1. Роль «Подрядчик» (формат как 004_dynamic_roles.sql).
INSERT INTO system_roles (code, name, description, permissions, level, is_active, is_system)
VALUES ('contractor', 'Подрядчик', null, '[]', 1, true, true)
ON CONFLICT (code) DO NOTHING;

-- 2. Каталог страниц (формат как 079_skud_card_reader_page_access.sql).
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

-- 3. Доступы. super_admin — флаг is_admin (bypass в коде), строки не нужны.
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
VALUES
  ('contractor', '/contractor',                 true, true),
  ('admin',      '/contractor',                 true, true),
  ('admin',      '/admin/contractor-approvals', true, true),
  ('admin',      '/skud-card-reader',           true, true)
ON CONFLICT (role_code, page_path) DO UPDATE SET
  can_view = EXCLUDED.can_view,
  can_edit = EXCLUDED.can_edit;

NOTIFY pgrst, 'reload schema';

COMMIT;
