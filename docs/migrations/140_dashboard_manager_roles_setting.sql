-- 140_dashboard_manager_roles_setting.sql
-- Настройка дашборда HR: какие system_roles считаются «руководителями» в
-- «Карте руководителей». Раньше было захардкожено IN ('manager','manager_obj')
-- — выпадал site_supervisor («Начальник участка»). Теперь CSV-список кодов ролей
-- в system_settings, редактируется в админке (/admin/settings).
-- Дефолт = manager, manager_obj, site_supervisor. Идемпотентно.

INSERT INTO system_settings (key, value, description, is_secret)
VALUES (
  'dashboard_manager_role_codes',
  'manager,manager_obj,site_supervisor',
  'CSV кодов system_roles, считающихся руководителями в «Карте руководителей» дашборда HR.',
  false
)
ON CONFLICT (key) DO NOTHING;
