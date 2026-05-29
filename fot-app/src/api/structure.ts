import { apiClient } from './client';
import type {
  OrgDepartment,
  OrgDepartmentKind,
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
    kind?: OrgDepartmentKind,
  ): Promise<ApiResponse<OrgDepartment>> {
    try {
      const res = await apiClient.post<ApiResponse<OrgDepartment>>('/structure/departments', {
        name,
        parent_id: parentId || null,
        description,
        kind,
      });
      return { data: res.data, message: res.message || 'ok' };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'Ошибка создания отдела',
      };
    }
  },

  async updateDepartment(
    id: string,
    payload: { name?: string; parent_id?: string | null; kind?: OrgDepartmentKind; is_current_activity?: boolean },
  ): Promise<ApiResponse<OrgDepartment>> {
    try {
      const res = await apiClient.put<ApiResponse<OrgDepartment>>(`/structure/departments/${id}`, payload);
      return { data: res.data, message: res.message || 'ok' };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'Ошибка обновления отдела',
      };
    }
  },

  async batchMoveDepartments(
    departmentIds: string[],
    parentId: string | null,
  ): Promise<ApiResponse<{ moved_count: number; skipped_count: number; moved_ids: string[]; skipped_ids: string[]; parent_id: string | null }>> {
    try {
      const res = await apiClient.post<ApiResponse<{ moved_count: number; skipped_count: number; moved_ids: string[]; skipped_ids: string[]; parent_id: string | null }>>('/structure/departments/batch-move', {
        department_ids: departmentIds,
        parent_id: parentId,
      });
      return { data: res.data, message: res.message || 'ok' };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'Ошибка перемещения отделов',
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

  async deleteDepartmentRecursive(id: string): Promise<ApiResponse<{ deleted_count: number; deleted_department_ids: string[]; target_parent_id: string | null }>> {
    try {
      const res = await apiClient.delete<ApiResponse<{ deleted_count: number; deleted_department_ids: string[]; target_parent_id: string | null }>>(`/structure/departments/${id}/recursive`);
      return { data: res.data, message: res.message || 'ok' };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'Ошибка рекурсивного удаления отдела',
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
