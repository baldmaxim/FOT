/**
 * Таблица «Условий оплаты» и «Расчётов» (PayrollTermsTable): классы ширины колонок и тексты простых ячеек.
 */
import type { IPayrollTermsRow } from '../services/payrollService';
import type { PayrollTableColumn } from './payrollColumns';
import { formatPayrollMoney } from './payrollFormat';
import { formatPaidAmount, type PayrollPaidTotalKind } from './payrollPaid';
import type { PayrollTableColumnEntry } from './payrollSubColumns';

/** Класс ширины колонки (colgroup) для скрываемых столбцов. */
const COL_CLASS: Record<PayrollTableColumn, string> = {
  department: 'colDept',
  position: 'colPosition',
  schedule: 'colSchedule',
  salary: 'colSalary',
  bonus: 'colBonus',
  housing: 'colHousing',
  accruals: 'colAccruals',
  deductions: 'colDeductions',
  calc_remainder: 'colCalcSum',
  calc_rate: 'colCalcRate',
  calc_timesheet: 'colCalcTimesheet',
  calc_overtime: 'colCalcSum',
  calc_travel: 'colCalcSum',
  calc_vacation: 'colCalcSum',
  calc_sick: 'colCalcSum',
  calc_housing: 'colCalcHousing',
  paid_recalc: 'colCalcSum',
  fss_payments: 'colCalcSum',
  calc_supplements: 'colCalcGroup',
  calc_deductions: 'colCalcGroup',
  calc_net: 'colCalcSum',
  card_payouts: 'colCardPayouts',
};

/** Ширина подстолбца: у переработки, проезда и проживания — прежняя, у прочих — как у сумм ФОТ. */
export const colClassOf = (entry: PayrollTableColumnEntry): string => {
  if (entry.kind === 'column') return COL_CLASS[entry.key];
  return entry.sub.type === 'column' ? COL_CLASS[entry.sub.column] : 'colCalcSum';
};

/** Сумма зависит от вида оплаты: у оклада — месячная, у почасовой — ставка за час. */
export const formatSalary = (row: IPayrollTermsRow): string => {
  if (!row.terms_id) return '—';
  const money = row.calc_type === 'salary' ? formatPayrollMoney(row.monthly_salary) : formatPayrollMoney(row.hourly_rate);
  if (money === null) return '—';
  return row.calc_type === 'salary' ? `${money} ₽/мес` : `${money} ₽/час`;
};

export const formatMonthly = (row: IPayrollTermsRow, value: string | number | null, unit = '₽/мес'): string => {
  const money = row.terms_id ? formatPayrollMoney(value) : null;
  return money === null ? '—' : `${money} ${unit}`;
};

/** Подпись кнопки суммы для экранного диктора. */
export const PAID_KIND_LABELS: Record<PayrollPaidTotalKind, string> = { accrued: 'Начислено', deducted: 'Удержания' };

/** Сумма «Оплачено» строки «Расчётов» (с сервера — NUMERIC строкой): нет — «—». */
export const formatPaid = (value: string | number | null | undefined): string => (
  value === null || value === undefined ? '—' : formatPaidAmount(Number(value))
);
