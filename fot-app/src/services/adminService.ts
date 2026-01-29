import { apiClient } from '../api/client';
import type { PendingUser, TwoFactorData, EmployeePositionType, Organization } from '../types';

interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

interface UserFromApi {
  id: string;
  full_name: string | null;
  organization_id: string | null;
  organization_name: string | null;
  position_type: EmployeePositionType;
  is_approved: boolean;
  two_factor_enabled: boolean;
  approved_at: string | null;
  created_at: string;
}

interface UserWithProfile {
  id: string;
  email: string;
  profile: {
    id: string;
    full_name: string | null;
    organization_id: string | null;
    position_type: EmployeePositionType;
    is_approved: boolean;
    two_factor_enabled: boolean;
    created_at: string;
  };
}

export const adminService = {
  // User management
  async getPendingUsers(): Promise<PendingUser[]> {
    const response = await apiClient.get<ApiResponse<PendingUser[]>>('/admin/users/pending');
    return response.data || [];
  },

  async getAllUsers(): Promise<UserWithProfile[]> {
    const response = await apiClient.get<ApiResponse<UserFromApi[]>>('/admin/users');
    // Преобразуем формат для фронтенда
    return (response.data || []).map(user => ({
      id: user.id,
      email: '', // Email не возвращается из API для безопасности
      profile: {
        id: user.id,
        full_name: user.full_name,
        organization_id: user.organization_id,
        position_type: user.position_type,
        is_approved: user.is_approved,
        two_factor_enabled: user.two_factor_enabled,
        created_at: user.created_at,
      },
    }));
  },

  async approveUser(userId: string): Promise<void> {
    await apiClient.post(`/admin/users/${userId}/approve`);
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
