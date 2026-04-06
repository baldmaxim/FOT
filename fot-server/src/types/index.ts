import { Request } from 'express';

// Тип должности (динамический, хранится в system_roles)
export type EmployeePositionType = string;

// Для обратной совместимости
export type UserRole = EmployeePositionType;

// Системная роль
export interface SystemRole {
  id: string;
  code: string;
  name: string;
  description: string | null;
  permissions: string[];
  level: number;
  is_active: boolean;
  is_system: boolean;
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

// Профиль пользователя
export interface UserProfile {
  id: string;
  full_name: string | null;
  position_type: EmployeePositionType;    // Заменяет role
  employee_id: number | null;              // Связь с employees (заполняется админом)
  supervisor_id: string | null;            // ID руководителя
  imported_position: string | null;        // Должность из импорта
  is_approved: boolean;
  approved_by: string | null;
  approved_at: string | null;
  totp_secret: string | null;
  recovery_codes: string[] | null;
  two_factor_enabled: boolean;
  created_at: string;
  updated_at: string;
}

// Расширенный Request с информацией о пользователе
export interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
    position_type: EmployeePositionType;  // Заменяет role
    employee_id: number | null;
    department_id: string | null;         // org_department_id сотрудника
    is_approved: boolean;
    two_factor_enabled: boolean;
    two_factor_verified: boolean;
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
  created_at: string;
  updated_at: string;
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
  created_at: string;
  updated_at: string;
}

// История зарплаты в БД
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

// Табель
export type TimeStatus = 'work' | 'vacation' | 'dayoff' | 'remote' | 'unpaid' | 'absent' | 'sick' | 'business_trip' | 'manual';

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

// СКУД события в БД
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

// СКУД дневная сводка
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

// Аудит логи
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

// API ответы
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// JWT Payload
export interface JWTPayload {
  sub: string; // user id
  email: string;
  position_type: EmployeePositionType;  // Заменяет role
  employee_id: number | null;
  department_id: string | null;          // org_department_id сотрудника
  is_approved: boolean;
  two_factor_enabled: boolean;
  two_factor_verified: boolean;
  iat: number;
  exp: number;
}

// Структура - Отдел в БД
export interface OrgDepartmentEncrypted {
  id: string;
  parent_id: string | null;
  sigur_department_id: number | null;
  name: string;
  description: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// Структура - Отдел для API
export interface OrgDepartment {
  id: string;
  parent_id: string | null;
  sigur_department_id: number | null;
  name: string;
  description: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// Узел дерева отделов (рекурсивный)
export interface OrgDepartmentNode extends OrgDepartment {
  children: OrgDepartmentNode[];
}

// Полная структура для дерева
export interface OrgStructureTree {
  departments: OrgDepartmentNode[];
}

// Типы заявлений
export type LeaveRequestType = 'vacation' | 'sick_leave' | 'remote' | 'dayoff' | 'business_trip' | 'certificate';
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

// Документы (R2)
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

// Расчётные листки
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

// Выплаты
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

// Графики работы
export type ScheduleType = 'office' | 'remote' | 'hybrid' | 'shift';

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
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface DepartmentSchedule {
  id: string;
  department_id: string;
  schedule_id: string;
  effective_from: string;
  effective_to: string | null;
  created_by: number | null;
  created_at: string;
}

export interface EmployeeSchedule {
  id: string;
  employee_id: number;
  schedule_id: string;
  effective_from: string;
  effective_to: string | null;
  reason: string | null;
  created_by: number | null;
  created_at: string;
}

export interface IResolvedSchedule {
  schedule_id: string;
  schedule_type: ScheduleType;
  work_start: string;
  work_end: string;
  work_hours: number;
  work_days: number[];
  office_days: number[] | null;
  late_threshold_minutes: number;
  source: 'employee' | 'department' | 'default';
}

// Согласование табелей
export type TimesheetApprovalStatus = 'draft' | 'submitted' | 'approved' | 'rejected';

export interface TimesheetApproval {
  id: number;
  department_id: string;
  period: string;
  status: TimesheetApprovalStatus;
  submitted_by: string | null;
  submitted_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_comment: string | null;
  created_at: string;
  updated_at: string;
}
