export type EmployeePositionType = string;
export type ChatInboundMode = 'open' | 'requests_only' | 'disabled';
export type EmployeeVariant = 'object' | 'office';

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
  employee_id: number | null;
  department_id: string | null;
  managed_department_ids: string[];
  supervisor_id: string | null;
  chat_inbound_mode: ChatInboundMode;
  imported_position: string | null;
  page_access: PageAccessMap;
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
