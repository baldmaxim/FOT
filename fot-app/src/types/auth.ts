// Тип должности (динамический, из system_roles)
export type EmployeePositionType = string;
export type ChatInboundMode = 'open' | 'requests_only' | 'disabled';

// Для обратной совместимости (deprecated)
export type UserRole = EmployeePositionType;

// Системная роль (из БД system_roles)
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
  position_type: EmployeePositionType;    // Заменяет role
  system_role_id?: string | null;
  employee_id: number | null;              // Связь с employees
  department_id: string | null;            // org_department_id сотрудника
  supervisor_id: string | null;            // ID руководителя
  chat_inbound_mode: ChatInboundMode;
  imported_position: string | null;        // Должность из импорта (для worker)
  permissions: string[];
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
}

export interface TwoFactorData {
  secret: string;
  qrCode: string;
  recoveryCodes: string[];
}

// Admin types
export interface PendingUser {
  id: string;
  email: string;
  full_name: string | null;
  created_at: string;
  position_type: EmployeePositionType;
}
