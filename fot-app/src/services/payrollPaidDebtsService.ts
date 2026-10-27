/**
 * Справочно к «Оплачено»: долги прошлых месяцев из ведомостей бригад 1С (миграция 332). Только чтение.
 */
import { apiClient } from '../api/client';

/** Строка месяца — тот же список, что в payroll-paid-debts.service.ts на сервере и в CHECK миграции 332. */
export type PayrollPaidDebtCode =
  | 'debt_day_salary' | 'debt_correction' | 'debt_workwear' | 'debt_tmc' | 'debt_property_damage' | 'debt_advance'
  | 'debt_fines' | 'debt_meals' | 'written_off' | 'carried_forward';

export interface IPayrollPaidDebt {
  /** YYYY-MM. */
  month: string;
  line: PayrollPaidDebtCode;
  /** NUMERIC строкой. */
  amount: string;
}

interface IApiResponse<T> { success: boolean; data: T }

export const payrollPaidDebtsService = {
  /** Долги сотрудника за месяцы from — to (YYYY-MM). */
  getByEmployee: async (employeeId: number, from: string, to: string, signal?: AbortSignal): Promise<IPayrollPaidDebt[]> => {
    const search = new URLSearchParams({ from, to });
    const res = await apiClient.get<IApiResponse<IPayrollPaidDebt[]>>(
      `/payroll/terms/employee/${employeeId}/paid-debts?${search.toString()}`,
      { signal },
    );
    return res.data;
  },
};
