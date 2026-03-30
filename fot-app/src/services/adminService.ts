import { apiClient } from '../api/client';
import type { TwoFactorData, EmployeePositionType, Organization } from '../types';

interface ApiResponse<T> {
  data: T;
  message?: string;
}

interface UserFromApi {
  id: string;
  full_name: string | null;
  organization_id: string | null;
  organization_name: string | null;
  position_type: EmployeePositionType;
  imported_position: string | null;
  employee_id: string | null;
  supervisor_id: string | null;
  is_approved: boolean;
  two_factor_enabled: boolean;
  approved_at: string | null;
  created_at: string;
}

interface PendingUserFromApi {
  id: string;
  email: string;
  full_name: string | null;
  organization_id: string | null;
  organization_name: string | null;
  position_type: EmployeePositionType;
  imported_position: string | null;
  created_at: string;
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

  async approveUser(userId: string, options?: { organization_id?: string; position_type?: EmployeePositionType; employee_id?: number }): Promise<void> {
    await apiClient.post(`/admin/users/${userId}/approve`, options || {});
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

  async updateUserPosition(userId: string, positionType: EmployeePositionType): Promise<void> {
    await apiClient.patch(`/admin/users/${userId}/position`, { position_type: positionType });
  },

  async assignOrganization(userId: string, organizationId: string): Promise<void> {
    await apiClient.patch(`/admin/users/${userId}/organization`, { organization_id: organizationId });
  },

  async updateUserName(userId: string, fullName: string): Promise<void> {
    await apiClient.patch(`/admin/users/${userId}/name`, { full_name: fullName });
  },

  async updateUserEmployee(userId: string, employeeId: number | null, departmentId?: string): Promise<void> {
    await apiClient.patch(`/admin/users/${userId}/employee`, { employee_id: employeeId, department_id: departmentId || null });
  },

  async updateEmployeeDepartment(userId: string, departmentId: string): Promise<void> {
    await apiClient.patch(`/admin/users/${userId}/department`, { department_id: departmentId });
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
  async searchUnlinkedEmployees(query: string, organizationId?: string): Promise<{ id: number; full_name: string; org_department_id: string | null }[]> {
    const params = new URLSearchParams({ q: query });
    if (organizationId) params.set('organization_id', organizationId);
    const response = await apiClient.get<ApiResponse<{ id: number; full_name: string; org_department_id: string | null }[]>>(`/admin/employees/search?${params}`);
    return response.data || [];
  },

  // Organizations
  async getOrganizations(): Promise<Organization[]> {
    const response = await apiClient.get<ApiResponse<Organization[]>>('/admin/organizations');
    return response.data || [];
  },

  async getOrganizationsWithStats(): Promise<(Organization & { member_count?: number })[]> {
    const response = await apiClient.get<ApiResponse<(Organization & { member_count?: number })[]>>('/admin/organizations');
    return response.data || [];
  },

  async createOrganization(name: string): Promise<Organization> {
    const response = await apiClient.post<ApiResponse<Organization>>('/admin/organizations', { name });
    return response.data;
  },

  async updateOrganization(id: string, name: string): Promise<Organization> {
    const response = await apiClient.patch<ApiResponse<Organization>>(`/admin/organizations/${id}`, { name });
    return response.data;
  },

  async deleteOrganization(id: string): Promise<void> {
    await apiClient.delete(`/admin/organizations/${id}`);
  },
};
