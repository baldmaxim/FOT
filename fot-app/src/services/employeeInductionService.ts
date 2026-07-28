import { apiClient } from '../api/client';
import type { IEmployeeOtTrainingState, IOtTrainingDef } from './otTraining.types';

export interface IInductionRow {
  employee_id: number;
  full_name: string | null;
  department_name: string | null;
  position_name: string | null;
  /** YYYY-MM-DD или null (вводный инструктаж не пройден). */
  inducted_on: string | null;
  /** Программа А. Полный набор обучения — в панели под строкой. */
  program_a_on: string | null;
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

/** Патч одного вида: поле не передано — не менять, null — очистить. */
export interface IOtTrainingPatch {
  kind: string;
  passed_on?: string | null;
  note?: string | null;
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

  /** Каталог видов обучения для своих сотрудников (включая программу А и сквозные профессии). */
  otCatalog: async (): Promise<IOtTrainingDef[]> => {
    const res = await apiClient.get<{ success: boolean; data: IOtTrainingDef[] }>(
      '/employees/induction/catalog',
    );
    return res.data ?? [];
  },

  /** Состояния всех видов обучения сотрудника, включая непройденные (status 'missing'). */
  trainings: async (employeeId: number): Promise<IEmployeeOtTrainingState[]> => {
    const res = await apiClient.get<{ success: boolean; data: IEmployeeOtTrainingState[] }>(
      `/employees/${employeeId}/induction/trainings`,
    );
    return res.data ?? [];
  },

  /** Правит один вид обучения и возвращает пересчитанный сервером набор состояний. */
  setTraining: async (
    employeeId: number,
    patch: IOtTrainingPatch,
  ): Promise<IEmployeeOtTrainingState[]> => {
    const res = await apiClient.patch<{ success: boolean; data: IEmployeeOtTrainingState[] }>(
      `/employees/${employeeId}/induction/trainings`,
      patch,
    );
    return res.data ?? [];
  },
};
