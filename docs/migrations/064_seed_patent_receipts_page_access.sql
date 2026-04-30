-- 064_seed_patent_receipts_page_access.sql
-- При добавлении страницы /admin/patent-receipts (Чеки за патент) забыли
-- проинициализировать access_pages и role_page_access. В результате backend
-- requirePageAccess отвечает 403 даже админу (на фронте страница открывается
-- через bypass is_admin в canViewPage, а вот /api/patent-receipts падает).

-- 1. Добавляем страницу в каталог access_pages.
INSERT INTO access_pages (key, label, group_code, group_label, surface, supports_edit, sort_order, is_active)
VALUES (
  '/admin/patent-receipts',
  'Чеки за патент',
  'admin',
  'Администрирование',
  'page',
  true,
  275,
  true
)
ON CONFLICT (key) DO UPDATE SET
  label = EXCLUDED.label,
  group_code = EXCLUDED.group_code,
  group_label = EXCLUDED.group_label,
  surface = EXCLUDED.surface,
  supports_edit = EXCLUDED.supports_edit,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active;

-- 2. Даём роли admin полный доступ.
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
VALUES ('admin', '/admin/patent-receipts', true, true)
ON CONFLICT (role_code, page_path) DO UPDATE SET
  can_view = EXCLUDED.can_view,
  can_edit = EXCLUDED.can_edit;
