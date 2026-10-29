import { apiClient } from '../api/client';
import type { ITimesheetSalaryResponse } from '../types/timesheet';

interface IApiResponse<T> { success: boolean; data: T }

/** «Табель → Зарплата»: КТУ, «Выработка» бригады по объектам и столбец «Сумма» (раздел «Зарплата», 5 учёток). */
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

  /** Выработка бригады на объекте за месяц; null — стереть. */
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

  setKtu: async (departmentId: string, month: string, employeeId: number, ktu: number): Promise<void> => {
    await apiClient.put<IApiResponse<{ employee_id: number; ktu: string }>>('/payroll/timesheet-salary/ktu', {
      department_id: departmentId,
      month,
      employee_id: employeeId,
      ktu,
    });
  },
};
