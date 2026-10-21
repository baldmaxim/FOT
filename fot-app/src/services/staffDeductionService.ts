import { apiClient } from '../api/client';
import type { ITableExportSnapshot } from '../utils/tableView';
import type { IDormitoryCandidate } from './dormitoryService';

/** Удержание сотрудника (миграция 318): вид, месяц удержания, сумма. Отдел и должность — текущие. */
export interface IStaffDeduction {
  id: number;
  employee_id: number;
  full_name: string;
  department: string | null;
  position: string | null;
  kind_id: number;
  kind_name: string;
  /** YYYY-MM. */
  month: string;
  /** NUMERIC как строка: «5000.00». */
  amount: string;
}

export interface IStaffDeductionPayload {
  kind_id: number;
  /** YYYY-MM. */
  month: string;
  amount: number;
}

/** Вид удержания — общий справочник с «Зарплатой»; сумма по умолчанию — только у кадров. */
export interface IStaffDeductionKind {
  id: number;
  name: string;
  /** NUMERIC как строка; не задана — null. */
  default_amount: string | null;
}

export interface IStaffDeductionKindPayload {
  name: string;
  default_amount: number | null;
}

interface IApiResponse<T> { success: boolean; data: T }

export const STAFF_DEDUCTIONS_KEY = ['staff-deductions'] as const;
export const STAFF_DEDUCTION_KINDS_KEY = ['staff-deduction-kinds'] as const;

export const staffDeductionService = {
  list: async (signal?: AbortSignal): Promise<IStaffDeduction[]> => {
    const res = await apiClient.get<IApiResponse<IStaffDeduction[]>>('/staff-deductions', { signal });
    return res.data;
  },

  searchEmployees: async (search: string, signal?: AbortSignal): Promise<IDormitoryCandidate[]> => {
    const res = await apiClient.get<IApiResponse<IDormitoryCandidate[]>>(
      `/staff-deductions/employees/search?q=${encodeURIComponent(search)}`,
      { signal },
    );
    return res.data;
  },

  add: async (employeeId: number, payload: IStaffDeductionPayload): Promise<IStaffDeduction> => {
    const res = await apiClient.post<IApiResponse<IStaffDeduction>>('/staff-deductions', { employee_id: employeeId, ...payload });
    return res.data;
  },

  update: async (deductionId: number, payload: IStaffDeductionPayload): Promise<IStaffDeduction> => {
    const res = await apiClient.patch<IApiResponse<IStaffDeduction>>(`/staff-deductions/${deductionId}`, payload);
    return res.data;
  },

  remove: async (deductionId: number): Promise<void> => {
    await apiClient.delete<IApiResponse<IStaffDeduction>>(`/staff-deductions/${deductionId}`);
  },

  /** xlsx ровно той таблицы, что на экране: сортировка и фильтры уже применены. */
  exportTable: async (table: ITableExportSnapshot): Promise<{ blob: Blob; filename: string }> =>
    apiClient.download('/staff-deductions/export', table.file_name, {
      method: 'POST',
      body: JSON.stringify(table),
      timeoutMs: 120_000,
    }),

  listKinds: async (signal?: AbortSignal): Promise<IStaffDeductionKind[]> => {
    const res = await apiClient.get<IApiResponse<IStaffDeductionKind[]>>('/staff-deductions/kinds', { signal });
    return res.data;
  },

  /** Такой вид уже есть — ApiError 409. */
  addKind: async (payload: IStaffDeductionKindPayload): Promise<IStaffDeductionKind> => {
    const res = await apiClient.post<IApiResponse<IStaffDeductionKind>>('/staff-deductions/kinds', payload);
    return res.data;
  },

  updateKind: async (kindId: number, payload: IStaffDeductionKindPayload): Promise<IStaffDeductionKind> => {
    const res = await apiClient.patch<IApiResponse<IStaffDeductionKind>>(`/staff-deductions/kinds/${kindId}`, payload);
    return res.data;
  },

  /** Вид назначен сотрудникам (в кадрах или в «Зарплате») — ApiError 409. */
  removeKind: async (kindId: number): Promise<void> => {
    await apiClient.delete<IApiResponse<IStaffDeductionKind>>(`/staff-deductions/kinds/${kindId}`);
  },
};
