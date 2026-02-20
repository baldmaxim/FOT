import { apiClient } from './client';
import type {
  OrgDepartment,
  OrgStructureResponse,
} from '../types';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

const orgQuery = (orgId?: string) => orgId ? `?organization_id=${orgId}` : '';

export const structureApi = {
  async getTree(organizationId?: string): Promise<ApiResponse<OrgStructureResponse>> {
    try {
      return await apiClient.get<ApiResponse<OrgStructureResponse>>(`/structure${orgQuery(organizationId)}`);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка загрузки структуры',
      };
    }
  },

  async createDepartment(
    name: string,
    description?: string,
    organizationId?: string,
    parentId?: string | null,
  ): Promise<ApiResponse<OrgDepartment>> {
    try {
      return await apiClient.post<ApiResponse<OrgDepartment>>(`/structure/departments${orgQuery(organizationId)}`, {
        name,
        parent_id: parentId || null,
        description,
      });
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка создания отдела',
      };
    }
  },

  async deleteDepartment(id: string, organizationId?: string): Promise<ApiResponse<void>> {
    try {
      return await apiClient.delete<ApiResponse<void>>(`/structure/departments/${id}${orgQuery(organizationId)}`);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка удаления отдела',
      };
    }
  },
};
