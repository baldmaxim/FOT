import { apiClient } from '../api/client';

export interface IDirectReportEmployeeRef {
  id: number;
  full_name: string | null;
  org_department_id: string | null;
  position_id: number | null;
}

export interface IDirectReport {
  id: string;
  subordinate_employee_id: number;
  manager_employee_id: number;
  assigned_at: string;
  assigned_by: string | null;
  unassigned_at: string | null;
  is_active: boolean;
  note: string | null;
  subordinate?: IDirectReportEmployeeRef | null;
  manager?: IDirectReportEmployeeRef | null;
}

interface ApiResponse<T> {
  success?: boolean;
  data: T;
  error?: string;
  existing_manager_employee_id?: number;
}

export const directReportsService = {
  async list(params: { managerEmployeeId?: number; includeInactive?: boolean } = {}): Promise<IDirectReport[]> {
    const search = new URLSearchParams();
    if (params.managerEmployeeId != null) {
      search.set('manager_employee_id', String(params.managerEmployeeId));
    }
    if (params.includeInactive) {
      search.set('include_inactive', '1');
    }
    const qs = search.toString();
    const res = await apiClient.get<ApiResponse<IDirectReport[]>>(
      `/direct-reports${qs ? `?${qs}` : ''}`,
    );
    return res.data ?? [];
  },

  async assign(input: {
    managerEmployeeId: number;
    subordinateEmployeeId: number;
    note?: string | null;
  }): Promise<IDirectReport> {
    const res = await apiClient.post<ApiResponse<IDirectReport>>('/direct-reports', {
      manager_employee_id: input.managerEmployeeId,
      subordinate_employee_id: input.subordinateEmployeeId,
      note: input.note ?? null,
    });
    return res.data;
  },

  async unassign(id: string): Promise<void> {
    await apiClient.delete(`/direct-reports/${id}`);
  },
};
