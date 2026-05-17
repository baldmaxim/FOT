export type EmployeePositionType = string;
export type ChatInboundMode = 'open' | 'requests_only' | 'disabled';
export type EmployeeVariant = 'object' | 'office' | 'contractor';

export type UserRole = EmployeePositionType;

// Системная роль из БД system_roles.
// Поведение роли задано флагами is_admin / employee_variant и матрицей page_access.
export interface SystemRole {
  id: string;
  code: string;
  name: string;
  description: string | null;
  is_admin: boolean;
  employee_variant: EmployeeVariant | null;
  is_active: boolean;
  show_actual_hours: boolean;
  /** true → у пользователей роли скрывается боковое меню. Для is_admin игнорируется. */
  hide_sidebar: boolean;
  /** Окно доступных месяцев табеля: сколько месяцев назад от текущего. Применяется когда is_admin=false. */
  timesheet_months_back: number;
  /** Окно доступных месяцев табеля: сколько месяцев вперёд от текущего. Применяется когда is_admin=false. */
  timesheet_months_forward: number;
  created_at: string;
  updated_at: string;
}

export interface PageAccessPermission {
  can_view: boolean;
  can_edit: boolean;
}

export type PageAccessMap = Record<string, PageAccessPermission>;

export interface User {
  id: string;
  email: string;
}

// Скоуп компаний для админа.
// roots='all' — системный админ, видит всё.
// roots=[]   — обычный пользователь (не is_admin).
// roots=[…] — админ компании, видит только перечисленные корни Sigur и их потомков.
export interface CompanyScope {
  roots: 'all' | string[];
}

export interface UserProfile {
  id: string;
  full_name: string | null;
  system_role_id: string;
  role_code: string;
  role_name: string;
  // Алиас role_code — сохраняем для обратной совместимости UI.
  position_type: EmployeePositionType;
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
  page_access: PageAccessMap;
  is_approved: boolean;
  two_factor_enabled: boolean;
  created_at: string;
  /** undefined для не-admin или для старых сессий до миграции 083 */
  company_scope?: CompanyScope;
}

export interface AuthState {
  user: User | null;
  profile: UserProfile | null;
  isAuthenticated: boolean;
  isApproved: boolean;
  isTwoFactorEnabled: boolean;
  isTwoFactorVerified: boolean;
  positionType: EmployeePositionType | null;
  loading: boolean;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterData {
  email: string;
  password: string;
  full_name: string;
}

export interface TwoFactorData {
  secret: string;
  qrCode: string;
  recoveryCodes: string[];
}

export interface PendingUser {
  id: string;
  email: string;
  full_name: string | null;
  created_at: string;
  position_type: EmployeePositionType;
}
