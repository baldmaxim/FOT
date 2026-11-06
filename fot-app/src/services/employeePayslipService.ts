import { apiClient } from '../api/client';

// ЛК сотрудника «Расчётный лист» (/my-payslip): только свой листок — сотрудник берётся из сессии на сервере.
// Деньги — NUMERIC-строки («182730.00»), дни отпуска — строка до сотых.

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export interface IEmployeePayslipLine {
  key: string;
  /** Статья «Оплачено» или строка расчёта ФОТ (contract, travel, brigade…); null — подпись в name. */
  code: string | null;
  name: string | null;
  amount: string;
}

export interface IEmployeePayslipSalaryPart {
  calc_type: 'salary' | 'hourly';
  from: string;
  to: string;
  amount: string;
  days: number | null;
}

export interface IEmployeePayslipPayout {
  document_id: number;
  doc_number: string;
  doc_date: string;
  payment_method: string;
  amount: string;
}

export interface IEmployeePayslipReady {
  state: 'ready';
  month: string;
  full_name: string;
  position_name: string | null;
  period_from: string | null;
  period_to: string | null;
  worked_days: { workday: number; dayoff: number } | null;
  salary_parts: IEmployeePayslipSalaryPart[];
  accruals: IEmployeePayslipLine[];
  accrued_total: string;
  deductions: IEmployeePayslipLine[];
  deducted_total: string;
  payouts: IEmployeePayslipPayout[];
  paid_total: string | null;
  balance: string | null;
}

export type EmployeePayslip = IEmployeePayslipReady | { state: 'not_ready'; month: string };

export interface IEmployeePayslipSummary {
  /** Месяцы листка, новые первыми (YYYY-MM). */
  months: string[];
  /** Остаток отпуска; until — по какой день посчитан (сегодня или день увольнения). */
  vacation: { days: string; until: string } | null;
}

export const employeePayslipService = {
  getSummary: async (): Promise<IEmployeePayslipSummary> => {
    const res = await apiClient.get<ApiResponse<IEmployeePayslipSummary>>('/my-payslip');
    return res.data;
  },

  getMonth: async (month: string): Promise<EmployeePayslip> => {
    const res = await apiClient.get<ApiResponse<EmployeePayslip>>(`/my-payslip/${encodeURIComponent(month)}`);
    return res.data;
  },
};
