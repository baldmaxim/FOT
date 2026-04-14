import { apiClient, buildApiUrl, buildAuthHeaders } from '../api/client';
import type { TimesheetEntry, TimesheetResponse, TimesheetStatus } from '../types';

interface TimesheetFilters {
  month: string; // YYYY-MM
  department_id?: string;
  employee_id?: number;
}

interface ApiResponse<T> {
  data?: T;
  message?: string;
  error?: string;
}

interface BulkTimesheetCorrectionResult {
  processed: number;
  employees: number;
}

export const timesheetService = {
  async getAll(filters: TimesheetFilters): Promise<TimesheetResponse> {
    const params = new URLSearchParams();
    params.append('month', filters.month);
    if (filters.department_id) params.append('department_id', filters.department_id);
    if (filters.employee_id) params.append('employee_id', String(filters.employee_id));
    const res = await apiClient.get<ApiResponse<TimesheetResponse>>(`/timesheet?${params.toString()}`);
    if (!res.data) throw new Error(res.error || 'Ошибка загрузки табеля');
    return res.data;
  },

  async create(data: {
    employee_id: number;
    work_date: string;
    status: TimesheetStatus;
    hours_worked?: number | null;
    notes?: string | null;
  }): Promise<TimesheetEntry> {
    const res = await apiClient.post<ApiResponse<TimesheetEntry>>('/timesheet', data);
    if (!res.data) throw new Error(res.error || 'Ошибка создания записи');
    return res.data;
  },

  async update(id: number, data: Partial<Pick<TimesheetEntry, 'status' | 'hours_worked' | 'notes'>>): Promise<TimesheetEntry> {
    const res = await apiClient.put<ApiResponse<TimesheetEntry>>(`/timesheet/${id}`, data);
    if (!res.data) throw new Error(res.error || 'Ошибка обновления записи');
    return res.data;
  },

  async bulkCorrect(data: {
    items: Array<{
      employee_id: number;
      work_date: string;
    }>;
    status: TimesheetStatus;
    hours_worked?: number | null;
    notes?: string | null;
  }): Promise<BulkTimesheetCorrectionResult> {
    const res = await apiClient.post<ApiResponse<BulkTimesheetCorrectionResult>>('/timesheet/bulk', data);
    if (!res.data) throw new Error(res.error || 'Ошибка массового обновления табеля');
    return res.data;
  },

  async exportMass(filters: { month: string; department_ids: string[] }): Promise<Blob> {
    const response = await fetch(
      buildApiUrl('/timesheet/export-mass'),
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...buildAuthHeaders(),
        },
        body: JSON.stringify(filters),
      }
    );
    if (!response.ok) throw new Error('Ошибка массового экспорта');
    return response.blob();
  },

  async export(filters: TimesheetFilters): Promise<Blob> {
    const params = new URLSearchParams();
    params.append('month', filters.month);
    if (filters.department_id) params.append('department_id', filters.department_id);
    if (filters.employee_id) params.append('employee_id', String(filters.employee_id));

    const response = await fetch(
      buildApiUrl(`/timesheet/export?${params.toString()}`),
      {
        credentials: 'include',
        headers: buildAuthHeaders(),
      }
    );

    if (!response.ok) throw new Error('Ошибка экспорта');
    return response.blob();
  },
};
