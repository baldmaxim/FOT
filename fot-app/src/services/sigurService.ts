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
  mappedCount?: number;
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
    console.log('[sigur] preview request:', { startTime, endTime });
    const result = await apiClient.get<ISigurPreviewResult>(
      `/sigur/preview?startTime=${encodeURIComponent(startTime)}&endTime=${encodeURIComponent(endTime)}`
    );
    console.log('[sigur] preview response:', result);
    return result;
  },

  async sync(startDate: string, endDate: string, organizationId?: string): Promise<ISigurSyncResult> {
    const response = await apiClient.post<ApiResponse<ISigurSyncResult>>(
      '/sigur/sync',
      { startDate, endDate, organization_id: organizationId }
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

  async syncOrganizations(): Promise<{ imported: number; skipped: number; total: number }> {
    const response = await apiClient.post<ApiResponse<{ imported: number; skipped: number; total: number }>>(
      '/sigur/sync-organizations'
    );
    return response.data;
  },

  async syncEmployees(): Promise<{ imported: number; skipped: number; total: number; errors: string[] }> {
    const response = await apiClient.post<ApiResponse<{ imported: number; skipped: number; total: number; errors: string[] }>>(
      '/sigur/sync-employees'
    );
    return response.data;
  },

  async cleanDuplicateOrganizations(): Promise<{ totalBefore: number; totalAfter: number; duplicatesRemoved: number; errors: string[] }> {
    const response = await apiClient.post<ApiResponse<{ totalBefore: number; totalAfter: number; duplicatesRemoved: number; errors: string[] }>>(
      '/sigur/clean-duplicate-organizations'
    );
    return response.data;
  },
};
