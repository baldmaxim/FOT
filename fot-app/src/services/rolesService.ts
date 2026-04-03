import { apiClient } from '../api/client';
import type { SystemRole } from '../types';

interface ApiResponse<T> {
  data: T;
  success: boolean;
}

export interface AvailablePage {
  path: string;
  label: string;
}

export interface RolePageAccessEntry {
  id?: string;
  role_code: string;
  page_path: string;
  can_view: boolean;
  can_edit: boolean;
}

export interface CreateRoleData {
  code: string;
  name: string;
  description?: string | null;
  level: number;
}

export interface UpdateRoleData {
  name: string;
  description?: string | null;
  level: number;
  is_active?: boolean;
}

export const rolesService = {
  async getAll(): Promise<SystemRole[]> {
    const res = await apiClient.get<ApiResponse<SystemRole[]>>('/roles');
    return res.data ?? [];
  },

  async create(data: CreateRoleData): Promise<SystemRole> {
    const res = await apiClient.post<ApiResponse<SystemRole>>('/roles', data);
    return res.data;
  },

  async update(code: string, data: UpdateRoleData): Promise<SystemRole> {
    const res = await apiClient.put<ApiResponse<SystemRole>>(`/roles/${code}`, data);
    return res.data;
  },

  async deleteRole(code: string): Promise<void> {
    await apiClient.delete(`/roles/${code}`);
  },

  async getPageAccess(): Promise<RolePageAccessEntry[]> {
    const res = await apiClient.get<ApiResponse<RolePageAccessEntry[]>>('/roles/page-access');
    return res.data ?? [];
  },

  async updatePageAccess(items: RolePageAccessEntry[]): Promise<void> {
    await apiClient.put('/roles/page-access', items);
  },

  async getAvailablePages(): Promise<AvailablePage[]> {
    const res = await apiClient.get<ApiResponse<AvailablePage[]>>('/roles/available-pages');
    return res.data ?? [];
  },
};
