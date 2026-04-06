import { apiClient } from './client';
import type {
  OrgDepartment,
  OrgStructureResponse,
} from '../types';

interface ApiResponse<T> {
  data?: T;
  message?: string;
  error?: string;
}

export const structureApi = {
  async getTree(): Promise<ApiResponse<OrgStructureResponse>> {
    try {
      const res = await apiClient.get<ApiResponse<OrgStructureResponse>>('/structure');
      return { data: res.data, message: res.message || 'ok' };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'Ошибка загрузки структуры',
      };
    }
  },

  async createDepartment(
    name: string,
    description?: string,
    parentId?: string | null,
  ): Promise<ApiResponse<OrgDepartment>> {
    try {
      const res = await apiClient.post<ApiResponse<OrgDepartment>>('/structure/departments', {
        name,
        parent_id: parentId || null,
        description,
      });
      return { data: res.data, message: res.message || 'ok' };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'Ошибка создания отдела',
      };
    }
  },

  async clearStructure(): Promise<ApiResponse<{ employeesDeleted: number; departmentsDeleted: number }>> {
    try {
      const res = await apiClient.delete<ApiResponse<{ employeesDeleted: number; departmentsDeleted: number }>>('/structure/clear');
      return { data: res.data, message: res.message || 'ok' };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'Ошибка очистки структуры',
      };
    }
  },

  async deleteDepartment(id: string): Promise<ApiResponse<void>> {
    try {
      await apiClient.delete(`/structure/departments/${id}`);
      return { message: 'ok' };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'Ошибка удаления отдела',
      };
    }
  },

  async getPositions(): Promise<ApiResponse<Array<{ id: string; name: string }>>> {
    try {
      const res = await apiClient.get<ApiResponse<Array<{ id: string; name: string }>>>('/structure/positions');
      return { data: res.data };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'Ошибка загрузки должностей',
      };
    }
  },
};
