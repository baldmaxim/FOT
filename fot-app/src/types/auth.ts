// Auth types - Новая система должностей
export type EmployeePositionType = 'worker' | 'header' | 'hr' | 'admin' | 'super_admin';

// Для обратной совместимости (deprecated, использовать EmployeePositionType)
export type UserRole = EmployeePositionType;

export const POSITION_LABELS: Record<EmployeePositionType, string> = {
  worker: 'Сотрудник',       // Отображается реальная должность из imported_position
  header: 'Руководитель',    // Начальник участка
  hr: 'Отдел кадров',        // Проверка табелей, документы, расчётные листки
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
  department_id: string | null;            // org_department_id сотрудника
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
