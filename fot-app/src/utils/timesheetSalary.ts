import type { IPayrollCalcLine } from '../services/payrollService';
import type { TimesheetEmployee, TimesheetEntry, TimesheetStatus } from '../types';
import type { ITimesheetSalaryResponse, ITimesheetSalaryRow } from '../types/timesheet';
import { calcLineDaysNote, calcMissingNote } from './payrollCalc';
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
 * Суммы строки приглушены: бригада «Требует перерасчёта». Отдел — никогда: закрыт табель или нет, на экране не
 * помечается (решение 29.10.2026).
 */
export const isSalaryRowMuted = (
  data: ITimesheetSalaryResponse | undefined,
  row: ITimesheetSalaryRow | null,
): boolean => {
  if (!data || !row) return false;
  return data.kind === 'brigade' && data.state === 'stale';
};

/**
 * Подсказка «Суммы» (к выплате: начислено − удержания, без НДФЛ). Бригада — из чего она: «Доля 141 818,18 · КТУ 1,5 ·
 * 176 ч · удержано 3 500,00»; отдел — «К выплате (ФОТ)», посчитать нечем — без подсказки. Чего в сумме нет — в конце.
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
    if (row.payout_state === 'not_closed') return undefined;
    parts.push('К выплате (ФОТ)');
    if (row.deducted && Number(row.deducted) > 0) parts.push(`удержано ${formatSalaryAmount(row.deducted)}`);
  }
  const missing = calcMissingNote(row.missing ?? []);
  if (missing) parts.push(missing);
  return parts.join(' · ');
};

/**
 * Подсказка «Оклада» / «Переработки»: из скольких дней или часов («22 из 22 дн.», «2 ч»); строки нет (нет
 * переработки) или посчитать нечем — без подсказки.
 */
export const salaryLineTitle = (
  row: ITimesheetSalaryRow,
  line: IPayrollCalcLine | null | undefined,
): string | undefined => {
  if (row.payout_state === 'not_closed') return undefined;
  return (line ? calcLineDaysNote(line) : null) ?? undefined;
};

/** Подпись под суммой «Переработки»: часы будней и выходы сверх нормы («1 вых. · 2 ч»); у других строк — null. */
export const salaryOvertimeNote = (line: IPayrollCalcLine | null | undefined): string | null => (
  line?.code === 'overtime' ? calcLineDaysNote(line) : null
);

/** Буквы вкладки «Зарплата», под которыми — часы дня: удалёнка, работа на больничном, учебный день. */
const SALARY_LETTER_LABELS: Partial<Record<TimesheetStatus, string>> = { remote: 'УУ', sick_worked: 'РБ', study_day: 'УД' };

export interface ISalaryLetterHours {
  label: string;
  hours: number;
  /** override — часы правки «УУ» (по ним же переработка), schedule — норма дня по графику. */
  source: 'override' | 'schedule';
}

/**
 * Часы под буквой во вкладке «Зарплата», целыми, как цифры в клетках: «УУ» с правкой часов — часы правки; иначе «УУ»,
 * «РБ», «УД» — норма дня по графику (ручные «УУ» часто с 0 ч). У студенческого графика 1С ставит за РБ/УД 8 ч (7 ч
 * в предпраздник) — здесь норма графика. Нормы нет (выходной по графику) — null, в клетке только буква.
 */
export const getSalaryLetterHours = (
  entry: Pick<TimesheetEntry, 'status' | 'hours_worked' | 'hours_overridden'> | null | undefined,
  normHours: number,
): ISalaryLetterHours | null => {
  const label = entry ? SALARY_LETTER_LABELS[entry.status] : undefined;
  if (!entry || !label) return null;
  const overrideHours = entry.status === 'remote' && entry.hours_overridden ? Math.round(entry.hours_worked ?? 0) : 0;
  if (overrideHours > 0) return { label, hours: overrideHours, source: 'override' };
  const hours = Math.round(normHours);
  return hours > 0 ? { label, hours, source: 'schedule' } : null;
};
