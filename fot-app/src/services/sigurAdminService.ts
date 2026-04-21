import { apiClient } from '../api/client';
import type {
  SigurConnectionScope,
  SigurDepartmentNode,
  SigurEmployeeCardAccessStatus,
  SigurEmployeeAccessRulesSaveResult,
  SigurEmployeeAccessPointsSaveResult,
  SigurEmployeeCardSummary,
  SigurEmployeeSummary,
  SigurLiveEmployeeProfile,
  SigurPositionSummary,
} from '../types';

interface ApiResponse<T> {
  data: T;
  message?: string;
  meta?: Record<string, unknown>;
}

export interface SigurEmployeesMeta {
  total: number;
  page: number;
  pageSize: number;
  cacheCount: number;
  cacheLoading: boolean;
  cacheComplete: boolean;
}

export interface SigurEmployeesResult {
  items: SigurEmployeeSummary[];
  meta: SigurEmployeesMeta;
}

export interface SigurEmployeeCardStatusesResult {
  items: SigurEmployeeCardAccessStatus[];
}

export interface SigurDepartmentCountsResult {
  byDepartment: Record<string, number>;
  loading: boolean;
  complete: boolean;
  processedEmployees: number;
  totalEmployees: number | null;
}

export interface SigurEmployeeUpsertInput {
  name: string;
  departmentId: number;
  positionId?: number | null;
  tabId?: string | null;
  description?: string | null;
  blocked?: boolean | null;
  connection?: SigurConnectionScope;
}

export interface SigurEmployeeUpdateInput {
  name?: string;
  departmentId?: number | null;
  positionId?: number | null;
  tabId?: string | null;
  description?: string | null;
  blocked?: boolean | null;
  connection?: SigurConnectionScope;
}

export interface SigurDepartmentUpsertInput {
  name: string;
  parentId?: number | null;
  connection?: SigurConnectionScope;
}

export const sigurAdminService = {
  async getDepartmentsTree(connection?: SigurConnectionScope): Promise<SigurDepartmentNode[]> {
    const params = connection ? `?connection=${connection}` : '';
    const response = await apiClient.get<ApiResponse<SigurDepartmentNode[]>>(`/sigur/admin/departments/tree${params}`);
    return response.data || [];
  },

  async getDepartments(connection?: SigurConnectionScope): Promise<SigurDepartmentNode[]> {
    const params = connection ? `?connection=${connection}` : '';
    const response = await apiClient.get<ApiResponse<SigurDepartmentNode[]>>(`/sigur/admin/departments${params}`);
    return response.data || [];
  },

  async getDepartmentCounts(connection?: SigurConnectionScope): Promise<SigurDepartmentCountsResult> {
    const params = connection ? `?connection=${connection}` : '';
    const response = await apiClient.get<ApiResponse<SigurDepartmentCountsResult>>(`/sigur/admin/departments/counts${params}`);
    return response.data || {
      byDepartment: {},
      loading: false,
      complete: false,
      processedEmployees: 0,
      totalEmployees: null,
    };
  },

  async createDepartment(payload: SigurDepartmentUpsertInput): Promise<SigurDepartmentNode> {
    const response = await apiClient.post<ApiResponse<SigurDepartmentNode>>('/sigur/admin/departments', payload);
    return response.data;
  },

  async batchMoveDepartments(
    departmentIds: number[],
    targetParentId: number | null,
    connection?: SigurConnectionScope,
  ): Promise<{ requested: number; effective: number; moved: number; failedDepartmentId: number | null; error: string | null }> {
    const response = await apiClient.post<ApiResponse<{ requested: number; effective: number; moved: number; failedDepartmentId: number | null; error: string | null }>>(
      '/sigur/admin/departments/batch-move',
      { departmentIds, targetParentId, connection },
    );
    return response.data;
  },

  async updateDepartment(id: number, payload: Partial<SigurDepartmentUpsertInput>): Promise<SigurDepartmentNode> {
    const response = await apiClient.put<ApiResponse<SigurDepartmentNode>>(`/sigur/admin/departments/${id}`, payload);
    return response.data;
  },

  async deleteDepartment(id: number, connection?: SigurConnectionScope): Promise<void> {
    const endpoint = connection
      ? `/sigur/admin/departments/${id}?connection=${connection}`
      : `/sigur/admin/departments/${id}`;
    await apiClient.delete(endpoint);
  },

  async deleteDepartmentRecursive(id: number, connection?: SigurConnectionScope): Promise<{ deleted: number }> {
    const endpoint = connection
      ? `/sigur/admin/departments/${id}/recursive?connection=${connection}`
      : `/sigur/admin/departments/${id}/recursive`;
    const response = await apiClient.delete<ApiResponse<{ deleted: number }>>(endpoint);
    return response.data;
  },

  async getPositions(connection?: SigurConnectionScope): Promise<SigurPositionSummary[]> {
    const params = connection ? `?connection=${connection}` : '';
    const response = await apiClient.get<ApiResponse<SigurPositionSummary[]>>(`/sigur/admin/positions${params}`);
    return response.data || [];
  },

  async createPosition(name: string, connection?: SigurConnectionScope): Promise<SigurPositionSummary> {
    const response = await apiClient.post<ApiResponse<SigurPositionSummary>>('/sigur/admin/positions', {
      name,
      connection,
    });
    return response.data;
  },

  async updatePosition(id: number, name: string, connection?: SigurConnectionScope): Promise<SigurPositionSummary> {
    const response = await apiClient.put<ApiResponse<SigurPositionSummary>>(`/sigur/admin/positions/${id}`, {
      name,
      connection,
    });
    return response.data;
  },

  async deletePosition(id: number, connection?: SigurConnectionScope): Promise<void> {
    const endpoint = connection
      ? `/sigur/admin/positions/${id}?connection=${connection}`
      : `/sigur/admin/positions/${id}`;
    await apiClient.delete<ApiResponse<void>>(endpoint);
  },

  async getEmployees(params?: {
    departmentId?: number | null;
    search?: string;
    blocked?: boolean;
    includeChildren?: boolean;
    page?: number;
    pageSize?: number;
    connection?: SigurConnectionScope;
  }): Promise<SigurEmployeesResult> {
    const searchParams = new URLSearchParams();
    if (params?.departmentId != null) searchParams.set('departmentId', String(params.departmentId));
    if (params?.search) searchParams.set('search', params.search);
    if (params?.blocked !== undefined) searchParams.set('blocked', String(params.blocked));
    if (params?.includeChildren !== undefined) searchParams.set('includeChildren', String(params.includeChildren));
    if (params?.page != null) searchParams.set('page', String(params.page));
    if (params?.pageSize != null) searchParams.set('pageSize', String(params.pageSize));
    if (params?.connection) searchParams.set('connection', params.connection);
    const query = searchParams.toString();
    const response = await apiClient.get<ApiResponse<SigurEmployeeSummary[]>>(
      `/sigur/admin/employees${query ? `?${query}` : ''}`,
    );
    const items = response.data || [];
    const meta = response.meta as Partial<SigurEmployeesMeta> | undefined;
    return {
      items,
      meta: {
        total: Number(meta?.total || items.length),
        page: Number(meta?.page || params?.page || 1),
        pageSize: Number(meta?.pageSize || params?.pageSize || items.length || 1),
        cacheCount: Number(meta?.cacheCount || items.length),
        cacheLoading: meta?.cacheLoading === true,
        cacheComplete: meta?.cacheComplete !== false,
      },
    };
  },

  async getEmployeeProfile(
    sigurEmployeeId: number,
    params?: {
      connection?: SigurConnectionScope;
      includeAccessPointCatalog?: boolean;
    },
  ): Promise<SigurLiveEmployeeProfile> {
    const searchParams = new URLSearchParams();
    if (params?.connection) searchParams.set('connection', params.connection);
    if (params?.includeAccessPointCatalog !== undefined) {
      searchParams.set('includeAccessPointCatalog', String(params.includeAccessPointCatalog));
    }
    const query = searchParams.toString();
    const response = await apiClient.get<ApiResponse<SigurLiveEmployeeProfile>>(
      `/sigur/admin/employees/${sigurEmployeeId}/profile${query ? `?${query}` : ''}`,
    );
    return response.data;
  },

  async getEmployeeCardStatuses(
    employeeIds: number[],
    connection?: SigurConnectionScope,
  ): Promise<SigurEmployeeCardAccessStatus[]> {
    if (employeeIds.length === 0) return [];
    const searchParams = new URLSearchParams();
    searchParams.set('employeeIds', employeeIds.join(','));
    if (connection) searchParams.set('connection', connection);
    const response = await apiClient.get<ApiResponse<SigurEmployeeCardAccessStatus[]>>(
      `/sigur/admin/employees/card-statuses?${searchParams.toString()}`,
    );
    return response.data || [];
  },

  async createEmployee(payload: SigurEmployeeUpsertInput): Promise<SigurLiveEmployeeProfile> {
    const response = await apiClient.post<ApiResponse<SigurLiveEmployeeProfile>>('/sigur/admin/employees', payload);
    return response.data;
  },

  async updateEmployee(sigurEmployeeId: number, payload: SigurEmployeeUpdateInput): Promise<SigurLiveEmployeeProfile> {
    const response = await apiClient.put<ApiResponse<SigurLiveEmployeeProfile>>(
      `/sigur/admin/employees/${sigurEmployeeId}`,
      payload,
    );
    return response.data;
  },

  async deleteEmployee(sigurEmployeeId: number, connection?: SigurConnectionScope): Promise<void> {
    const endpoint = connection
      ? `/sigur/admin/employees/${sigurEmployeeId}?connection=${connection}`
      : `/sigur/admin/employees/${sigurEmployeeId}`;
    await apiClient.delete(endpoint);
  },

  async blockEmployee(sigurEmployeeId: number, connection?: SigurConnectionScope): Promise<SigurLiveEmployeeProfile> {
    const response = await apiClient.post<ApiResponse<SigurLiveEmployeeProfile>>(
      `/sigur/admin/employees/${sigurEmployeeId}/block`,
      { connection },
    );
    return response.data;
  },

  async unblockEmployee(sigurEmployeeId: number, connection?: SigurConnectionScope): Promise<SigurLiveEmployeeProfile> {
    const response = await apiClient.post<ApiResponse<SigurLiveEmployeeProfile>>(
      `/sigur/admin/employees/${sigurEmployeeId}/unblock`,
      { connection },
    );
    return response.data;
  },

  async moveEmployee(
    sigurEmployeeId: number,
    departmentId: number,
    connection?: SigurConnectionScope,
  ): Promise<SigurLiveEmployeeProfile> {
    const response = await apiClient.post<ApiResponse<SigurLiveEmployeeProfile>>(
      `/sigur/admin/employees/${sigurEmployeeId}/move`,
      { departmentId, connection },
    );
    return response.data;
  },

  async batchMoveEmployees(
    employeeIds: number[],
    departmentId: number,
    connection?: SigurConnectionScope,
  ): Promise<{ requested: number; moved: number; failedIds: number[] }> {
    const response = await apiClient.post<ApiResponse<{ requested: number; moved: number; failedIds: number[] }>>(
      '/sigur/admin/employees/batch-move',
      { employeeIds, departmentId, connection },
    );
    return response.data;
  },

  async saveEmployeeAccessPoints(
    sigurEmployeeId: number,
    accessPointIds: number[],
    connection?: SigurConnectionScope,
  ): Promise<SigurEmployeeAccessPointsSaveResult> {
    const response = await apiClient.put<ApiResponse<SigurEmployeeAccessPointsSaveResult>>(
      `/sigur/admin/employees/${sigurEmployeeId}/access-points`,
      { accessPointIds, connection },
    );
    return response.data;
  },

  async saveEmployeeAccessRules(
    sigurEmployeeId: number,
    accessRuleIds: number[],
    connection?: SigurConnectionScope,
  ): Promise<SigurEmployeeAccessRulesSaveResult> {
    const response = await apiClient.put<ApiResponse<SigurEmployeeAccessRulesSaveResult>>(
      `/sigur/admin/employees/${sigurEmployeeId}/access-rules`,
      { accessRuleIds, connection },
    );
    return response.data;
  },

  async updateEmployeeCardExpiration(
    sigurEmployeeId: number,
    cardId: number,
    expirationDate: string,
    connection?: SigurConnectionScope,
  ): Promise<SigurEmployeeCardSummary> {
    const response = await apiClient.put<ApiResponse<SigurEmployeeCardSummary>>(
      `/sigur/admin/employees/${sigurEmployeeId}/cards/${cardId}/expiration`,
      { expirationDate, connection },
    );
    return response.data;
  },

  async updateEmployeeCardBinding(
    sigurEmployeeId: number,
    cardId: number,
    startDate: string,
    expirationDate: string,
    connection?: SigurConnectionScope,
    format?: string,
  ): Promise<SigurEmployeeCardSummary> {
    const response = await apiClient.patch<ApiResponse<SigurEmployeeCardSummary>>(
      `/sigur/admin/employees/${sigurEmployeeId}/cards/${cardId}/binding`,
      { startDate, expirationDate, connection, ...(format ? { format } : {}) },
    );
    return response.data;
  },
};
