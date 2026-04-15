import { apiClient } from '../api/client';
import type { SystemRole } from '../types';

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
  requires_data_scope: boolean;
  requires_employee_variant: boolean;
  sort_order: number;
  is_active: boolean;
  is_system: boolean;
}

export interface PermissionOption {
  code: string;
  label: string;
  description: string;
  sort_order: number;
}

export interface PermissionGroup {
  code: string;
  label: string;
  description: string;
  exclusive: boolean;
  sort_order: number;
  options: PermissionOption[];
}

export interface AccessCatalog {
  pages: PageCatalogItem[];
  capabilities: PermissionGroup[];
}

export interface RoleAccessProfile {
  role: SystemRole;
  permissions: string[];
  page_access: Record<string, AccessMode>;
}

export interface CreateRoleData {
  code: string;
  name: string;
  description?: string | null;
  level: number;
  permissions?: string[];
}

export interface UpdateRoleData {
  name: string;
  description?: string | null;
  level: number;
  is_active?: boolean;
  permissions?: string[];
}

export interface CloneRoleData {
  code: string;
  name: string;
  description?: string | null;
  level?: number;
  is_active?: boolean;
}

export interface UpdateAccessProfileData {
  permissions: string[];
  page_access: Record<string, AccessMode>;
}

export const rolesService = {
  async getAll(): Promise<SystemRole[]> {
    const res = await apiClient.get<ApiResponse<SystemRole[]>>('/roles');
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
