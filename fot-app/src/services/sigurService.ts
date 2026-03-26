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
  async testConnection(connection?: 'internal' | 'external'): Promise<ISigurTestResult> {
    const params = connection ? `?connection=${connection}` : '';
    return apiClient.get<ISigurTestResult>(`/sigur/test${params}`);
  },

  async preview(startTime: string, endTime: string, departmentId?: string): Promise<ISigurPreviewResult> {
    const params = new URLSearchParams({ startTime, endTime });
    if (departmentId) params.append('departmentId', departmentId);
    const result = await apiClient.get<ISigurPreviewResult>(`/sigur/preview?${params.toString()}`);
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

  async getAccessPoints(): Promise<{ data: unknown[]; count: number }> {
    return apiClient.get('/sigur/access-points');
  },

  async getCards(): Promise<{ data: unknown[]; count: number }> {
    return apiClient.get('/sigur/cards');
  },

  async getZones(): Promise<{ data: unknown[]; count: number }> {
    return apiClient.get('/sigur/zones');
  },

  async getAccessRules(): Promise<{ data: unknown[]; count: number }> {
    return apiClient.get('/sigur/access-rules');
  },

  async getEventTypes(): Promise<{ data: unknown[] }> {
    return apiClient.get('/sigur/events/types');
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

  async discover(): Promise<Record<string, unknown>> {
    const response = await apiClient.get<ApiResponse<Record<string, unknown>>>('/sigur/discover');
    return response.data;
  },

  async syncDepartments(organizationId: string): Promise<{ imported: number; updated: number; skipped: number; filtered: number; total: number; parentLinksSet: number; errors: string[] }> {
    const response = await apiClient.post<ApiResponse<{ imported: number; updated: number; skipped: number; filtered: number; total: number; parentLinksSet: number; errors: string[] }>>(
      '/sigur/sync-departments',
      { organization_id: organizationId }
    );
    return response.data;
  },

  async seedPositions(organizationId: string): Promise<{ created: number; skipped: number; total: number }> {
    const response = await apiClient.post<ApiResponse<{ created: number; skipped: number; total: number }>>(
      '/sigur/seed-positions',
      { organization_id: organizationId }
    );
    return response.data;
  },

  async getSyncFilter(): Promise<{ sigur_department_id: number; sigur_department_name: string }[]> {
    const response = await apiClient.get<ApiResponse<{ sigur_department_id: number; sigur_department_name: string }[]>>(
      '/sigur/sync-filter'
    );
    return response.data;
  },

  async updateSyncFilter(departments: { sigur_department_id: number; sigur_department_name: string }[]): Promise<void> {
    await apiClient.put('/sigur/sync-filter', { departments });
  },

  async matchEmployees(
    matches: Array<{ sigurId: number; employeeId: number }>,
    createNew: Array<{ sigurId?: number; name: string; orgDepartmentId?: string; positionId?: string }>,
  ): Promise<{ linked: number; created: number; errors: string[] }> {
    const response = await apiClient.post<ApiResponse<{ linked: number; created: number; errors: string[] }>>(
      '/sigur/match-employees',
      { matches, createNew },
    );
    return response.data;
  },

  async clearEvents(startDate: string, endDate: string): Promise<{ deleted: number }> {
    const response = await apiClient.post<ApiResponse<{ deleted: number }>>(
      '/sigur/clear-events',
      { startDate, endDate }
    );
    return response.data;
  },
};
