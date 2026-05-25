import { Request } from 'express';

export type ChatInboundMode = 'open' | 'requests_only' | 'disabled';
export type EmployeeVariant = 'object' | 'office';

// Системная роль. Поведение роли задано её флагами (is_admin, employee_variant)
// и матрицей role_page_access.
export interface SystemRole {
  id: string;
  code: string;
  name: string;
  description: string | null;
  is_admin: boolean;
  employee_variant: EmployeeVariant | null;
  is_active: boolean;
  show_actual_hours: boolean;
  /** true → у пользователей роли полностью скрывается боковое меню. Для is_admin игнорируется на фронте. */
  hide_sidebar: boolean;
  /** Окно доступных месяцев табеля: сколько месяцев назад от текущего. Применяется когда is_admin=false. Дефолт 1. */
  timesheet_months_back: number;
  /** Окно доступных месяцев табеля: сколько месяцев вперёд от текущего. Применяется когда is_admin=false. Дефолт 1. */
  timesheet_months_forward: number;
  created_at: string;
  updated_at: string;
}

// Матрица доступа к страницам
export interface RolePageAccess {
  id: string;
  role_code: string;
  page_path: string;
  can_view: boolean;
  can_edit: boolean;
}

// Профиль, отправляемый клиенту (зеркало fot-app/src/types/auth.ts::UserProfile).
// position_type оставлен как алиас role_code для обратной совместимости UI.
export interface UserProfileResponse {
  id: string;
  full_name: string | null;
  system_role_id: string;
  role_code: string;
  role_name: string;
  position_type: string;
  is_admin: boolean;
  employee_variant: EmployeeVariant | null;
  show_actual_hours: boolean;
  hide_sidebar: boolean;
  timesheet_months_back: number;
  timesheet_months_forward: number;
  employee_id: number | null;
  department_id: string | null;
  managed_department_ids: string[];
  has_direct_reports?: boolean;
  supervisor_id: string | null;
  chat_inbound_mode: ChatInboundMode;
  imported_position: string | null;
  page_access: Record<string, { can_view: boolean; can_edit: boolean }>;
  is_approved: boolean;
  two_factor_enabled: boolean;
  company_scope?: { roots: 'all' | string[] };
}

// Профиль пользователя в БД (включая секреты).
export interface UserProfile {
  id: string;
  full_name: string | null;
  system_role_id: string;
  employee_id: number | null;
  supervisor_id: string | null;
  chat_inbound_mode: ChatInboundMode;
  imported_position: string | null;
  is_approved: boolean;
  is_site_supervisor: boolean;
  approved_by: string | null;
  approved_at: string | null;
  totp_secret: string | null;
  recovery_codes: string[] | null;
  two_factor_enabled: boolean;
  token_version: number;
  created_at: string;
  updated_at: string;
}

// Скоуп компаний для администратора. Загружается lazy в data-scope.service.
// roots='all' — системный админ (нет записей в user_company_access),
// roots=[]   — обычный пользователь (не is_admin),
// roots=[…] — админ компании (видит только перечисленные корни и их потомков).
export interface CompanyScope {
  roots: 'all' | string[];
}

// Расширенный Request с информацией о пользователе
export interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
    system_role_id: string;
    role_code: string;
    is_admin: boolean;
    employee_variant: EmployeeVariant | null;
    show_actual_hours: boolean;
    timesheet_months_back: number;
    timesheet_months_forward: number;
    employee_id: number | null;
    department_id: string | null;
    is_approved: boolean;
    two_factor_enabled: boolean;
    two_factor_verified: boolean;
    company_scope?: CompanyScope;
    __company_subtree_ids?: string[];
    __manager_subtree_ids?: string[];
    __direct_subordinates?: Set<number>;
    __skud_object_scope?: { is_unrestricted: boolean; object_ids: string[] };
  };
}

// Сотрудник в БД
export interface EmployeeEncrypted {
  id: number;
  full_name: string;
  last_name: string | null;
  first_name: string | null;
  middle_name: string | null;
  current_salary: string | null;
  salary_actual: string | null;
  salary_calculated: string | null;
  staff_units: string | null;
  birth_date: string | null;
  hire_date: string;
  country: string | null;
  pension_number: string | null;
  patent_issue_date: string | null;
  patent_expiry_date: string | null;
  email: string | null;
  org_department_id: string | null;
  position_id: string | null;
  sigur_employee_id: number | null;
  tab_number: string | null;
  current_status: string | null;
  permit_expiry_date: string | null;
  registration_cat1: string | null;
  registration_cat4: string | null;
  doc_receipt_date: string | null;
  work_object: string | null;
  employment_status: 'active' | 'fired';
  department_locked: boolean;
  is_archived: boolean;
  archived_at: string | null;
  dismissal_date?: string | null;
  created_at: string;
  updated_at: string;
  excluded_from_timesheet?: boolean | null;
  excluded_from_timesheet_at?: string | null;
  excluded_from_timesheet_date?: string | null;
}

// Сотрудник для API
export interface Employee {
  id: number;
  full_name: string;
  last_name: string | null;
  first_name: string | null;
  middle_name: string | null;
  position_name: string | null;
  position_id: string | null;
  sigur_employee_id: number | null;
  current_salary: number | null;
  salary_actual: number | null;
  salary_calculated: number | null;
  staff_units: number | null;
  birth_date: string | null;
  hire_date: string;
  country: string | null;
  pension_number: string | null;
  patent_issue_date: string | null;
  patent_expiry_date: string | null;
  email: string | null;
  department: string | null;
  org_department_id: string | null;
  tab_number: string | null;
  current_status: string | null;
  permit_expiry_date: string | null;
  registration_cat1: string | null;
  registration_cat4: string | null;
  doc_receipt_date: string | null;
  work_object: string | null;
  employment_status: 'active' | 'fired';
  department_locked: boolean;
  is_archived: boolean;
  archived_at: string | null;
  dismissal_date?: string | null;
  created_at: string;
  updated_at: string;
  excluded_from_timesheet?: boolean;
  excluded_from_timesheet_at?: string | null;
  excluded_from_timesheet_date?: string | null;
  site_name?: string | null;
  site_manager_full_name?: string | null;
}

export interface SalaryHistoryEncrypted {
  id: number;
  employee_id: number;
  salary: string;
  effective_date: string;
  note: string | null;
  created_at: string;
}

export interface SalaryHistory {
  id: number;
  employee_id: number;
  salary: number;
  effective_date: string;
  note: string | null;
  created_at: string;
}

export type TimeStatus = 'work' | 'vacation' | 'dayoff' | 'remote' | 'unpaid' | 'absent' | 'sick' | 'manual' | 'educational_leave';

export interface TimeEntry {
  id: number;
  employee_id: number;
  work_date: string;
  status: TimeStatus;
  hours_worked: number | null;
  is_correction: boolean;
  created_at: string;
  updated_at: string;
}

export interface SKUDEventEncrypted {
  id: number;
  employee_id: number;
  event_date: string;
  event_time: string;
  event_datetime: string;
  event_type: 'entry' | 'exit';
  physical_person: string | null;
  department: string | null;
  location: string | null;
  card_number: string | null;
  controller: string | null;
  door: string | null;
  manual_entry: boolean;
  created_at: string;
}

export interface SKUDEvent {
  id: number;
  employee_id: number;
  event_date: string;
  event_time: string;
  event_datetime: string;
  event_type: 'entry' | 'exit';
  physical_person: string | null;
  department: string | null;
  location: string | null;
  card_number: string | null;
  controller: string | null;
  door: string | null;
  manual_entry: boolean;
  created_at: string;
}

export interface SKUDDailySummary {
  id: number;
  employee_id: number;
  work_date: string;
  first_entry: string | null;
  last_exit: string | null;
  total_office_hours: number | null;
  entries_count: number;
  exits_count: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface AuditLog {
  id: number;
  user_id: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// JWT Payload
export interface JWTPayload {
  sub: string;
  email: string;
  token_type?: 'access' | 'refresh';
  system_role_id: string;
  role_code: string;
  is_admin: boolean;
  employee_variant: EmployeeVariant | null;
  show_actual_hours: boolean;
  timesheet_months_back: number;
  timesheet_months_forward: number;
  employee_id: number | null;
  department_id: string | null;
  is_approved: boolean;
  two_factor_enabled: boolean;
  two_factor_verified: boolean;
  token_version: number;
  iat: number;
  exp: number;
}

export type OrgDepartmentKind = 'department' | 'brigade' | 'object';

export const ORG_DEPARTMENT_KINDS: readonly OrgDepartmentKind[] = ['department', 'brigade', 'object'];

export interface OrgDepartmentEncrypted {
  id: string;
  parent_id: string | null;
  sigur_department_id: number | null;
  name: string;
  description: string | null;
  sort_order: number;
  is_active: boolean;
  kind: OrgDepartmentKind;
  created_at: string;
  updated_at: string;
}

export interface OrgDepartment {
  id: string;
  parent_id: string | null;
  sigur_department_id: number | null;
  name: string;
  description: string | null;
  sort_order: number;
  is_active: boolean;
  kind: OrgDepartmentKind;
  created_at: string;
  updated_at: string;
}

export interface OrgDepartmentNode extends OrgDepartment {
  children: OrgDepartmentNode[];
  // true — узел сам по себе входит в scope пользователя.
  // false — узел оставлен только как контейнер-предок ассигнованного отдела.
  // Отсутствует — клиент должен считать как `true` (совместимость).
  in_scope?: boolean;
}

export interface OrgStructureTree {
  departments: OrgDepartmentNode[];
}

export type LeaveRequestType = 'vacation' | 'sick_leave' | 'remote' | 'certificate' | 'time_correction' | 'unpaid' | 'work';
export type LeaveRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface LeaveRequest {
  id: number;
  employee_id: number;
  request_type: LeaveRequestType;
  status: LeaveRequestStatus;
  start_date: string;
  end_date: string;
  reason: string | null;
  reviewer_id: string | null;
  reviewed_at: string | null;
  review_comment: string | null;
  created_at: string;
  updated_at: string;
}

export type SalaryRaiseStatus = 'draft' | 'admin_review' | 'approved' | 'rejected' | 'cancelled';
export type SalaryRaiseRequestType = 'other';

export interface SalaryRaiseRequest {
  id: number;
  employee_id: number;
  author_user_id: string;
  flow_version: number;
  status: SalaryRaiseStatus;
  employee_snapshot: Record<string, unknown>;
  manager_snapshot: Record<string, unknown> | null;
  current_salary_entered: number | null;
  request_type: SalaryRaiseRequestType | null;
  requested_salary: number;
  raise_percentage: number;
  desired_effective_date: string | null;
  reason_brief: string | null;
  achievements: unknown[];
  responsibility_changes: Record<string, unknown>;
  self_assessment: Record<string, unknown>;
  work_object_id: string | null;
  work_object_name: string | null;
  job_summary: string | null;
  manager_justification: string | null;
  admin_review: Record<string, unknown> | null;
  admin_reviewer_id: string | null;
  admin_reviewed_at: string | null;
  supervisor_review: Record<string, unknown> | null;
  supervisor_reviewer_id: string | null;
  supervisor_reviewed_at: string | null;
  hr_review: Record<string, unknown> | null;
  hr_reviewer_id: string | null;
  hr_reviewed_at: string | null;
  finance_review: Record<string, unknown> | null;
  finance_reviewer_id: string | null;
  finance_reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SalaryRaiseAttachment {
  id: number;
  salary_raise_id: number;
  achievement_index: number | null;
  file_name: string;
  file_size: number;
  mime_type: string;
  r2_key: string;
  uploaded_by: string;
  created_at: string;
}

export type DocumentCategory = 'certificate' | 'scan' | 'approval' | 'payslip' | 'other';

export interface Document {
  id: number;
  employee_id: number;
  leave_request_id: number | null;
  category: DocumentCategory;
  file_name: string;
  file_size: number;
  mime_type: string;
  r2_key: string;
  uploaded_by: string;
  created_at: string;
}

export interface Payslip {
  id: number;
  employee_id: number;
  period: string;
  gross_amount: number | null;
  net_amount: number | null;
  deductions: number | null;
  details: Record<string, unknown> | null;
  document_id: number | null;
  created_by: string;
  created_at: string;
}

export type PaymentType = 'salary' | 'advance' | 'bonus' | 'vacation_pay' | 'sick_pay' | 'other';

export interface Payment {
  id: number;
  employee_id: number;
  payment_date: string;
  amount: number;
  payment_type: PaymentType;
  description: string | null;
  period: string | null;
  created_by: string;
  created_at: string;
}

export type ScheduleType = 'office' | 'remote' | 'hybrid' | 'shift';
export type PatternType = '5+0' | '5+2' | '6+0' | 'custom' | 'cycle';

export interface IDayOverride {
  work_start: string;
  work_end: string;
  work_hours: number;
  lunch_minutes?: number;
}

/**
 * Слот циклического графика (один день цикла).
 * Для нерабочего дня (work_hours=0) поля времени могут быть пропущены.
 */
export interface ICycleDay {
  work_hours: number;
  work_start?: string;
  work_end?: string;
  lunch_minutes?: number;
}

export interface WorkSchedule {
  id: string;
  name: string;
  schedule_type: ScheduleType;
  work_start: string;
  work_end: string;
  work_hours: number;
  work_days: number[];
  office_days: number[] | null;
  late_threshold_minutes: number;
  day_overrides: Record<string, IDayOverride> | null;
  is_default: boolean;
  lunch_minutes: number;
  respects_holidays: boolean;
  pattern_type: PatternType;
  expected_saturdays_per_month: number;
  full_day_threshold_minutes: number | null;
  weekend_full_day_threshold_minutes: number | null;
  cycle_length: number | null;
  cycle_days: ICycleDay[] | null;
  anchor_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface IEmployeeScheduleAssignment {
  id: string;
  employee_id: number;
  schedule_id: string;
  effective_from: string;
  effective_to: string | null;
  anchor_date: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface IObjectScheduleAssignment {
  id: string;
  object_id: string;
  schedule_id: string;
  effective_from: string;
  effective_to: string | null;
  anchor_date: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface IResolvedSchedule {
  schedule_id: string;
  name?: string | null;
  schedule_type: ScheduleType;
  work_start: string;
  work_end: string;
  work_hours: number;
  work_days: number[];
  office_days: number[] | null;
  late_threshold_minutes: number;
  day_overrides: Record<string, IDayOverride> | null;
  lunch_minutes: number;
  respects_holidays: boolean;
  pattern_type: PatternType;
  expected_saturdays_per_month: number;
  full_day_threshold_minutes: number | null;
  weekend_full_day_threshold_minutes: number | null;
  cycle_length: number | null;
  cycle_days: ICycleDay[] | null;
  anchor_date: string | null;
  /** anchor_date конкретного назначения (если задан) перебивает anchor_date паттерна */
  assignment_anchor_date: string | null;
  source: 'object' | 'employee' | 'default';
}

export interface IProductionCalendarMonth {
  year: number;
  month: number;
  norm_days: number;
  norm_hours: number;
  holidays: string[];
  mandatory_holidays: string[];
  pre_holidays: string[];
}

export type TimesheetApprovalStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'returned';
export type TimesheetResponsibleRole = 'primary' | 'backup';
export type TimesheetApprovalEventAction = 'submitted' | 'approved' | 'rejected' | 'returned_to_rework';

export interface TimesheetApproval {
  id: number;
  department_id: string | null;
  manager_employee_id: number | null;
  start_date: string;
  end_date: string;
  status: TimesheetApprovalStatus;
  submitted_by: string | null;
  submitted_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_comment: string | null;
  created_at: string;
  updated_at: string;
}

export interface TimesheetApprovalEvent {
  id: number;
  approval_id: number;
  department_id: string | null;
  start_date: string;
  end_date: string;
  action: TimesheetApprovalEventAction;
  from_status: TimesheetApprovalStatus | null;
  to_status: Exclude<TimesheetApprovalStatus, 'draft'>;
  actor_user_id: string;
  actor_full_name: string | null;
  actor_position_name: string | null;
  comment: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface TimesheetResponsible {
  department_id: string;
  user_id: string;
  role: TimesheetResponsibleRole;
  is_active: boolean;
  full_name: string | null;
  role_code: string | null;
  employee_id: number | null;
}
