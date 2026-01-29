import { apiClient } from '../api/client';
import type { TimesheetEntry } from '../types';

interface ImportResult {
  imported: number;
  errors: string[];
}

interface TimesheetFilters {
  employeeId?: number;
  startDate?: string;
  endDate?: string;
}

export const timesheetService = {
  async getAll(filters?: TimesheetFilters): Promise<TimesheetEntry[]> {
    const params = new URLSearchParams();
    if (filters?.employeeId) params.append('employeeId', String(filters.employeeId));
    if (filters?.startDate) params.append('startDate', filters.startDate);
    if (filters?.endDate) params.append('endDate', filters.endDate);

    const query = params.toString();
    return apiClient.get<TimesheetEntry[]>(`/timesheet${query ? `?${query}` : ''}`);
  },

  async update(id: number, data: Partial<TimesheetEntry>): Promise<TimesheetEntry> {
    return apiClient.put<TimesheetEntry>(`/timesheet/${id}`, data);
  },

  async bulkUpdate(entries: Array<{ id: number; status: TimesheetEntry['status']; hours_worked?: number }>): Promise<void> {
    return apiClient.post('/timesheet/bulk-update', { entries });
  },

  async import(file: File): Promise<ImportResult> {
    const formData = new FormData();
    formData.append('file', file);

    return apiClient.post<ImportResult>('/timesheet/import', formData);
  },

  async export(filters?: TimesheetFilters): Promise<Blob> {
    const params = new URLSearchParams();
    if (filters?.employeeId) params.append('employeeId', String(filters.employeeId));
    if (filters?.startDate) params.append('startDate', filters.startDate);
    if (filters?.endDate) params.append('endDate', filters.endDate);

    const query = params.toString();
    const response = await fetch(
      `${import.meta.env.VITE_API_URL || 'http://localhost:3000/api'}/timesheet/export${query ? `?${query}` : ''}`,
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
};
