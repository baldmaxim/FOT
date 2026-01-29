import { apiClient } from '../api/client';
import type { SkudEvent, SkudDailySummary } from '../types';

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
}

export const skudService = {
  async getEvents(filters?: SkudFilters): Promise<SkudEvent[]> {
    const params = new URLSearchParams();
    if (filters?.startDate) params.append('startDate', filters.startDate);
    if (filters?.endDate) params.append('endDate', filters.endDate);
    if (filters?.accessPoint) params.append('accessPoint', filters.accessPoint);
    if (filters?.employeeId) params.append('employeeId', filters.employeeId);

    const query = params.toString();
    const response = await apiClient.get<ApiResponse<SkudEvent[]>>(`/skud/events${query ? `?${query}` : ''}`);
    return response.data || [];
  },

  async getDailySummary(date: string): Promise<SkudDailySummary[]> {
    const response = await apiClient.get<ApiResponse<SkudDailySummary[]>>(`/skud/daily-summary?date=${date}`);
    return response.data || [];
  },

  async importEvents(file: File): Promise<ImportResult> {
    const formData = new FormData();
    formData.append('file', file);

    const response = await apiClient.post<ApiResponse<ImportResult>>('/skud/import', formData);
    return response.data;
  },

  async getAccessPoints(): Promise<string[]> {
    const response = await apiClient.get<ApiResponse<string[]>>('/skud/access-points');
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
