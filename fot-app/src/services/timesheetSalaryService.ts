import { apiClient } from '../api/client';
import type { ITimesheetBrigadeObjectOutputs, ITimesheetBrigadeOutputItem, ITimesheetSalaryResponse } from '../types/timesheet';

interface IApiResponse<T> { success: boolean; data: T }

/**
 * «Табель → Зарплата» и «Бригады»: КТУ, «Выработка» бригады — по объектам или одной суммой на бригаду, столбец «Сумма»
 * (раздел «Зарплата», 5 учёток; «Бригады» и «Зарплата по объектам» — ещё и по галочке «Выработка», миграция 342).
 */
export const timesheetSalaryService = {
  get: async (departmentId: string, month: string, signal?: AbortSignal): Promise<ITimesheetSalaryResponse> => {
    // preliminary=1 — незакрытый месяц отдела предварительно по живому табелю (без него — только закрытый).
    const params = new URLSearchParams({ department_id: departmentId, month, preliminary: '1' });
    const res = await apiClient.get<IApiResponse<ITimesheetSalaryResponse>>(
      `/payroll/timesheet-salary?${params.toString()}`,
      { signal },
    );
    return res.data;
  },

  /** «Бригады»: бригады месяца и внесённая выработка. */
  listBrigades: async (month: string, signal?: AbortSignal): Promise<ITimesheetBrigadeOutputItem[]> => {
    const params = new URLSearchParams({ month });
    const res = await apiClient.get<IApiResponse<ITimesheetBrigadeOutputItem[]>>(
      `/payroll/timesheet-salary/brigades?${params.toString()}`,
      { signal },
    );
    return res.data;
  },

  /** Стрелка во «Бригадах»: объекты бригады за месяц, часы и внесённая выработка, без людей и их сумм. */
  getBrigadeObjects: async (departmentId: string, month: string, signal?: AbortSignal): Promise<ITimesheetBrigadeObjectOutputs> => {
    const params = new URLSearchParams({ department_id: departmentId, month });
    const res = await apiClient.get<IApiResponse<ITimesheetBrigadeObjectOutputs>>(
      `/payroll/timesheet-salary/brigade-objects?${params.toString()}`,
      { signal },
    );
    return res.data;
  },

  /** Выработка одной суммой на бригаду за месяц; null — стереть. При выработке по объектам — 409. */
  setBrigadeOutput: async (departmentId: string, month: string, amount: number | null): Promise<void> => {
    await apiClient.put<IApiResponse<{ output_amount: string | null }>>(
      '/payroll/timesheet-salary/output',
      { department_id: departmentId, month, amount },
    );
  },

  /** Выработка бригады на объекте за месяц; null — стереть. При сумме бригаде — 409. */
  setObjectOutput: async (
    departmentId: string,
    month: string,
    objectKey: string,
    amount: number | null,
  ): Promise<void> => {
    await apiClient.put<IApiResponse<{ object_key: string; output_amount: string | null }>>(
      '/payroll/timesheet-salary/object-output',
      { department_id: departmentId, month, object_key: objectKey, amount },
    );
  },

  /**
   * «Доля», вписанная рублями (355): objectKey — объект или '__brigade__' (сумма бригаде); null — стереть (снова по
   * формуле). Не сходится с выработкой — 400 с текстом (максимум при КТУ 2,2).
   */
  setShare: async (
    departmentId: string,
    month: string,
    objectKey: string,
    employeeId: number,
    amount: number | null,
  ): Promise<void> => {
    await apiClient.put<IApiResponse<{ object_key: string; employee_id: number; fixed_share: string | null }>>(
      '/payroll/timesheet-salary/share',
      { department_id: departmentId, month, object_key: objectKey, employee_id: employeeId, amount },
    );
  },

  /** КТУ 0,0…2,2; снимает вписанные доли сотрудника за месяц. */
  setKtu: async (departmentId: string, month: string, employeeId: number, ktu: number): Promise<void> => {
    await apiClient.put<IApiResponse<{ employee_id: number; ktu: string }>>('/payroll/timesheet-salary/ktu', {
      department_id: departmentId,
      month,
      employee_id: employeeId,
      ktu,
    });
  },
};
