import { apiClient } from '../api/client';
import type { Employee, EmployeeInput, EmployeeHistoryEvent } from '../types';

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

interface ImportResult {
  imported: number;
  errors: string[];
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
};
