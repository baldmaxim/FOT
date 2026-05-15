-- Migration 096: вынести видимость кнопки «Добавить сотрудника» в табеле
-- в отдельную техническую страницу access_pages.timesheet-team-management.
-- Backfill: всем ролям с edit-доступом к /timesheet или /timesheet-hr выдаём
-- can_edit=true на новый ключ — поведение сохраняется.
-- Удаляем мёртвую глобальную настройку system_settings.timesheet_team_management.

BEGIN;

INSERT INTO access_pages (
  key,
  label,
  group_code,
  group_label,
  surface,
  supports_edit,
  requires_data_scope,
  requires_employee_variant,
  sort_order,
  is_active,
  is_system
) VALUES (
  'timesheet-team-management',
  'Управление составом табеля',
  'technical',
  'Технические доступы',
  'technical',
  true,
  false,
  false,
  285,
  true,
  true
)
ON CONFLICT (key) DO UPDATE
SET
  label = EXCLUDED.label,
  group_code = EXCLUDED.group_code,
  group_label = EXCLUDED.group_label,
  surface = EXCLUDED.surface,
  supports_edit = EXCLUDED.supports_edit,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
SELECT DISTINCT role_code, 'timesheet-team-management', true, true
FROM role_page_access
WHERE can_edit = true
  AND page_path IN ('/timesheet', '/timesheet-hr')
ON CONFLICT (role_code, page_path) DO NOTHING;

DELETE FROM system_settings WHERE key = 'timesheet_team_management';

COMMIT;
