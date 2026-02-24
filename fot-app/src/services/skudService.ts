import { apiClient } from '../api/client';
import type { SkudEvent, SkudDailySummary, IEmployeePresence } from '../types';

interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
}

interface ImportResult {
  imported: number;
  matched: number;
  errors: string[];
}

interface SkudFilters {
  startDate?: string;
  endDate?: string;
  accessPoint?: string;
  employeeId?: string;
  organizationId?: string;
  search?: string;
}

export const skudService = {
  async getEvents(filters?: SkudFilters): Promise<SkudEvent[]> {
    const params = new URLSearchParams();
    if (filters?.startDate) params.append('startDate', filters.startDate);
    if (filters?.endDate) params.append('endDate', filters.endDate);
    if (filters?.accessPoint) params.append('accessPoint', filters.accessPoint);
    if (filters?.employeeId) params.append('employeeId', filters.employeeId);
    if (filters?.organizationId) params.append('organization_id', filters.organizationId);
    if (filters?.search) params.append('search', filters.search);

    const query = params.toString();
    const response = await apiClient.get<ApiResponse<SkudEvent[]>>(`/skud/events${query ? `?${query}` : ''}`);
    return response.data || [];
  },

  async getEmployeeEvents(employeeId: number, startDate?: string, endDate?: string): Promise<SkudEvent[]> {
    const params = new URLSearchParams();
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);
    const query = params.toString();
    const response = await apiClient.get<ApiResponse<SkudEvent[]>>(
      `/skud/employee-events/${employeeId}${query ? `?${query}` : ''}`
    );
    return response.data || [];
  },

  async getDailySummary(date: string, organizationId?: string): Promise<SkudDailySummary[]> {
    const params = new URLSearchParams({ date });
    if (organizationId) params.append('organization_id', organizationId);
    const response = await apiClient.get<ApiResponse<SkudDailySummary[]>>(`/skud/daily-summary?${params.toString()}`);
    return response.data || [];
  },

  async importEvents(file: File): Promise<ImportResult> {
    const formData = new FormData();
    formData.append('file', file);

    const response = await apiClient.post<ApiResponse<ImportResult>>('/skud/import', formData);
    return response.data;
  },

  async getAccessPoints(organizationId?: string): Promise<string[]> {
    const query = organizationId ? `?organization_id=${organizationId}` : '';
    const response = await apiClient.get<ApiResponse<string[]>>(`/skud/access-points${query}`);
    return response.data || [];
  },

  async getPresence(departmentId?: string): Promise<IEmployeePresence[]> {
    const params = departmentId ? `?department_id=${departmentId}` : '';
    const response = await apiClient.get<ApiResponse<IEmployeePresence[]>>(`/skud/presence${params}`);
    return response.data || [];
  },

  async syncEmployee(
    employeeId: number,
    startDate: string,
    endDate: string,
    onProgress?: (msg: string) => void,
  ): Promise<{ inserted: number; skipped: number; total: number }> {
    const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';
    const token = localStorage.getItem('access_token');

    const response = await fetch(`${API_URL}/skud/sync-employee`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ employeeId, startDate, endDate }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Ошибка' }));
      throw new Error(err.error || 'Ошибка синхронизации');
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('SSE не поддерживается');

    const decoder = new TextDecoder();
    let result = { inserted: 0, skipped: 0, total: 0 };
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === 'day_start' && onProgress) {
            onProgress(`День ${data.dayIndex + 1}/${data.totalDays} (${data.day})...`);
          } else if (data.type === 'day_done' && onProgress && data.inserted > 0) {
            onProgress(`${data.day}: +${data.inserted} событий`);
          } else if (data.type === 'done') {
            result = { inserted: data.inserted, skipped: data.skipped, total: data.total };
          }
        } catch { /* skip */ }
      }
    }

    return result;
  },

  async exportEvents(filters?: SkudFilters): Promise<Blob> {
    const params = new URLSearchParams();
    if (filters?.startDate) params.append('startDate', filters.startDate);
    if (filters?.endDate) params.append('endDate', filters.endDate);
    if (filters?.accessPoint) params.append('accessPoint', filters.accessPoint);

    const query = params.toString();
    const response = await fetch(
      `${import.meta.env.VITE_API_URL || 'http://localhost:3000/api'}/skud/export${query ? `?${query}` : ''}`,
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
