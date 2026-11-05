-- 346: «Управление кадрами» — новая вкладка «Выходные»: сотрудники ЛИНИЯ и ЛИНИЯ-Общестрой, которые работали
-- в выходной по СКУД, но корректировки на этот день нет. Вкладка только для просмотра, таблиц не добавляет.
--
-- Сразу — администратор и кадровый админ; остальным — галочкой в «Ролях».
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Прежний бэкенд с ней работает. Повторный запуск безопасен.

BEGIN;

INSERT INTO access_pages (
  key, label, group_code, group_label, area, surface,
  supports_edit, requires_data_scope, requires_employee_variant,
  sort_order, is_active, is_system
)
VALUES
  ('/staff-control/weekends', 'Управление кадрами — Выходные', 'work', 'Управление',
   'admin', 'technical', false, false, false, 104, true, true)
ON CONFLICT (key) DO UPDATE SET
  label         = EXCLUDED.label,
  group_code    = EXCLUDED.group_code,
  group_label   = EXCLUDED.group_label,
  area          = EXCLUDED.area,
  surface       = EXCLUDED.surface,
  supports_edit = EXCLUDED.supports_edit,
  sort_order    = EXCLUDED.sort_order,
  is_active     = EXCLUDED.is_active;

INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
VALUES
  ('admin',    '/staff-control/weekends', true, false),
  ('hr_admin', '/staff-control/weekends', true, false)
ON CONFLICT (role_code, page_path) DO UPDATE SET
  can_view = EXCLUDED.can_view,
  can_edit = EXCLUDED.can_edit;

COMMIT;
