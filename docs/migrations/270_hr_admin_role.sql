-- 270: роль «Кадровый админ» (hr_admin) + флаг скоупа all_departments_scope.
--
-- all_departments_scope — ТОЛЬКО скоуп данных (все отделы на чтение и запись).
-- Разрешением на действие он не является: право всегда проверяется page-access
-- соответствующей страницы. Роль с флагом, но без edit нужной страницы, действие
-- не получает.
--
-- Применять ДО деплоя бэкенда (roles-cache перечисляет колонки явно).
BEGIN;

ALTER TABLE system_roles
  ADD COLUMN IF NOT EXISTS all_departments_scope boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN system_roles.all_departments_scope IS
  'СКОУП ДАННЫХ: все отделы на чтение и запись. НЕ является разрешением на действие — право всегда проверяется page-access соответствующей страницы. Не применяется к is_admin.';

-- Настройки зеркалят роль admin: под ней кадровики работают сейчас, и любое
-- расхождение изменило бы им картину табеля. Окно месяцев 12/1 — страховка.
-- ON CONFLICT восстанавливает все канонические свойства: повторный прогон чинит
-- роль, которую руками испортили в UI.
INSERT INTO system_roles (code, name, description, is_admin, admin_access,
                          manager_auto_access, all_departments_scope,
                          employee_variant, is_active, hide_sidebar,
                          show_actual_hours, timesheet_months_back,
                          timesheet_months_forward, timesheet_show_full_period,
                          corrections_anomalies_only, corrections_cap_by_schedule_norm,
                          corrections_allow_zero_short_attendance, corrections_disable_bulk,
                          corrections_disable_object_entries, weekend_memo_required,
                          max_corrections_per_month, view_all_departments)
VALUES ('hr_admin', 'Кадровый админ',
        'Кадровая служба с расширенными правами: кадры, табель, согласования, SIGUR, одобрение пользователей. Без технических разделов СКУД и без настройки доступов.',
        false, true, false, true, 'office', true, false,
        true, 12, 1, true,
        false, false, false, false, false, false,
        NULL, false)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  is_admin = EXCLUDED.is_admin,
  admin_access = EXCLUDED.admin_access,
  manager_auto_access = EXCLUDED.manager_auto_access,
  all_departments_scope = EXCLUDED.all_departments_scope,
  employee_variant = EXCLUDED.employee_variant,
  is_active = true,
  hide_sidebar = EXCLUDED.hide_sidebar,
  show_actual_hours = EXCLUDED.show_actual_hours,
  timesheet_months_back = EXCLUDED.timesheet_months_back,
  timesheet_months_forward = EXCLUDED.timesheet_months_forward,
  timesheet_show_full_period = EXCLUDED.timesheet_show_full_period,
  corrections_anomalies_only = EXCLUDED.corrections_anomalies_only,
  corrections_cap_by_schedule_norm = EXCLUDED.corrections_cap_by_schedule_norm,
  corrections_allow_zero_short_attendance = EXCLUDED.corrections_allow_zero_short_attendance,
  corrections_disable_bulk = EXCLUDED.corrections_disable_bulk,
  corrections_disable_object_entries = EXCLUDED.corrections_disable_object_entries,
  weekend_memo_required = EXCLUDED.weekend_memo_required,
  max_corrections_per_month = EXCLUDED.max_corrections_per_month,
  view_all_departments = EXCLUDED.view_all_departments;

-- /sigur: кто видел СКУД — видит и SIGUR. Эффективные права ролей не меняются.
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
SELECT role_code, '/sigur', can_view, can_edit
  FROM role_page_access WHERE page_path = '/skud-settings'
ON CONFLICT (role_code, page_path) DO UPDATE
  SET can_view = EXCLUDED.can_view, can_edit = EXCLUDED.can_edit;

-- /admin/users/access: кто видел «Пользователей» — видит и настройку доступов.
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
SELECT role_code, '/admin/users/access', can_view, can_edit
  FROM role_page_access WHERE page_path = '/admin/users'
ON CONFLICT (role_code, page_path) DO UPDATE
  SET can_view = EXCLUDED.can_view, can_edit = EXCLUDED.can_edit;

-- Остальные новые ключи выдаём ЯВНО перечисленным ролям, а не по признаку edit:
-- иначе /staff-control/direct-reports впервые достался бы роли security.
-- /timesheet/lock-toggle повторяет текущее поведение canToggleTimesheetLock (admin + hr).
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit) VALUES
  ('admin','/staff-control/direct-reports',true,true),
  ('hr_admin','/staff-control/direct-reports',true,true),
  ('admin','/timesheet/lock-toggle',true,true),
  ('hr','/timesheet/lock-toggle',true,true),
  ('hr_admin','/timesheet/lock-toggle',true,true)
ON CONFLICT (role_code, page_path) DO UPDATE
  SET can_view = EXCLUDED.can_view, can_edit = EXCLUDED.can_edit;

-- Набор страниц роли hr_admin.
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit) VALUES
  ('hr_admin','/employee',true,false),
  ('hr_admin','/employee/requests',true,true),
  ('hr_admin','/employee/documents',true,true),
  ('hr_admin','/employee/tasks',true,true),
  ('hr_admin','/employee/testing',true,true),
  ('hr_admin','/employee/salary-raise',true,true),
  ('hr_admin','/employee/sim',true,true),
  ('hr_admin','/employee/feedback',true,true),
  ('hr_admin','/employee/phonebook',true,false),
  ('hr_admin','/dashboard',true,false),
  ('hr_admin','/leave-requests',true,true),
  ('hr_admin','/leave-vacations',true,true),
  ('hr_admin','/leave-dismissals',true,true),
  ('hr_admin','/salary-raise-review',true,true),
  ('hr_admin','/skud-presence',true,false),
  ('hr_admin','/staff-control',true,true),
  ('hr_admin','/staff-control/hiring',true,false),
  ('hr_admin','/staff-control/induction',true,true),
  ('hr_admin','/staff-control/hr-profiles',true,true),
  ('hr_admin','/staff-control/department',true,true),
  ('hr_admin','/staff-control/position',true,true),
  ('hr_admin','/staff-control/schedule',true,true),
  ('hr_admin','/staff-control/timesheet-mode',true,true),
  ('hr_admin','/employees',true,false),
  ('hr_admin','/timesheet',true,true),
  ('hr_admin','/timesheet/events',true,false),
  ('hr_admin','timesheet-team-management',true,true),
  ('hr_admin','/timesheet-hr',true,true),
  ('hr_admin','/discipline',true,false),
  ('hr_admin','/sigur',true,true),
  ('hr_admin','/admin/users',true,true),
  ('hr_admin','/admin/checks',true,true)
ON CONFLICT (role_code, page_path) DO UPDATE
  SET can_view = EXCLUDED.can_view, can_edit = EXCLUDED.can_edit;

-- Техника кадровому админу не положена: скопировать её могли только блоки выше.
DELETE FROM role_page_access
 WHERE role_code = 'hr_admin'
   AND page_path IN ('/skud-settings','/admin/users/access');

COMMIT;
