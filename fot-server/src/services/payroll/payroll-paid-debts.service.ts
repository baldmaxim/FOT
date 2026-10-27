/**
 * Справочно к «Оплачено»: долги прошлых месяцев из ведомостей бригад 1С (миграция 332) — перенос удержаний
 * с прошлых периодов по видам, закрыто документом 1С, перенос на следующий период. Расшифровка статьи «Оплачено»
 * prior_debts (миграция 334): её сумма = долг − закрыто − перенесено. Только чтение: строки загружает скрипт из ведомостей.
 */
import { query } from '../../config/postgres.js';

/** Строки — в порядке показа. Тот же список в CHECK миграции 332 и в fot-app/src/utils/payrollPaidDebts.ts. */
export const PAYROLL_PAID_DEBT_CODES = [
  // Перенос с прошлых периодов — по видам.
  'debt_day_salary',
  'debt_correction',
  'debt_workwear',
  'debt_tmc',
  'debt_property_damage',
  'debt_advance',
  'debt_fines',
  'debt_meals',
  'written_off',
  'carried_forward',
] as const;

export type PayrollPaidDebtCode = typeof PAYROLL_PAID_DEBT_CODES[number];

/** Строка месяца: месяц YYYY-MM, сумма — текстом NUMERIC. */
export interface IPayrollPaidDebt {
  month: string;
  line: PayrollPaidDebtCode;
  amount: string;
}

/** Долги сотрудника за месяцы from — to (YYYY-MM, включительно). */
export const getPaidDebts = async (
  employeeId: number,
  fromMonth: string,
  toMonth: string,
): Promise<IPayrollPaidDebt[]> =>
  query<IPayrollPaidDebt>(
    `SELECT to_char(month, 'YYYY-MM') AS month, line_code AS line, amount::text AS amount
       FROM payroll_paid_debts
      WHERE employee_id = $1
        AND month BETWEEN ($2 || '-01')::date AND ($3 || '-01')::date
      ORDER BY month, line_code`,
    [employeeId, fromMonth, toMonth],
  );
