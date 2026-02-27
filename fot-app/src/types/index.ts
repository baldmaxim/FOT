export interface INavItem {
  id: string;
  label: string;
  icon: string;
  badge?: number;
}

export interface INavGroup {
  label: string;
  items: INavItem[];
}

export interface IStatCard {
  label: string;
  value: string;
  change?: string;
  changeType?: 'positive' | 'negative';
  iconType: 'blue' | 'green' | 'orange';
}

export interface IActivityItem {
  id: string;
  name: string;
  role: string;
  location: string;
  status: 'in' | 'out' | 'late';
  time: string;
  initials: string;
}

export interface IProgressItem {
  id: string;
  label: string;
  current: number;
  total: number;
}

export interface IQuickAction {
  id: string;
  label: string;
  icon: string;
}

// Auth types - Новая система должностей
export type EmployeePositionType = 'worker' | 'header' | 'admin' | 'super_admin';

// Для обратной совместимости (deprecated, использовать EmployeePositionType)
export type UserRole = EmployeePositionType;

export const POSITION_LABELS: Record<EmployeePositionType, string> = {
  worker: 'Сотрудник',       // Отображается реальная должность из imported_position
  header: 'Руководитель',    // Начальник участка
  admin: 'Администратор',    // Просмотр всех, без изменения прав
  super_admin: 'Супер-админ' // Полный доступ
};

// Deprecated: для обратной совместимости
export const ROLE_LABELS = POSITION_LABELS;

export interface User {
  id: string;
  email: string;
}

export interface UserProfile {
  id: string;
  full_name: string | null;
  organization_id: string | null;
  position_type: EmployeePositionType;    // Заменяет role
  employee_id: number | null;              // Связь с employees
  supervisor_id: string | null;            // ID руководителя
  imported_position: string | null;        // Должность из импорта (для worker)
  is_approved: boolean;
  two_factor_enabled: boolean;
  created_at: string;
}

export interface AuthState {
  user: User | null;
  profile: UserProfile | null;
  isAuthenticated: boolean;
  isApproved: boolean;
  isTwoFactorEnabled: boolean;
  isTwoFactorVerified: boolean;
  positionType: EmployeePositionType | null;  // Заменяет role
  loading: boolean;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

// Регистрация: email + пароль + ФИО
export interface RegisterData {
  email: string;
  password: string;
  full_name: string;
  organization_id?: string;
}

export interface TwoFactorData {
  secret: string;
  qrCode: string;
  recoveryCodes: string[];
}

// Employee types
export interface Employee {
  id: number;
  organization_id: string;
  full_name: string;
  full_name_encrypted: string;
  last_name: string | null;
  first_name: string | null;
  middle_name: string | null;
  position_name: string | null;
  position_id: string | null;
  hire_date: string;
  birth_date: string | null;
  current_salary: number | null;
  country: string | null;
  pension_number: string | null;
  patent_issue_date: string | null;
  patent_expiry_date: string | null;
  email: string | null;
  department: string | null;
  org_department_id: string | null;
  employment_status: 'active' | 'fired';
  department_locked: boolean;
  is_archived: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmployeeInput {
  full_name: string;
  hire_date: string;
  birth_date?: string | null;
  current_salary?: number | null;
  country?: string | null;
  pension_number?: string | null;
  patent_issue_date?: string | null;
  patent_expiry_date?: string | null;
  email?: string | null;
  position_id?: string | null;
  org_department_id?: string | null;
}

// Timesheet types
export interface TimesheetEntry {
  id: number;
  employee_id: number;
  date: string;
  status: 'present' | 'absent' | 'vacation' | 'sick' | 'business_trip';
  hours_worked: number | null;
  notes: string | null;
}

// SKUD types
export interface SkudEvent {
  id: number;
  physical_person: string;
  card_number: string;
  event_time: string;
  event_date: string;
  access_point: string | null;
  direction: string | null;
}

export interface IEmployeePresence {
  employee_id: number;
  full_name: string;
  department_name: string | null;
  position_name: string | null;
  status: 'online' | 'offline' | 'unknown';
  since: string | null;
  first_entry: string | null;
  total_hours: number | null;
  exit_count: number;
  time_outside_minutes: number;
}

export interface SkudDailySummary {
  id: number;
  employee_id: number;
  date: string;
  first_entry: string | null;
  last_exit: string | null;
  total_hours: number | null;
  is_present: boolean;
}

export interface IAccessPointSetting {
  access_point_name: string;
  is_internal: boolean;
}

// Organization types
export interface Organization {
  id: string;
  name: string;
  parent_organization_id: string | null;
  created_at: string;
}

// Admin types
export interface PendingUser {
  id: string;
  email: string;
  full_name: string | null;
  created_at: string;
  position_type: EmployeePositionType;
  organization_id: string | null;
  organization_name: string | null;
}

// Структура организации - Отдел
export interface OrgDepartment {
  id: string;
  organization_id: string;
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

// Ответ API структуры
export interface OrgStructureResponse {
  departments: OrgDepartmentNode[];
  stats: {
    departments: number;
  };
}

// ============================================
// Новые типы для расширенной архитектуры
// ============================================

// Системная роль (права доступа) - заменяет ENUM position_type
export interface SystemRole {
  id: string;
  code: string;                // 'worker', 'header', 'admin', 'super_admin'
  name: string;                // 'Сотрудник', 'Руководитель'
  description: string | null;
  permissions: string[];       // ['view_own', 'manage_timesheet', ...]
  level: number;               // Уровень для сортировки
  is_active: boolean;
  is_system: boolean;          // Системная роль - нельзя удалить
  created_at: string;
  updated_at: string;
}

// Строительный участок
export interface OrgSite {
  id: string;
  organization_id: string;
  department_id: string | null;
  name: string;
  code: string | null;
  description: string | null;
  address: string | null;
  manager_id: number | null;
  start_date: string | null;
  planned_end_date: string | null;
  status: 'planning' | 'active' | 'completed' | 'suspended';
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

// Справочник должностей
export interface Position {
  id: string;
  organization_id: string;
  name: string;
  category: 'worker' | 'engineer' | 'manager' | 'admin' | 'other' | null;
  grade: number | null;
  sigur_position_id: number | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

// Тип назначения
export type AssignmentType = 'main' | 'secondary' | 'temp' | 'part_time';

// Назначение сотрудника
export interface EmployeeAssignment {
  id: string;
  employee_id: number;
  org_department_id: string | null;
  org_site_id: string | null;
  position_id: string | null;
  effective_from: string;
  effective_to: string | null;
  is_primary: boolean;
  assignment_type: AssignmentType;
  change_reason: string | null;
  order_number: string | null;
  order_date: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// Назначение с расшифрованными названиями
export interface EmployeeAssignmentWithNames extends EmployeeAssignment {
  department_name: string | null;
  site_name: string | null;
  position_name: string | null;
  position_category: string | null;
}

// Input для создания назначения
export interface EmployeeAssignmentInput {
  org_department_id?: string | null;
  org_site_id?: string | null;
  position_id?: string | null;
  effective_from: string;
  is_primary?: boolean;
  assignment_type?: AssignmentType;
  change_reason?: string;
  order_number?: string;
  order_date?: string;
  notes?: string;
}

// История зарплаты (расширенная)
export interface SalaryHistoryEntry {
  id: number;
  employee_id: number;
  salary: number;               // расшифрованная
  effective_date: string;
  note: string | null;
  change_reason: string | null;
  order_number: string | null;
  order_date: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string | null;
}

// Input для создания записи зарплаты
export interface SalaryHistoryInput {
  salary: number;
  effective_date: string;
  note?: string;
  change_reason?: string;
  order_number?: string;
  order_date?: string;
}

// Расширенный Employee с текущими данными из VIEW
export interface EmployeeCurrent extends Employee {
  // Из employee_assignments
  assignment_id: string | null;
  assignment_from: string | null;
  assignment_type: AssignmentType | null;

  // Названия из справочников
  site: string | null;
  org_site_id: string | null;
  position_name: string | null;
  position_id: string | null;
  position_category: string | null;

  // Количество активных назначений
  active_assignments_count: number;

  // Все назначения (для множественных)
  all_assignments: EmployeeAssignmentWithNames[] | null;
}

// Событие истории сотрудника
export interface EmployeeHistoryEvent {
  employee_id: number;
  event_type: 'assignment' | 'salary';
  event_id: string;
  event_date: string;
  event_end_date: string | null;
  event_data: Record<string, unknown>;
  created_at: string;
  created_by: string | null;
}

// Dashboard analytics
export interface IPeriodStats {
  avgPresent: number;
  avgAbsent: number;
  attendanceRate: number;
  lateCount: number;
  prevLateCount: number;
}

export type DashboardPeriod = 'today' | 'week' | 'month';

export interface IDashboardStats {
  lateToday: number;
  lateYesterday: number;
  punctuality: { onTime: number; slightlyLate: number; veryLate: number; absent: number };
  avgArrivalByDay: Array<{ day: string; avgTime: string | null; date: string }>;
  risks: Array<{ employee_id: number; full_name: string; reason: string; severity: 'high' | 'medium' }>;
  hourlyActivity: Array<{ hour: number; count: number }>;
  weekComparison: {
    thisWeek: { attendanceRate: number; avgArrival: string; avgHours: number; lateCount: number };
    lastWeek: { attendanceRate: number; avgArrival: string; avgHours: number; lateCount: number };
  } | null;
  topLate: Array<{ employee_id: number; full_name: string; lateCount: number; avgArrival: string }>;
  periodStats: IPeriodStats | null;
}

// Элемент дерева организационной структуры
export type OrgUnitType = 'department' | 'site';

export interface OrgStructureUnit {
  id: string;
  organization_id: string;
  unit_type: OrgUnitType;
  name: string;
  description: string | null;
  parent_id: string | null;
  sort_order: number;
  is_active: boolean;
  employee_count: number;
}
