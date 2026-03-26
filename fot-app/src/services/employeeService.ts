import { apiClient } from '../api/client';
import type { Employee, EmployeeInput, EmployeeHistoryEvent, EnrichPreview, EnrichResult } from '../types';

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

interface ImportResult {
  imported: number;
  errors: string[];
}

export interface PaginatedParams {
  page: number;
  pageSize?: number;
  search?: string;
  status?: 'active' | 'fired';
  departmentId?: string;
  archived?: boolean;
}

export interface PaginatedMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface EmployeeCounts {
  byDepartment: Record<string, number>;
  byStatus: { active: number; fired: number };
}

export interface PaginatedResponse {
  data: Employee[];
  meta: PaginatedMeta;
  counts: EmployeeCounts;
}

export const employeeService = {
  async getAll(params?: { organizationId?: string; departmentId?: string; archived?: boolean; view?: 'list' }): Promise<Employee[]> {
    const qs = new URLSearchParams();
    if (params?.organizationId) qs.set('organization_id', params.organizationId);
    if (params?.departmentId) qs.set('department_id', params.departmentId);
    if (params?.archived) qs.set('archived', 'true');
    if (params?.view) qs.set('view', params.view);
    const query = qs.toString() ? `?${qs}` : '';
    const response = await apiClient.get<ApiResponse<Employee[]>>(`/employees${query}`);
    return response.data || [];
  },

  async getPaginated(params: PaginatedParams): Promise<PaginatedResponse> {
    const qs = new URLSearchParams();
    qs.set('page', String(params.page));
    qs.set('view', 'list');
    if (params.pageSize) qs.set('pageSize', String(params.pageSize));
    if (params.search) qs.set('search', params.search);
    if (params.status) qs.set('status', params.status);
    if (params.departmentId) qs.set('department_id', params.departmentId);
    if (params.archived) qs.set('archived', 'true');
    const response = await apiClient.get<{ success: boolean; data: Employee[]; meta: PaginatedMeta; counts: EmployeeCounts }>(`/employees?${qs}`);
    return { data: response.data || [], meta: response.meta || { page: 1, pageSize: 50, total: 0, totalPages: 0 }, counts: response.counts || { byDepartment: {}, byStatus: { active: 0, fired: 0 } } };
  },

  async getById(id: number): Promise<Employee> {
    const response = await apiClient.get<ApiResponse<Employee>>(`/employees/${id}`);
    return response.data;
  },

  async create(data: EmployeeInput): Promise<Employee> {
    const response = await apiClient.post<ApiResponse<Employee>>('/employees', data);
    return response.data;
  },

  async update(id: number, data: Partial<EmployeeInput>): Promise<Employee> {
    const response = await apiClient.put<ApiResponse<Employee>>(`/employees/${id}`, data);
    return response.data;
  },

  async delete(id: number): Promise<void> {
    await apiClient.delete(`/employees/${id}`);
  },

  async archive(id: number): Promise<Employee> {
    const response = await apiClient.post<ApiResponse<Employee>>(`/employees/${id}/archive`);
    return response.data;
  },

  async restore(id: number): Promise<Employee> {
    const response = await apiClient.post<ApiResponse<Employee>>(`/employees/${id}/restore`);
    return response.data;
  },

  async import(file: File): Promise<ImportResult> {
    const formData = new FormData();
    formData.append('file', file);

    const response = await apiClient.post<ApiResponse<ImportResult>>('/employees/import', formData);
    return response.data;
  },

  async export(): Promise<Blob> {
    const response = await fetch(
      `${import.meta.env.VITE_API_URL || 'http://localhost:3000/api'}/employees/export`,
      {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('access_token')}`,
        },
      }
    );

    if (!response.ok) {
      throw new Error('Ошибка экспорта');
    }

    return response.blob();
  },

  async getHistory(id: number): Promise<EmployeeHistoryEvent[]> {
    const response = await apiClient.get<ApiResponse<EmployeeHistoryEvent[]>>(`/employees/${id}/history`);
    return response.data || [];
  },

  async deleteAll(): Promise<{ deleted: number }> {
    const response = await apiClient.delete<ApiResponse<{ deleted: number }>>('/employees/all');
    return response.data;
  },

  async fire(id: number): Promise<Employee> {
    const response = await apiClient.post<ApiResponse<Employee>>(`/employees/${id}/fire`);
    return response.data;
  },

  async rehire(id: number): Promise<Employee> {
    const response = await apiClient.post<ApiResponse<Employee>>(`/employees/${id}/rehire`);
    return response.data;
  },

  async moveDepartment(id: number, orgDepartmentId: string): Promise<Employee> {
    const response = await apiClient.post<ApiResponse<Employee>>(`/employees/${id}/move-department`, {
      org_department_id: orgDepartmentId,
    });
    return response.data;
  },

  async enrichPreview(file: File): Promise<EnrichPreview> {
    const formData = new FormData();
    formData.append('file', file);
    const response = await apiClient.post<ApiResponse<EnrichPreview>>('/employees/enrich?preview=true', formData);
    return response.data;
  },

  async enrichApply(file: File, manualMatches?: Array<{ fullName: string; employeeId: number }>): Promise<EnrichResult> {
    const formData = new FormData();
    formData.append('file', file);
    if (manualMatches?.length) {
      formData.append('manualMatches', JSON.stringify(manualMatches));
    }
    const response = await apiClient.post<ApiResponse<EnrichResult>>('/employees/enrich?preview=false', formData);
    return response.data;
  },
};
