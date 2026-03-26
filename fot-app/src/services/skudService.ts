import { apiClient } from '../api/client';
import type { SkudEvent, SkudDailySummary, IEmployeePresence, IAccessPointSetting, IDashboardStats } from '../types';

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
  async getEvents(filters?: SkudFilters, signal?: AbortSignal): Promise<SkudEvent[]> {
    const params = new URLSearchParams();
    if (filters?.startDate) params.append('startDate', filters.startDate);
    if (filters?.endDate) params.append('endDate', filters.endDate);
    if (filters?.accessPoint) params.append('accessPoint', filters.accessPoint);
    if (filters?.employeeId) params.append('employeeId', filters.employeeId);
    if (filters?.organizationId) params.append('organization_id', filters.organizationId);
    if (filters?.search) params.append('search', filters.search);

    const query = params.toString();
    const response = await apiClient.get<ApiResponse<SkudEvent[]>>(`/skud/events${query ? `?${query}` : ''}`, { signal });
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

  async getDailySummary(date: string, organizationId?: string, signal?: AbortSignal): Promise<SkudDailySummary[]> {
    const params = new URLSearchParams({ date });
    if (organizationId) params.append('organization_id', organizationId);
    const response = await apiClient.get<ApiResponse<SkudDailySummary[]>>(`/skud/daily-summary?${params.toString()}`, { signal });
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
    let sseError: string | null = null;

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
          } else if (data.type === 'error') {
            sseError = data.error || 'Ошибка синхронизации';
          } else if (data.type === 'done') {
            result = { inserted: data.inserted, skipped: data.skipped, total: data.total };
          }
        } catch { /* JSON parse error — skip */ }
      }

      if (sseError) break;
    }

    if (sseError) throw new Error(sseError);

    return result;
  },

  async getAccessPointSettings(departmentId?: string): Promise<IAccessPointSetting[]> {
    const params = departmentId ? `?department_id=${departmentId}` : '';
    const response = await apiClient.get<ApiResponse<IAccessPointSetting[]>>(
      `/skud/access-point-settings${params}`
    );
    return response.data || [];
  },

  async saveAccessPointSettings(settings: IAccessPointSetting[], departmentId?: string): Promise<void> {
    await apiClient.put<ApiResponse<null>>('/skud/access-point-settings', {
      ...(departmentId ? { department_id: departmentId } : {}),
      settings,
    });
  },

  async syncAccessPoints(): Promise<{ accessPoints: string[]; removed: string[]; settingsRemoved: number }> {
    const response = await apiClient.post<ApiResponse<{ accessPoints: string[]; removed: string[]; settingsRemoved: number }>>(
      '/skud/sync-access-points'
    );
    return response.data;
  },

  async getDashboardStats(departmentId: string, period = 'today', signal?: AbortSignal): Promise<IDashboardStats> {
    const response = await apiClient.get<ApiResponse<IDashboardStats>>(
      `/skud/dashboard-stats?department_id=${departmentId}&period=${period}`,
      { signal },
    );
    return response.data;
  },

  async getDisciplineViolations(period: { startMonth: string; endMonth?: string }, signal?: AbortSignal): Promise<{
    violations: Array<{
      employee_id: number;
      date: string;
      type: 'late' | 'underwork' | 'early' | 'absence';
      first_entry: string | null;
      last_exit: string | null;
      total_hours: number | null;
      deviation: string;
    }>;
    employees: Record<number, { full_name: string; position: string | null; department_id: string | null }>;
    departments: Record<string, string>;
  }> {
    const params = new URLSearchParams({ startMonth: period.startMonth });
    if (period.endMonth) params.append('endMonth', period.endMonth);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- response shape validated by return type
    const response = await apiClient.get<ApiResponse<any>>(`/skud/discipline?${params.toString()}`, { signal });
    return response.data;
  },

  async getOrganizations(): Promise<{ id: string; name: string }[]> {
    const response = await apiClient.get<ApiResponse<{ id: string; name: string }[]>>('/skud/organizations');
    return response.data || [];
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
