-- FORCE RLS и REVOKE от anon/authenticated для всех public-таблиц.
-- Архитектура FOT опирается на service role, который RLS не подчиняется.
-- Цель — закрыть случайный прямой доступ через PostgREST и заглушить advisor.
-- Advisor закрывает: rls_disabled_in_public.

-- Партиции skud_events обработаны отдельно в 034.

ALTER TABLE public.access_capability_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_capability_catalog FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.access_capability_catalog FROM anon, authenticated;

ALTER TABLE public.access_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_pages FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.access_pages FROM anon, authenticated;

ALTER TABLE public.attendance_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_adjustments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.attendance_adjustments FROM anon, authenticated;

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.audit_logs FROM anon, authenticated;

ALTER TABLE public.category_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.category_schedules FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.category_schedules FROM anon, authenticated;

ALTER TABLE public.chat_contact_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_contact_grants FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.chat_contact_grants FROM anon, authenticated;

ALTER TABLE public.chat_contact_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_contact_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.chat_contact_requests FROM anon, authenticated;

ALTER TABLE public.chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_conversations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.chat_conversations FROM anon, authenticated;

ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.chat_messages FROM anon, authenticated;

ALTER TABLE public.chat_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_participants FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.chat_participants FROM anon, authenticated;

ALTER TABLE public.document_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_links FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.document_links FROM anon, authenticated;

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.documents FROM anon, authenticated;

ALTER TABLE public.employee_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_assignments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.employee_assignments FROM anon, authenticated;

ALTER TABLE public.employee_department_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_department_access FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.employee_department_access FROM anon, authenticated;

ALTER TABLE public.employee_schedule_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_schedule_assignments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.employee_schedule_assignments FROM anon, authenticated;

ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employees FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.employees FROM anon, authenticated;

ALTER TABLE public.leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.leave_requests FROM anon, authenticated;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.notifications FROM anon, authenticated;

ALTER TABLE public.object_schedule_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.object_schedule_assignments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.object_schedule_assignments FROM anon, authenticated;

ALTER TABLE public.org_departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_departments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.org_departments FROM anon, authenticated;

ALTER TABLE public.org_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_sites FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.org_sites FROM anon, authenticated;

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payments FROM anon, authenticated;

ALTER TABLE public.payslips ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payslips FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payslips FROM anon, authenticated;

ALTER TABLE public.positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.positions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.positions FROM anon, authenticated;

ALTER TABLE public.production_calendar ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.production_calendar FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.production_calendar FROM anon, authenticated;

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_subscriptions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.push_subscriptions FROM anon, authenticated;

ALTER TABLE public.role_page_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_page_access FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.role_page_access FROM anon, authenticated;

ALTER TABLE public.salary_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salary_history FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.salary_history FROM anon, authenticated;

ALTER TABLE public.salary_raise_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salary_raise_attachments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.salary_raise_attachments FROM anon, authenticated;

ALTER TABLE public.salary_raise_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salary_raise_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.salary_raise_requests FROM anon, authenticated;

ALTER TABLE public.sigur_health_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sigur_health_checks FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sigur_health_checks FROM anon, authenticated;

ALTER TABLE public.sigur_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sigur_incidents FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sigur_incidents FROM anon, authenticated;

ALTER TABLE public.sigur_runtime_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sigur_runtime_state FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sigur_runtime_state FROM anon, authenticated;

ALTER TABLE public.skud_access_point_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_access_point_settings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_access_point_settings FROM anon, authenticated;

ALTER TABLE public.skud_daily_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_daily_summary FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_daily_summary FROM anon, authenticated;

ALTER TABLE public.skud_object_access_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_object_access_points FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_object_access_points FROM anon, authenticated;

ALTER TABLE public.skud_object_map_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_object_map_points FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_object_map_points FROM anon, authenticated;

ALTER TABLE public.skud_object_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_object_routes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_object_routes FROM anon, authenticated;

ALTER TABLE public.skud_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_objects FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_objects FROM anon, authenticated;

ALTER TABLE public.skud_sync_department_filter ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_sync_department_filter FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_sync_department_filter FROM anon, authenticated;

ALTER TABLE public.skud_sync_employee_filter ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_sync_employee_filter FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_sync_employee_filter FROM anon, authenticated;

ALTER TABLE public.skud_travel_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skud_travel_segments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.skud_travel_segments FROM anon, authenticated;

ALTER TABLE public.sync_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_commands FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sync_commands FROM anon, authenticated;

ALTER TABLE public.sync_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_status FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sync_status FROM anon, authenticated;

ALTER TABLE public.system_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_roles FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.system_roles FROM anon, authenticated;

ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_settings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.system_settings FROM anon, authenticated;

ALTER TABLE public.tender_timesheet ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tender_timesheet FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tender_timesheet FROM anon, authenticated;

ALTER TABLE public.timesheet_approval_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timesheet_approval_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.timesheet_approval_events FROM anon, authenticated;

ALTER TABLE public.timesheet_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timesheet_approvals FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.timesheet_approvals FROM anon, authenticated;

ALTER TABLE public.timesheet_reminder_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timesheet_reminder_log FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.timesheet_reminder_log FROM anon, authenticated;

ALTER TABLE public.timesheet_responsibles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timesheet_responsibles FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.timesheet_responsibles FROM anon, authenticated;

ALTER TABLE public.user_department_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_department_access FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_department_access FROM anon, authenticated;

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_profiles FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_profiles FROM anon, authenticated;

ALTER TABLE public.work_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_categories FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.work_categories FROM anon, authenticated;

ALTER TABLE public.work_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_schedules FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.work_schedules FROM anon, authenticated;
