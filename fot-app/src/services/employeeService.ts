import { apiClient } from '../api/client';
import type { Employee, EmployeeInput, EmployeeHistoryEvent, EnrichPreview, EnrichResult, ContactsEnrichPreview } from '../types';

interface ApiResponse<T> {
  data: T;
  message?: string;
}

export interface PaginatedParams {
  page: number;
  pageSize?: number;
  search?: string;
  status?: 'active' | 'fired' | 'excluded';
  departmentId?: string;
  archived?: boolean;
  view?: 'list' | 'staff';
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
}

export interface ICreateEmployeePayload {
  full_name: string;
  hire_date: string;
  org_department_id: string;
  position_id: string;
  tab_number?: string | null;
}

export interface BatchMoveEmployeesResult {
  target_department_id: string;
  moved_count: number;
  skipped_count: number;
  failed_count: number;
  moved_ids: number[];
  skipped_ids: number[];
  failures: Array<{ employee_id: number; error: string }>;
}

export const employeeService = {
  async getAll(params?: { departmentId?: string; archived?: boolean; view?: 'list' }): Promise<Employee[]> {
    const qs = new URLSearchParams();
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
    qs.set('view', params.view || 'list');
    if (params.pageSize) qs.set('pageSize', String(params.pageSize));
    if (params.search) qs.set('search', params.search);
    if (params.status) qs.set('status', params.status);
    if (params.departmentId) qs.set('department_id', params.departmentId);
    if (params.archived) qs.set('archived', 'true');
    const response = await apiClient.get<{ data: Employee[]; meta: PaginatedMeta }>(`/employees?${qs}`);
    return { data: response.data || [], meta: response.meta || { page: 1, pageSize: 50, total: 0, totalPages: 0 } };
  },

  async getFilteredIds(params: Omit<PaginatedParams, 'page' | 'pageSize'>): Promise<number[]> {
    const pageSize = 200;
    const firstPage = await this.getPaginated({
      ...params,
      page: 1,
      pageSize,
    });

    const ids = firstPage.data.map(employee => employee.id);
    const totalPages = Math.max(1, firstPage.meta.totalPages || 1);
    if (totalPages === 1) return ids;

    const restPages = await Promise.all(
      Array.from({ length: totalPages - 1 }, (_, index) => this.getPaginated({
        ...params,
        page: index + 2,
        pageSize,
      })),
    );

    for (const page of restPages) {
      ids.push(...page.data.map(employee => employee.id));
    }

    return Array.from(new Set(ids));
  },

  /** Счётчики сотрудников — дешёвый отдельный эндпоинт, серверный кэш 60с */
  async getCounts(archived = false): Promise<EmployeeCounts> {
    const qs = archived ? '?archived=true' : '';
    const response = await apiClient.get<ApiResponse<EmployeeCounts>>(`/employees/counts${qs}`);
    return response.data || { byDepartment: {}, byStatus: { active: 0, fired: 0 } };
  },

  async getById(id: number): Promise<Employee> {
    const response = await apiClient.get<ApiResponse<Employee>>(`/employees/${id}`);
    return response.data;
  },

  async create(data: ICreateEmployeePayload): Promise<Employee> {
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

  async rehire(id: number, orgDepartmentId: string): Promise<Employee> {
    const response = await apiClient.post<ApiResponse<Employee>>(
      `/employees/${id}/rehire`,
      { org_department_id: orgDepartmentId },
    );
    return response.data;
  },

  async changeSalary(id: number, salary: number, reason?: string, effectiveDate?: string): Promise<void> {
    await apiClient.post(`/employees/${id}/change-salary`, {
      salary,
      reason,
      effective_date: effectiveDate,
    });
  },

  async changePosition(id: number, positionName: string, reason?: string, effectiveDate?: string): Promise<void> {
    await apiClient.post(`/employees/${id}/change-position`, {
      position_name: positionName,
      reason,
      effective_date: effectiveDate,
    });
  },

  async updateHistoryEvent(
    employeeId: number,
    eventId: string,
    eventType: 'salary' | 'assignment',
    data: Record<string, unknown>,
  ): Promise<void> {
    await apiClient.put(`/employees/${employeeId}/history/${eventId}`, { ...data, event_type: eventType });
  },

  async deleteHistoryEvent(
    employeeId: number,
    eventId: string,
    eventType: 'salary' | 'assignment',
  ): Promise<void> {
    await apiClient.delete(`/employees/${employeeId}/history/${eventId}?event_type=${eventType}`);
  },

  async moveDepartment(id: number, orgDepartmentId: string): Promise<Employee> {
    const response = await apiClient.post<ApiResponse<Employee>>(`/employees/${id}/move-department`, {
      org_department_id: orgDepartmentId,
    });
    return response.data;
  },

  async batchMove(employeeIds: number[], orgDepartmentId: string): Promise<BatchMoveEmployeesResult> {
    const response = await apiClient.post<ApiResponse<BatchMoveEmployeesResult>>('/employees/batch-move', {
      employee_ids: employeeIds,
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

  async salaryEnrichPreview(file: File): Promise<EnrichPreview> {
    const formData = new FormData();
    formData.append('file', file);
    const response = await apiClient.post<ApiResponse<EnrichPreview>>('/employees/enrich-salary?preview=true', formData);
    return response.data;
  },

  async salaryEnrichApply(file: File, manualMatches?: Array<{ fullName: string; employeeId: number }>): Promise<EnrichResult> {
    const formData = new FormData();
    formData.append('file', file);
    if (manualMatches?.length) {
      formData.append('manualMatches', JSON.stringify(manualMatches));
    }
    const response = await apiClient.post<ApiResponse<EnrichResult>>('/employees/enrich-salary?preview=false', formData);
    return response.data;
  },

  async salaryHistoryEnrichPreview(file: File): Promise<EnrichPreview> {
    const formData = new FormData();
    formData.append('file', file);
    const response = await apiClient.post<ApiResponse<EnrichPreview>>('/employees/enrich-salary-history?preview=true', formData);
    return response.data;
  },

  async salaryHistoryEnrichApply(file: File, manualMatches?: Array<{ fullName: string; employeeId: number }>): Promise<EnrichResult> {
    const formData = new FormData();
    formData.append('file', file);
    if (manualMatches?.length) {
      formData.append('manualMatches', JSON.stringify(manualMatches));
    }
    const response = await apiClient.post<ApiResponse<EnrichResult>>('/employees/enrich-salary-history?preview=false', formData);
    return response.data;
  },

  async contactsEnrichPreview(file: File): Promise<ContactsEnrichPreview> {
    const formData = new FormData();
    formData.append('file', file);
    const response = await apiClient.post<ApiResponse<ContactsEnrichPreview>>('/employees/enrich-contacts?preview=true', formData);
    return response.data;
  },

  async contactsEnrichApply(
    file: File,
    manualMatches?: Array<{ fullName: string; employeeId: number }>,
    conflictResolutions?: Array<{ employeeId: number; overwrite: boolean }>,
  ): Promise<EnrichResult> {
    const formData = new FormData();
    formData.append('file', file);
    if (manualMatches?.length) {
      formData.append('manualMatches', JSON.stringify(manualMatches));
    }
    if (conflictResolutions?.length) {
      formData.append('conflictResolutions', JSON.stringify(conflictResolutions));
    }
    const response = await apiClient.post<ApiResponse<EnrichResult>>('/employees/enrich-contacts?preview=false', formData);
    return response.data;
  },
};
