-- Добавляем отсутствующие индексы на FK-колонки (21 шт.) для hot-path таблиц.
-- Advisor закрывает: unindexed_foreign_keys × 21.
-- IF NOT EXISTS для идемпотентности.

CREATE INDEX IF NOT EXISTS idx_attendance_adjustments_created_by
  ON public.attendance_adjustments (created_by);

CREATE INDEX IF NOT EXISTS idx_category_schedules_schedule_id
  ON public.category_schedules (schedule_id);

CREATE INDEX IF NOT EXISTS idx_chat_contact_grants_created_by
  ON public.chat_contact_grants (created_by);

CREATE INDEX IF NOT EXISTS idx_chat_contact_requests_resolved_by
  ON public.chat_contact_requests (resolved_by);

CREATE INDEX IF NOT EXISTS idx_documents_leave_request_id
  ON public.documents (leave_request_id);

CREATE INDEX IF NOT EXISTS idx_employee_assignments_org_department_id
  ON public.employee_assignments (org_department_id);
CREATE INDEX IF NOT EXISTS idx_employee_assignments_org_site_id
  ON public.employee_assignments (org_site_id);
CREATE INDEX IF NOT EXISTS idx_employee_assignments_position_id
  ON public.employee_assignments (position_id);

CREATE INDEX IF NOT EXISTS idx_employee_department_access_created_by
  ON public.employee_department_access (created_by);

CREATE INDEX IF NOT EXISTS idx_employee_schedule_assignments_schedule_id
  ON public.employee_schedule_assignments (schedule_id);

CREATE INDEX IF NOT EXISTS idx_employees_work_category
  ON public.employees (work_category);

CREATE INDEX IF NOT EXISTS idx_object_schedule_assignments_schedule_id
  ON public.object_schedule_assignments (schedule_id);

CREATE INDEX IF NOT EXISTS idx_org_sites_department_id
  ON public.org_sites (department_id);
CREATE INDEX IF NOT EXISTS idx_org_sites_manager_id
  ON public.org_sites (manager_id);

CREATE INDEX IF NOT EXISTS idx_salary_history_created_by
  ON public.salary_history (created_by);

CREATE INDEX IF NOT EXISTS idx_skud_object_routes_to_object_id
  ON public.skud_object_routes (to_object_id);

CREATE INDEX IF NOT EXISTS idx_skud_travel_segments_from_object_id
  ON public.skud_travel_segments (from_object_id);
CREATE INDEX IF NOT EXISTS idx_skud_travel_segments_to_object_id
  ON public.skud_travel_segments (to_object_id);

CREATE INDEX IF NOT EXISTS idx_timesheet_approval_events_actor_user_id
  ON public.timesheet_approval_events (actor_user_id);

CREATE INDEX IF NOT EXISTS idx_timesheet_reminder_log_user_id
  ON public.timesheet_reminder_log (user_id);

CREATE INDEX IF NOT EXISTS idx_user_department_access_created_by
  ON public.user_department_access (created_by);
