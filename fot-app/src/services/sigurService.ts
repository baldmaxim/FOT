import { apiClient } from '../api/client';

interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
}

interface ISigurTestResult {
  success: boolean;
  message: string;
  connection: string;
  connections: { external: boolean; internal: boolean };
}

interface ISigurPreviewResult {
  data: Record<string, unknown>[];
  sampleFields: string[];
  totalFetched: number;
}

interface ISigurSyncResult {
  imported: number;
  skipped: number;
  matched: number;
  errors: string[];
  sigurTotal: number;
}

export const sigurService = {
  async testConnection(): Promise<ISigurTestResult> {
    return apiClient.get<ISigurTestResult>('/sigur/test');
  },

  async preview(startTime: string, endTime: string): Promise<ISigurPreviewResult> {
    const response = await apiClient.get<ApiResponse<ISigurPreviewResult>>(
      `/sigur/preview?startTime=${encodeURIComponent(startTime)}&endTime=${encodeURIComponent(endTime)}`
    );
    return response.data;
  },

  async sync(startDate: string, endDate: string): Promise<ISigurSyncResult> {
    const response = await apiClient.post<ApiResponse<ISigurSyncResult>>(
      '/sigur/sync',
      { startDate, endDate }
    );
    return response.data;
  },

  async getEvents(startTime?: string, endTime?: string): Promise<{ data: unknown[]; count: number }> {
    const params = new URLSearchParams();
    if (startTime) params.append('startTime', startTime);
    if (endTime) params.append('endTime', endTime);
    const query = params.toString();
    return apiClient.get(`/sigur/events${query ? `?${query}` : ''}`);
  },

  async getEmployees(): Promise<{ data: unknown[]; count: number }> {
    return apiClient.get('/sigur/employees');
  },

  async getDepartments(): Promise<{ data: unknown[]; count: number }> {
    return apiClient.get('/sigur/departments');
  },
};
