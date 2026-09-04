import { apiClient } from '../api/client';
import type {
  SigurArchiveDepartmentInfo,
  SigurConnectionScope,
  SigurConnectionSettings,
  SigurEmployeeAccessPointsSaveResult,
  SigurEmployeeAccessPointsState,
  SigurEmployeeCardSummary,
  SigurEmployeeProfileState,
} from '../types';

interface ApiResponse<T> {
  data: T;
  message?: string;
}

interface ISigurTestResult {
  success: boolean;
  message: string;
  connection: string;
  connections: { external: boolean; internal: boolean };
}

interface ISigurConnectionStatusResult {
  connected: boolean | null;
  latestCheckStatus: 'success' | 'failure' | 'silence' | null;
  lastCheckedAt: string | null;
  lastSuccessfulSignalAt: string | null;
  lastError: string | null;
  connections: { external: boolean; internal: boolean };
}

interface ISigurPreviewResult {
  data: Record<string, unknown>[];
  sampleFields: string[];
  totalFetched: number;
  mappedCount?: number;
}

interface ISigurConnectionSettingsPayload {
  internal?: { url?: string | null; username?: string | null; password?: string | null };
  external?: { url?: string | null; username?: string | null; password?: string | null };
  archiveDepartmentId?: number | null;
  archiveDepartmentName?: string | null;
}

export const sigurService = {
  async getConnectionSettings(): Promise<SigurConnectionSettings> {
    const response = await apiClient.get<ApiResponse<SigurConnectionSettings>>('/sigur/connection-settings');
    return response.data;
  },

  async saveConnectionSettings(payload: ISigurConnectionSettingsPayload): Promise<SigurConnectionSettings> {
    const response = await apiClient.put<ApiResponse<SigurConnectionSettings>>('/sigur/connection-settings', payload);
    return response.data;
  },

  async ensureArchiveDepartment(connection?: SigurConnectionScope): Promise<SigurArchiveDepartmentInfo> {
    const response = await apiClient.post<ApiResponse<SigurArchiveDepartmentInfo>>('/sigur/archive-department/ensure', {
      connection,
    });
    return response.data;
  },

  async testConnection(connection?: 'internal' | 'external'): Promise<ISigurTestResult> {
    const params = connection ? `?connection=${connection}` : '';
    return apiClient.get<ISigurTestResult>(`/sigur/test${params}`);
  },

  async getConnectionStatus(): Promise<ISigurConnectionStatusResult> {
    const response = await apiClient.get<ApiResponse<ISigurConnectionStatusResult>>('/sigur/connection-status');
    return response.data;
  },

  async preview(startTime: string, endTime: string, departmentId?: string, connection?: 'internal' | 'external'): Promise<ISigurPreviewResult> {
    const params = new URLSearchParams({ startTime, endTime });
    if (departmentId) params.append('departmentId', departmentId);
    if (connection) params.append('connection', connection);
    const result = await apiClient.get<ISigurPreviewResult>(`/sigur/preview?${params.toString()}`);
    return result;
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

  async getDepartments(options?: { force?: boolean }): Promise<{ data: unknown[]; count: number }> {
    const query = options?.force ? '?force=1' : '';
    return apiClient.get(`/sigur/departments${query}`);
  },

  async getAccessPoints(connection?: 'internal' | 'external'): Promise<{ data: unknown[]; count: number }> {
    const params = connection ? `?connection=${connection}` : '';
    return apiClient.get(`/sigur/access-points${params}`);
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

  async getEmployeeAccessPoints(
    employeeId: number,
    connection?: SigurConnectionScope,
    includeOptions = false,
    refresh = false,
  ): Promise<SigurEmployeeAccessPointsState> {
    const searchParams = new URLSearchParams();
    if (connection) searchParams.set('connection', connection);
    if (includeOptions) searchParams.set('includeOptions', 'true');
    if (refresh) searchParams.set('refresh', '1');
    const params = searchParams.toString() ? `?${searchParams.toString()}` : '';
    const response = await apiClient.get<ApiResponse<SigurEmployeeAccessPointsState>>(
      `/sigur/employees/${employeeId}/access-points${params}`,
    );
    return response.data;
  },

  async getEmployeeProfile(
    employeeId: number,
    connection?: SigurConnectionScope,
    refresh = false,
  ): Promise<SigurEmployeeProfileState> {
    const searchParams = new URLSearchParams();
    if (connection) searchParams.set('connection', connection);
    if (refresh) searchParams.set('refresh', '1');
    const params = searchParams.toString() ? `?${searchParams.toString()}` : '';
    const response = await apiClient.get<ApiResponse<SigurEmployeeProfileState>>(
      `/sigur/employees/${employeeId}/profile${params}`,
    );
    return response.data;
  },

  async saveEmployeeAccessPoints(
    employeeId: number,
    accessPointIds: number[],
    connection?: SigurConnectionScope,
  ): Promise<SigurEmployeeAccessPointsSaveResult> {
    const response = await apiClient.put<ApiResponse<SigurEmployeeAccessPointsSaveResult>>(
      `/sigur/employees/${employeeId}/access-points`,
      { accessPointIds, connection },
    );
    return response.data;
  },

  async updateEmployeeCardExpiration(
    employeeId: number,
    cardId: number,
    expirationDate: string,
    connection?: SigurConnectionScope,
  ): Promise<SigurEmployeeCardSummary> {
    const response = await apiClient.put<ApiResponse<SigurEmployeeCardSummary>>(
      `/sigur/employees/${employeeId}/cards/${cardId}/expiration`,
      { expirationDate, connection },
    );
    return response.data;
  },

  async updateEmployeeCardBinding(
    employeeId: number,
    cardId: number,
    startDate: string,
    expirationDate: string,
    connection?: SigurConnectionScope,
    format?: string,
  ): Promise<SigurEmployeeCardSummary> {
    const response = await apiClient.patch<ApiResponse<SigurEmployeeCardSummary>>(
      `/sigur/employees/${employeeId}/cards/${cardId}/binding`,
      { startDate, expirationDate, connection, ...(format ? { format } : {}) },
    );
    return response.data;
  },

  async getEventTypes(): Promise<{ data: unknown[] }> {
    return apiClient.get('/sigur/events/types');
  },

  async syncEmployees(): Promise<{ imported: number; skipped: number; total: number; errors: string[] }> {
    const response = await apiClient.post<ApiResponse<{ imported: number; skipped: number; total: number; errors: string[] }>>(
      '/sigur/sync-employees'
    );
    return response.data;
  },

  async discover(connection?: 'internal' | 'external'): Promise<Record<string, unknown>> {
    const params = connection ? `?connection=${connection}` : '';
    const response = await apiClient.get<ApiResponse<Record<string, unknown>>>(`/sigur/discover${params}`);
    return response.data;
  },

  async syncDepartments(): Promise<{ imported: number; updated: number; skipped: number; filtered: number; total: number; parentLinksSet: number; errors: string[] }> {
    const response = await apiClient.post<ApiResponse<{ imported: number; updated: number; skipped: number; filtered: number; total: number; parentLinksSet: number; errors: string[] }>>(
      '/sigur/sync-departments'
    );
    return response.data;
  },

  async seedPositions(): Promise<{ created: number; skipped: number; total: number }> {
    const response = await apiClient.post<ApiResponse<{ created: number; skipped: number; total: number }>>(
      '/sigur/seed-positions'
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
