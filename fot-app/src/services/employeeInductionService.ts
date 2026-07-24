import { apiClient } from '../api/client';

export interface IInductionRow {
  employee_id: number;
  full_name: string | null;
  department_name: string | null;
  position_name: string | null;
  /** YYYY-MM-DD или null (инструктаж не пройден). */
  inducted_on: string | null;
}

export interface IInductionDepartment {
  id: string;
  name: string;
}

export type InductionStatusFilter = 'all' | 'missing' | 'passed';

export interface IInductionListParams {
  page: number;
  pageSize: number;
  departmentId?: string;
  search?: string;
  status?: InductionStatusFilter;
}

export interface IInductionListResponse {
  success: boolean;
  data: IInductionRow[];
  meta: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    /** Сколько сотрудников в текущем фильтре (без учёта статуса) уже с датой. */
    passed: number;
  };
}

export const employeeInductionService = {
  list: async (params: IInductionListParams): Promise<IInductionListResponse> => {
    const qs = new URLSearchParams({
      page: String(params.page),
      pageSize: String(params.pageSize),
    });
    if (params.departmentId) qs.set('department_id', params.departmentId);
    if (params.search) qs.set('search', params.search);
    if (params.status && params.status !== 'all') qs.set('status', params.status);
    return apiClient.get<IInductionListResponse>(`/employees/induction?${qs.toString()}`);
  },

  departments: async (): Promise<IInductionDepartment[]> => {
    const res = await apiClient.get<{ success: boolean; data: IInductionDepartment[] }>(
      '/employees/induction/departments',
    );
    return res.data;
  },

  /** `inductedOn = null` — снять дату (инструктаж не пройден). */
  setDate: async (employeeId: number, inductedOn: string | null): Promise<IInductionRow['inducted_on']> => {
    const res = await apiClient.patch<{ success: boolean; data: { inducted_on: string | null } }>(
      `/employees/${employeeId}/induction`,
      { inducted_on: inductedOn },
    );
    return res.data.inducted_on;
  },
};
