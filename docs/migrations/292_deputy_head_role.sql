-- 292: роль «Заместитель» (deputy_head).
--
-- Сотрудник с этой ролью ведёт табель СВОЕГО отдела (employees.org_department_id) без
-- ручного назначения: правка, подача, решения по «Корректировке табеля», заявки на поиск
-- как заказчик (без утверждения кандидата/набора). Дополнительные отделы — ручными
-- назначениями уровня 'deputy' («Назначения сотрудников» → «Заместитель»).
--
-- Какие отделы засчитываются (правило А, services/deputy-role.service.ts): только листовые
-- (без подотделов) и без владельца табеля выше по дереву — иначе пара (сотрудник, дата)
-- попала бы в две подачи.
--
-- Права — только из матрицы роли (ниже). Авто-гранты назначения 'deputy' для этой роли
-- не действуют, поэтому снятая в «Ролях» галочка действительно убирает доступ.
--
-- Порядок деплоя: миграция → бэкенд (перезапуск сбрасывает кэши ролей). Код без миграции
-- безопасен: роли просто нет. Повторный прогон восстанавливает канонические свойства.
BEGIN;

INSERT INTO system_roles (code, name, description, is_admin, admin_access,
                          manager_auto_access, all_departments_scope,
                          employee_variant, is_active, hide_sidebar,
                          show_actual_hours, timesheet_months_back,
                          timesheet_months_forward, timesheet_show_full_period,
                          corrections_anomalies_only, corrections_cap_by_schedule_norm,
                          corrections_allow_zero_short_attendance, corrections_disable_bulk,
                          corrections_disable_object_entries, weekend_memo_required,
                          max_corrections_per_month, view_all_departments,
                          object_kpi_own_objects_only)
VALUES ('deputy_head', 'Заместитель',
        'Заместитель начальника своего отдела: правка и подача табеля, «Корректировки табеля», заявки на поиск без утверждения оффера. Дополнительные отделы — назначением «Заместитель».',
        false, true, false, false, 'office', true, false,
        true, 1, 1, true,
        false, false, false, false, false, false,
        NULL, false,
        false)
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
  view_all_departments = EXCLUDED.view_all_departments,
  object_kpi_own_objects_only = EXCLUDED.object_kpi_own_objects_only;

-- Личный кабинет — ровно как у «Офисного сотрудника»: роль меняют именно с неё.
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
SELECT 'deputy_head', rpa.page_path, rpa.can_view, rpa.can_edit
  FROM role_page_access rpa
 WHERE rpa.role_code = 'office'
   AND (rpa.page_path = '/employee' OR rpa.page_path LIKE '/employee/%')
ON CONFLICT (role_code, page_path) DO UPDATE
  SET can_view = EXCLUDED.can_view, can_edit = EXCLUDED.can_edit;

-- Разделы заместителя. «Заявки на поиск» — только просмотр: у страницы нет права
-- правки (supports_edit=false), создание заявки открывает сам просмотр.
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit) VALUES
  ('deputy_head', '/timesheet', true, true),
  ('deputy_head', '/leave-requests', true, true),
  ('deputy_head', '/staff-control/hiring', true, false)
ON CONFLICT (role_code, page_path) DO UPDATE
  SET can_view = EXCLUDED.can_view, can_edit = EXCLUDED.can_edit;

COMMIT;
