import type { TimesheetEmployee } from '../types';
import type { ITimesheetSalaryResponse, ITimesheetSalaryRow } from '../types/timesheet';
import { calcMissingNote } from './payrollCalc';
import { formatPaidAmount } from './payrollPaid';

/** Строка вкладки «Зарплата» у сотрудника, если он в составе (начальник участка, «Руководитель» — нет). */
export const findSalaryRow = (
  data: ITimesheetSalaryResponse | undefined,
  employee: TimesheetEmployee,
): ITimesheetSalaryRow | null => {
  if (!data) return null;
  const source = employee.source ?? 'department';
  if (source !== 'department') return null;
  return data.rows.find(row => row.employee_id === employee.id) ?? null;
};

/** «141 818,18»; суммы нет — «—». */
export const formatSalaryAmount = (amount: string | null): string => (
  amount === null ? '—' : formatPaidAmount(Number(amount))
);

/** '1.5' → '1,5'. */
export const formatKtu = (value: string): string => value.replace('.', ',');

/**
 * Подсказка «Суммы» (к выплате: начислено − удержания, без НДФЛ). Бригада — из чего она: «Доля 141 818,18 · КТУ 1,5 ·
 * 176 ч · удержано 3 500,00»; отдел — «К выплате (ФОТ)» или «Табель не закрыт». Чего в сумме нет — в конце.
 */
export const salaryAmountTitle = (data: ITimesheetSalaryResponse, row: ITimesheetSalaryRow): string | undefined => {
  const parts: string[] = [];
  if (data.kind === 'brigade') {
    if (row.counted_hours === null) return undefined;
    if (row.share) parts.push(`Доля ${formatSalaryAmount(row.share)}`);
    parts.push(`КТУ ${formatKtu(row.ktu ?? '1.0')}`, `${String(row.counted_hours).replace('.', ',')} ч`);
    if (row.deducted && Number(row.deducted) > 0) parts.push(`удержано ${formatSalaryAmount(row.deducted)}`);
    if (data.state === 'fixed' && row.source === 'live') parts.push('нет в закрытом табеле — по данным портала');
  } else {
    if (row.payout_state === 'not_closed') return 'Табель не закрыт';
    parts.push('К выплате (ФОТ)');
    if (row.deducted && Number(row.deducted) > 0) parts.push(`удержано ${formatSalaryAmount(row.deducted)}`);
  }
  const missing = calcMissingNote(row.missing ?? []);
  if (missing) parts.push(missing);
  return parts.join(' · ');
};
