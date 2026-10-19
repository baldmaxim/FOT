import { apiClient } from '../api/client';
import type { PayrollPaidItemCode, StaffCategory } from './payrollService';

/**
 * «Свод» на «Расчётах»: суммы «Оплачено» (ЗУП) за месяцы по объектам и категориям. Объект — объект
 * табелирования месяца (у «СКУД» — основной по часам закрытого табеля), «Офис» — текущая деятельность.
 */

/** Строка: сотрудник на объекте в категории, суммы статей сложены за выбранные месяцы. */
export interface IPayrollSummaryRow {
  employee_id: number;
  full_name: string;
  /** Отдел месяца (у уволенного — где работал). */
  department: string | null;
  position: string | null;
  category: StaffCategory;
  /** id объекта СКУД, 'office' или 'unknown'. */
  object_key: string;
  object_name: string;
  /** Статья → сумма NUMERIC строкой (бывает 0 и отрицательная). Статьи без сумм нет. */
  amounts: Partial<Record<PayrollPaidItemCode, string>>;
}

export interface IPayrollSummary {
  /** Месяцы, вошедшие в «Свод» (YYYY-MM). */
  months: string[];
  rows: IPayrollSummaryRow[];
}

interface IApiResponse<T> { success: boolean; data: T }

export const PAYROLL_SUMMARY_KEYS = {
  months: ['payroll-summary', 'months'],
  data: (monthsParam: string) => ['payroll-summary', 'data', monthsParam],
} as const;

export const payrollSummaryService = {
  /** Месяцы, за которые есть «Оплачено» (в охвате пользователя), по возрастанию. */
  listMonths: async (signal?: AbortSignal): Promise<string[]> =>
    (await apiClient.get<IApiResponse<string[]>>('/payroll/summary/months', { signal })).data,

  /** monthsParam — 'all' или YYYY-MM через запятую (registryMonthsParam). */
  get: async (monthsParam: string, signal?: AbortSignal): Promise<IPayrollSummary> =>
    (await apiClient.get<IApiResponse<IPayrollSummary>>(
      `/payroll/summary?months=${encodeURIComponent(monthsParam)}`,
      { signal, timeoutMs: 60_000 },
    )).data,
};
