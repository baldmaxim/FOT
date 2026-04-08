import { apiClient } from '../api/client';
import type { TimesheetEntry, TimesheetResponse, TimesheetStatus } from '../types';

interface TimesheetFilters {
  month: string; // YYYY-MM
  department_id?: string;
}

interface ApiResponse<T> {
  data?: T;
  message?: string;
  error?: string;
}

export const timesheetService = {
  async getAll(filters: TimesheetFilters): Promise<TimesheetResponse> {
    const params = new URLSearchParams();
    params.append('month', filters.month);
    if (filters.department_id) params.append('department_id', filters.department_id);
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

  async exportMass(filters: { month: string; department_ids: string[] }): Promise<Blob> {
    const response = await fetch(
      `${import.meta.env.VITE_API_URL || 'http://localhost:3000/api'}/timesheet/export-mass`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('access_token')}`,
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

    const response = await fetch(
      `${import.meta.env.VITE_API_URL || 'http://localhost:3000/api'}/timesheet/export?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('access_token')}`,
        },
      }
    );

    if (!response.ok) throw new Error('Ошибка экспорта');
    return response.blob();
  },
};
