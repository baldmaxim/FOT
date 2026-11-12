import { apiClient } from '../api/client';
import type { PayrollPaidItemCode, StaffCategory } from './payrollService';

/**
 * «Свод» на «Расчётах»: суммы за месяцы по объектам и категориям. Месяц человека считается автоматически (расчёт ФОТ),
 * загруженные статьи 1С заменяют расчёт, а с «Зарплатой» 1С весь его месяц — из 1С. Объект — объект табелирования
 * месяца (у «СКУД» — основной по часам закрытого табеля), «Офис» — текущая деятельность.
 */

/** Столбец: статья «Оплачено» или удержания «Справочника», для вида которых статьи 1С нет. */
export type SummaryItemCode = PayrollPaidItemCode | 'other_deductions';

/** Почему сумма неполна (сервер, payroll-summary-calc.rules.ts). */
export type SummaryIssue =
  | 'no_norm' | 'no_terms' | 'hourly' | 'vacation_pay' | 'sick_pay' | 'educational_pay'
  | 'brigade_output' | 'brigade_no_hours' | 'brigade_error' | 'brigade_open' | 'no_timesheet' | 'unknown_amount';

/** Строка: сотрудник на объекте в категории и отделе, суммы статей сложены за выбранные месяцы. */
export interface IPayrollSummaryRow {
  employee_id: number;
  full_name: string;
  /** Отдел месяца (у уволенного — где работал); нет у старого бэкенда. */
  department_id?: string | null;
  department: string | null;
  position: string | null;
  category: StaffCategory;
  /** id объекта СКУД, 'office' или 'unknown'. */
  object_key: string;
  object_name: string;
  /** Статья → сумма NUMERIC строкой (бывает 0 и отрицательная). Статьи без сумм нет. */
  amounts: Partial<Record<SummaryItemCode, string>>;
  /** Что не посчитано хотя бы за один месяц строки; нет у старого бэкенда. */
  issues?: SummaryIssue[];
  /** Выплачено по ведомостям 1С за месяцы строки (NUMERIC строкой), выплат нет — null; нет у старого бэкенда. */
  paid_out?: string | null;
}

export interface IPayrollSummary {
  /** Месяцы, вошедшие в «Свод» (YYYY-MM). */
  months: string[];
  rows: IPayrollSummaryRow[];
}

interface IApiResponse<T> { success: boolean; data: T }

/** Строка «Свода» для выгрузки в виде ведомости 1С: дерево и суммы узлов собирает сервер. */
export interface IPayrollSummaryTreeLeaf {
  object_key: string;
  object_name: string;
  category: StaffCategory;
  /** null — «Без отдела». */
  department: string | null;
  employee_id: number;
  full_name: string;
  /** «Всего начислено» / «Всего удержано» строки, NUMERIC строкой; сумм нет — null. */
  accrued: string | null;
  deducted: string | null;
  /** Нет поля — старый бэкенд «Свода»: выплат не знаем, «Выплачено» и «Остаток» в файле пустые. */
  paid_out?: string | null;
  /** Причины «Не посчитано» через запятую; null — всё посчитано. */
  not_counted: string | null;
}

export interface IPayrollSummaryTreeSnapshot {
  file_name: string;
  title: string;
  subtitle: string;
  /** Вкладка «Все»: «Выплачено» ещё и по рабочим и ИТР. */
  split_paid: boolean;
  /** Объекты — в порядке экрана. */
  leaves: IPayrollSummaryTreeLeaf[];
}

export const PAYROLL_SUMMARY_KEYS = {
  months: ['payroll-summary', 'months'],
  data: (monthsParam: string) => ['payroll-summary', 'data', monthsParam],
} as const;

export const payrollSummaryService = {
  /** Месяцы, за которые есть «Оплачено» (в охвате пользователя), по возрастанию. */
  listMonths: async (signal?: AbortSignal): Promise<string[]> =>
    (await apiClient.get<IApiResponse<string[]>>('/payroll/summary/months', { signal })).data,

  /** monthsParam — 'all' или YYYY-MM через запятую (registryMonthsParam). Сервер считает зарплату за месяц — это долго. */
  get: async (monthsParam: string, signal?: AbortSignal): Promise<IPayrollSummary> =>
    (await apiClient.get<IApiResponse<IPayrollSummary>>(
      `/payroll/summary?months=${encodeURIComponent(monthsParam)}`,
      { signal, timeoutMs: 180_000 },
    )).data,

  /** xlsx «Свода» в виде сводной ведомости 1С: объект → категория → отдел → сотрудник. */
  exportTree: (snapshot: IPayrollSummaryTreeSnapshot): Promise<{ blob: Blob; filename: string }> =>
    apiClient.download('/payroll/summary/export', snapshot.file_name, {
      method: 'POST',
      body: JSON.stringify(snapshot),
      timeoutMs: 120_000,
    }),
};
