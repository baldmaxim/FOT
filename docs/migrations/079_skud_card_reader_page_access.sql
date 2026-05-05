-- 079_skud_card_reader_page_access.sql
-- Регистрация страницы /skud-card-reader (USB-считыватель пропусков Sigur)
-- в каталоге access_pages и выдача доступа ролям super_admin / admin.

-- 1. Каталог страниц.
INSERT INTO access_pages (key, label, group_code, group_label, surface, supports_edit, sort_order, is_active)
VALUES (
  '/skud-card-reader',
  'Считыватель пропусков',
  'skud',
  'СКУД',
  'page',
  true,
  215,
  true
)
ON CONFLICT (key) DO UPDATE SET
  label = EXCLUDED.label,
  group_code = EXCLUDED.group_code,
  group_label = EXCLUDED.group_label,
  surface = EXCLUDED.surface,
  supports_edit = EXCLUDED.supports_edit,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

-- 2. Доступ ролям. admin получает view+edit. super_admin это флаг is_admin
-- на пользователе, а не отдельная роль — для него работает bypass в коде.
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
VALUES ('admin', '/skud-card-reader', true, true)
ON CONFLICT (role_code, page_path) DO UPDATE SET
  can_view = EXCLUDED.can_view,
  can_edit = EXCLUDED.can_edit;
