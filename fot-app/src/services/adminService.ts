import { apiClient } from '../api/client';
import type { ChatInboundMode, TwoFactorData, EmployeePositionType } from '../types';

interface ApiResponse<T> {
  data: T;
  message?: string;
}

interface UserFromApi {
  id: string;
  email?: string;
  email_confirmed?: boolean;
  full_name: string | null;
  assigned_department_ids: string[];
  position_type: EmployeePositionType;
  imported_position: string | null;
  employee_id: number | null;
  supervisor_id: string | null;
  chat_inbound_mode: ChatInboundMode;
  is_approved: boolean;
  two_factor_enabled: boolean;
  approved_at: string | null;
  created_at: string;
}

export interface IUserSlim {
  id: string;
  full_name: string | null;
  email?: string;
  employee_id: number | null;
}

export interface IUsersPaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  roleCounts: Record<string, number>;
}

interface PendingUserFromApi {
  id: string;
  email: string;
  full_name: string | null;
  position_type: EmployeePositionType;
  imported_position: string | null;
  created_at: string;
}

export interface IPasswordResetRequest {
  id: string;
  email: string;
  full_name: string | null;
  expires_at: string;
}

export interface EmployeeDepartmentAssignmentFromApi {
  employee_id: number;
  full_name: string;
  assigned_department_ids: string[];
  /** Подмножество assigned_department_ids с уровнем «только просмотр» (миграция 167). */
  view_only_department_ids?: string[];
  position_name?: string | null;
  department_name?: string | null;
  direct_manager_employee_id?: number | null;
  direct_manager_full_name?: string | null;
  /** Есть ли над сотрудником ответственный: индивидуальный руководитель или начальник его отдела. */
  has_responsible?: boolean;
}

/** Сотрудник, назначенный на бригаду/отдел (обратное представление назначений). */
export interface IBrigadeAssignedEmployee {
  employee_id: number;
  full_name: string;
  position_name: string | null;
  employment_status: string;
  excluded_from_timesheet: boolean;
  access_level: 'full' | 'view';
}

/** Карты назначений «сущность → объекты входа» (id объектов). */
export interface IObjectAssignments {
  department_objects: Record<string, string[]>;
  employee_objects: Record<string, string[]>;
}

export const adminService = {
  // User management
  async getPendingUsers(): Promise<PendingUserFromApi[]> {
    const response = await apiClient.get<ApiResponse<PendingUserFromApi[]>>('/admin/users/pending');
    return response.data || [];
  },

  async getAllUsers(): Promise<UserFromApi[]> {
    const response = await apiClient.get<ApiResponse<UserFromApi[]>>('/admin/users');
    return response.data || [];
  },

  async getAllUsersSlim(): Promise<IUserSlim[]> {
    const response = await apiClient.get<ApiResponse<IUserSlim[]>>('/admin/users?slim=1');
    return response.data || [];
  },

  async getAllUsersCount(): Promise<number> {
    const response = await apiClient.get<{ success: boolean; count: number }>(
      '/admin/users?countOnly=1',
    );
    return response.count ?? 0;
  },

  async getUsersPaginated(params: {
    page: number;
    pageSize: number;
    search?: string;
    role?: string;
  }): Promise<{ data: UserFromApi[]; meta: IUsersPaginationMeta }> {
    const qs = new URLSearchParams({
      page: String(params.page),
      pageSize: String(params.pageSize),
      ...(params.search ? { search: params.search } : {}),
      ...(params.role ? { role: params.role } : {}),
    }).toString();
    const response = await apiClient.get<
      ApiResponse<UserFromApi[]> & { meta: IUsersPaginationMeta }
    >(`/admin/users?${qs}`);
    return { data: response.data || [], meta: response.meta };
  },

  async getEmployeeDepartmentAssignments(): Promise<EmployeeDepartmentAssignmentFromApi[]> {
    const response = await apiClient.get<ApiResponse<EmployeeDepartmentAssignmentFromApi[]>>('/admin/employees/department-access');
    return response.data || [];
  },

  async getDepartmentAssignedEmployees(departmentId: string): Promise<IBrigadeAssignedEmployee[]> {
    const response = await apiClient.get<ApiResponse<IBrigadeAssignedEmployee[]>>(
      `/admin/departments/${encodeURIComponent(departmentId)}/assigned-employees`,
    );
    return response.data || [];
  },

  async approveUser(userId: string, options: { position_type: EmployeePositionType; employee_id?: number }): Promise<void> {
    await apiClient.post(`/admin/users/${userId}/approve`, options);
  },

  async rejectUser(userId: string): Promise<void> {
    await apiClient.post(`/admin/users/${userId}/reject`);
  },

  async deleteUser(userId: string): Promise<void> {
    await apiClient.delete(`/admin/users/${userId}`);
  },

  async confirmUserEmail(userId: string): Promise<void> {
    await apiClient.post(`/admin/users/${userId}/confirm-email`);
  },

  async generatePasswordResetLink(userId: string): Promise<{ resetUrl: string; expiresAt: string }> {
    const response = await apiClient.post<{ success: boolean; resetUrl: string; expiresAt: string }>(
      `/admin/users/${userId}/reset-link`,
    );
    return { resetUrl: response.resetUrl, expiresAt: response.expiresAt };
  },

  async getPasswordResetRequests(): Promise<IPasswordResetRequest[]> {
    const response = await apiClient.get<ApiResponse<IPasswordResetRequest[]>>(
      '/admin/users/password-reset-requests',
    );
    return response.data || [];
  },

  async peekUser(userId: string): Promise<{
    id: string;
    full_name: string | null;
    email: string | null;
    position_type: EmployeePositionType | null;
  }> {
    const response = await apiClient.get<ApiResponse<{
      id: string;
      full_name: string | null;
      email: string | null;
      position_type: EmployeePositionType | null;
    }>>(`/admin/users/${userId}/peek`);
    return response.data;
  },

  async updateUserPosition(userId: string, positionType: EmployeePositionType): Promise<void> {
    await apiClient.patch(`/admin/users/${userId}/position`, { position_type: positionType });
  },

  async updateUserName(userId: string, fullName: string): Promise<void> {
    await apiClient.patch(`/admin/users/${userId}/name`, { full_name: fullName });
  },

  async updateUserChatInboundMode(userId: string, chatInboundMode: ChatInboundMode): Promise<void> {
    await apiClient.patch(`/admin/users/${userId}/chat-inbound-mode`, { chat_inbound_mode: chatInboundMode });
  },

  async updateUserEmployee(userId: string, employeeId: number | null): Promise<void> {
    await apiClient.patch(`/admin/users/${userId}/employee`, { employee_id: employeeId });
  },

  async updateUserDepartmentAccess(
    userId: string,
    departmentIds: string[],
    viewOnlyDepartmentIds: string[] = [],
  ): Promise<{ assigned_department_ids: string[] }> {
    const response = await apiClient.put<ApiResponse<{ assigned_department_ids: string[] }>>(
      `/admin/users/${userId}/department-access`,
      { department_ids: departmentIds, view_only_department_ids: viewOnlyDepartmentIds },
    );
    return response.data;
  },

  async updateEmployeeDepartmentAccess(
    employeeId: number,
    departmentIds: string[],
    viewOnlyDepartmentIds: string[] = [],
  ): Promise<{ assigned_department_ids: string[] }> {
    const response = await apiClient.put<ApiResponse<{ assigned_department_ids: string[] }>>(
      `/admin/employees/${employeeId}/department-access`,
      { department_ids: departmentIds, view_only_department_ids: viewOnlyDepartmentIds },
    );
    return response.data;
  },

  async listSkudObjectsForAssignment(): Promise<Array<{ id: string; name: string; alt_name: string | null }>> {
    const response = await apiClient.get<ApiResponse<Array<{ id: string; name: string; alt_name: string | null }>>>(
      '/admin/skud-objects',
    );
    return response.data;
  },

  async getEmployeeSkudObjects(employeeId: number): Promise<{ object_ids: string[] }> {
    const response = await apiClient.get<ApiResponse<{ object_ids: string[] }>>(
      `/admin/employees/${employeeId}/skud-objects`,
    );
    return response.data;
  },

  async updateEmployeeSkudObjectAccess(employeeId: number, objectIds: string[]): Promise<{ object_ids: string[] }> {
    const response = await apiClient.put<ApiResponse<{ object_ids: string[] }>>(
      `/admin/employees/${employeeId}/skud-objects`,
      { object_ids: objectIds },
    );
    return response.data;
  },

  async updateUserEmployeeAccess(userId: string, employeeIds: number[]): Promise<{ assigned_employee_ids: number[] }> {
    const response = await apiClient.put<ApiResponse<{ assigned_employee_ids: number[] }>>(
      `/admin/users/${userId}/employee-access`,
      { employee_ids: employeeIds },
    );
    return response.data;
  },

  // ─── Привязка администраторов к «компаниям» (корневым узлам Sigur) ───
  async listCompanies(): Promise<Array<{ id: string; name: string }>> {
    const response = await apiClient.get<ApiResponse<Array<{ id: string; name: string }>>>('/admin/companies');
    return response.data || [];
  },

  async getUserCompanies(userId: string): Promise<{ company_root_ids: string[]; is_system_admin: boolean }> {
    const response = await apiClient.get<ApiResponse<{ company_root_ids: string[]; is_system_admin: boolean }>>(
      `/admin/users/${userId}/companies`,
    );
    return response.data || { company_root_ids: [], is_system_admin: true };
  },

  async replaceUserCompanies(userId: string, companyRootIds: string[]): Promise<{ company_root_ids: string[]; is_system_admin: boolean }> {
    const response = await apiClient.put<ApiResponse<{ company_root_ids: string[]; is_system_admin: boolean }>>(
      `/admin/users/${userId}/companies`,
      { company_root_ids: companyRootIds },
    );
    return response.data;
  },

  // 2FA management
  async generate2FA(userId: string): Promise<TwoFactorData> {
    const response = await apiClient.post<ApiResponse<{ secret: string; qr_code: string; recovery_codes: string[] }>>(`/admin/users/${userId}/generate-2fa`);
    return {
      secret: response.data.secret,
      qrCode: response.data.qr_code,
      recoveryCodes: response.data.recovery_codes,
    };
  },

  async disable2FA(userId: string): Promise<void> {
    await apiClient.post(`/admin/users/${userId}/disable-2fa`);
  },

  // Employee search (for linking)
  async searchUnlinkedEmployees(query: string): Promise<{ id: number; full_name: string; org_department_id: string | null }[]> {
    const params = new URLSearchParams({ q: query });
    const response = await apiClient.get<ApiResponse<{ id: number; full_name: string; org_department_id: string | null }[]>>(`/admin/employees/search?${params}`);
    return response.data || [];
  },

  async searchAllEmployees(query: string): Promise<{ id: number; full_name: string; org_department_id: string | null }[]> {
    const params = new URLSearchParams({ q: query, include_linked: 'true' });
    const response = await apiClient.get<ApiResponse<{ id: number; full_name: string; org_department_id: string | null }[]>>(`/admin/employees/search?${params}`);
    return response.data || [];
  },

  // ─── Назначение «объектов входа» для скоупа табельщицы (миграция 150) ───
  async getObjectAssignments(): Promise<IObjectAssignments> {
    const response = await apiClient.get<ApiResponse<IObjectAssignments>>('/admin/object-assignments');
    return response.data || { department_objects: {}, employee_objects: {} };
  },

  async updateDepartmentObjectAssignment(departmentId: string, objectIds: string[]): Promise<{ object_ids: string[] }> {
    const response = await apiClient.put<ApiResponse<{ object_ids: string[] }>>(
      `/admin/departments/${departmentId}/object-assignment`,
      { object_ids: objectIds },
    );
    return response.data;
  },

  async updateEmployeeObjectAssignment(employeeId: number, objectIds: string[]): Promise<{ object_ids: string[] }> {
    const response = await apiClient.put<ApiResponse<{ object_ids: string[] }>>(
      `/admin/employees/${employeeId}/object-assignment`,
      { object_ids: objectIds },
    );
    return response.data;
  },

  async getUserTimekeeperObjects(userId: string): Promise<{ object_ids: string[] }> {
    const response = await apiClient.get<ApiResponse<{ object_ids: string[] }>>(
      `/admin/users/${userId}/timekeeper-objects`,
    );
    return response.data || { object_ids: [] };
  },

  async updateUserTimekeeperObjects(userId: string, objectIds: string[]): Promise<{ object_ids: string[] }> {
    const response = await apiClient.put<ApiResponse<{ object_ids: string[] }>>(
      `/admin/users/${userId}/timekeeper-objects`,
      { object_ids: objectIds },
    );
    return response.data;
  },

  async getUserTimekeeperFolders(userId: string): Promise<{ department_ids: string[] }> {
    const response = await apiClient.get<ApiResponse<{ department_ids: string[] }>>(
      `/admin/users/${userId}/timekeeper-folders`,
    );
    return response.data || { department_ids: [] };
  },

  async updateUserTimekeeperFolders(userId: string, departmentIds: string[]): Promise<{ department_ids: string[] }> {
    const response = await apiClient.put<ApiResponse<{ department_ids: string[] }>>(
      `/admin/users/${userId}/timekeeper-folders`,
      { department_ids: departmentIds },
    );
    return response.data;
  },
};
