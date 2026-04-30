-- 070_manager_schedule_templates_access.sql
--
-- Открыть руководителям (role_code='manager') возможность создавать и
-- редактировать шаблоны графиков (вкладка "Шаблоны графиков" на /admin/schedules).
-- При этом доступ к остальным вкладкам страницы (Графики объектов,
-- Производственный календарь) у менеджера НЕ появляется.
--
-- Подход: создаём виртуальную страницу-маркер /admin/schedules/templates.
-- Эндпоинты шаблонов в schedule.routes.ts будут принимать любой из
-- (/admin/schedules, /admin/schedules/templates, /staff-control). Фронт
-- по наличию доступа к /admin/schedules/templates (без полного доступа к
-- /admin/schedules) рендерит SchedulesPage в режиме "только шаблоны".
--
-- Применяется вручную через psql на проде:
--   psql "$DATABASE_URL" -f docs/migrations/070_manager_schedule_templates_access.sql

BEGIN;

-- 1. Регистрируем виртуальную страницу в каталоге access_pages.
--    surface='technical' — это служебный pseudo-маршрут, отдельной страницы
--    под него нет, фронт открывает /admin/schedules.
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
)
VALUES (
  '/admin/schedules/templates',
  'Шаблоны графиков (только вкладка)',
  'admin',
  'Администрирование',
  'technical',
  true,
  false,
  false,
  261,
  true,
  true
)
ON CONFLICT (key) DO UPDATE SET
  label = EXCLUDED.label,
  group_code = EXCLUDED.group_code,
  group_label = EXCLUDED.group_label,
  surface = EXCLUDED.surface,
  supports_edit = EXCLUDED.supports_edit,
  requires_data_scope = EXCLUDED.requires_data_scope,
  requires_employee_variant = EXCLUDED.requires_employee_variant,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  is_system = EXCLUDED.is_system,
  updated_at = NOW();

-- 2. Даём роли manager полный доступ (view + edit) к этой виртуальной странице.
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
VALUES ('manager', '/admin/schedules/templates', true, true)
ON CONFLICT (role_code, page_path) DO UPDATE SET
  can_view = EXCLUDED.can_view,
  can_edit = EXCLUDED.can_edit;

COMMIT;
