import { apiClient } from '../api/client';
import type { SystemRole, EmployeeVariant } from '../types';

interface ApiResponse<T> {
  data: T;
  success: boolean;
}

export type AccessMode = 'none' | 'view' | 'edit';
export type AccessPageSurface = 'page' | 'technical';

export interface PageCatalogItem {
  key: string;
  label: string;
  group_code: string;
  group_label: string;
  surface: AccessPageSurface;
  supports_edit: boolean;
  sort_order: number;
  is_active: boolean;
}

export interface AccessCatalog {
  pages: PageCatalogItem[];
}

export interface RoleAccessProfile {
  role: SystemRole;
  page_access: Record<string, AccessMode>;
}

// Минимальная подпись роли для UI (чат, фильтры списков пользователей).
// Бэк отдаёт это всем authenticated; полный SystemRole — только админам.
export interface RoleLabel {
  code: string;
  name: string;
  is_admin: boolean;
  show_actual_hours: boolean;
}

export interface CreateRoleData {
  code: string;
  name: string;
  description?: string | null;
  is_admin?: boolean;
  employee_variant?: EmployeeVariant | null;
  show_actual_hours?: boolean;
}

export interface UpdateRoleData {
  name: string;
  description?: string | null;
  is_admin?: boolean;
  employee_variant?: EmployeeVariant | null;
  is_active?: boolean;
  show_actual_hours?: boolean;
}

export interface CloneRoleData {
  code: string;
  name: string;
  description?: string | null;
  is_admin?: boolean;
  employee_variant?: EmployeeVariant | null;
  is_active?: boolean;
  show_actual_hours?: boolean;
}

export interface UpdateAccessProfileData {
  page_access: Record<string, AccessMode>;
}

export const rolesService = {
  async getAll(): Promise<SystemRole[]> {
    const res = await apiClient.get<ApiResponse<SystemRole[]>>('/roles');
    return res.data ?? [];
  },

  async getLabels(): Promise<RoleLabel[]> {
    const res = await apiClient.get<ApiResponse<RoleLabel[]>>('/roles/labels');
    return res.data ?? [];
  },

  async getCatalog(): Promise<AccessCatalog> {
    const res = await apiClient.get<ApiResponse<AccessCatalog>>('/roles/catalog');
    return res.data;
  },

  async getAccessProfile(code: string): Promise<RoleAccessProfile> {
    const res = await apiClient.get<ApiResponse<RoleAccessProfile>>(`/roles/${code}/access-profile`);
    return res.data;
  },

  async updateAccessProfile(code: string, data: UpdateAccessProfileData): Promise<void> {
    await apiClient.put(`/roles/${code}/access-profile`, data);
  },

  async create(data: CreateRoleData): Promise<SystemRole> {
    const res = await apiClient.post<ApiResponse<SystemRole>>('/roles', data);
    return res.data;
  },

  async cloneRole(sourceCode: string, data: CloneRoleData): Promise<SystemRole> {
    const res = await apiClient.post<ApiResponse<SystemRole>>(`/roles/${sourceCode}/clone`, data);
    return res.data;
  },

  async update(code: string, data: UpdateRoleData): Promise<SystemRole> {
    const res = await apiClient.put<ApiResponse<SystemRole>>(`/roles/${code}`, data);
    return res.data;
  },

  async deleteRole(code: string): Promise<void> {
    await apiClient.delete(`/roles/${code}`);
  },
};
