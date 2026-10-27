/**
 * «К выплате (ФОТ)» — расчёт ФОТ по закрытому табелю (сервер, миграция 331): подписи строк, дней и пометок для
 * «Подробно» и расчётного листка. Строки — те же статьи, что в «Оплачено» (1С), с теми же подписями: сравнение
 * построчно. Итог — начислено минус удержано, без НДФЛ, как «Выплачено». Отпускные, больничные, KPI и прочие
 * статьи 1С ФОТ не считает: дни отпуска есть — итог помечается «Расчётная часть».
 */
import type {
  IPayrollCalcClosed,
  IPayrollCalcLine,
  PayrollAbsenceStatus,
  PayrollCalc,
  PayrollCalcLineCode,
  PayrollCalcMissing,
  PayrollPaidItemCode,
} from '../services/payrollService';
import { PAYROLL_PAID_GROUPS } from './payrollPaid';

/** Порядок строк — как в листке ЗУП. */
export const PAYROLL_CALC_LINE_ORDER: readonly PayrollCalcLineCode[] = [
  'contract', 'brigade', 'bonus', 'supplement', 'overtime', 'travel', 'housing',
];

const PAID_LABELS = new Map<PayrollPaidItemCode, string>(
  PAYROLL_PAID_GROUPS.flatMap(group => group.items.map(item => [item.code, item.label] as const)),
);

/** Подпись строки расчёта — как у статьи «Оплачено» с тем же кодом; доля бригады — своя. */
export const calcLineLabel = (code: PayrollCalcLineCode): string => (
  code === 'brigade' ? 'Выработка бригады' : PAID_LABELS.get(code) ?? code
);

/**
 * Статья «Оплачено» (1С) для сравнения строки: доля бригады — «По трудовому договору» (так её проводит ЗУП),
 * если оклада в расчёте нет; иначе сравнивать не с чем.
 */
export const calcLinePaidItem = (
  line: IPayrollCalcLine,
  lines: readonly IPayrollCalcLine[],
): PayrollPaidItemCode | null => {
  if (line.code !== 'brigade') return line.code;
  return lines.some(item => item.code === 'contract') ? null : 'contract';
};

/** «КТУ 1,5 · 176 ч» у доли бригады. */
const formatBrigadeNote = (brigade: { ktu: string; hours: number }): string => (
  `КТУ ${brigade.ktu.replace('.', ',')} · ${String(brigade.hours).replace('.', ',')} ч`
);

/** «22 из 23 дн.», у переработки — «4 вых.», у доли бригады — «КТУ 1,5 · 176 ч»; дней нет — null. */
export const calcLineDaysNote = (line: IPayrollCalcLine): string | null => {
  if (line.brigade) return formatBrigadeNote(line.brigade);
  if (!line.days) return null;
  if (line.code === 'overtime') return `${line.days.worked} вых.`;
  return line.days.norm === null ? null : `${line.days.worked} из ${line.days.norm} дн.`;
};

const MISSING_LABELS: Record<PayrollCalcMissing, string> = {
  vacation_pay: 'отпускные',
  sick_pay: 'больничные',
  educational_pay: 'учебный отпуск',
  hourly: 'почасовая оплата',
  no_terms: 'нет условий оплаты',
  no_norm: 'нет нормы графика',
  brigade_output: 'выработка бригады',
  brigade_error: 'расчёт бригады',
};

/** «без: отпускные, больничные» — что не вошло в итог; всё посчитано — null. */
export const calcMissingNote = (missing: readonly PayrollCalcMissing[]): string | null => (
  missing.length > 0 ? `без: ${missing.map(code => MISSING_LABELS[code]).join(', ')}` : null
);

export const CALC_ABSENCE_LABELS: Record<PayrollAbsenceStatus, string> = {
  vacation: 'Отпуск',
  sick: 'Больничный',
  educational_leave: 'Учебный отпуск',
  unpaid: 'Без сохранения ЗП',
};

const ABSENCE_ORDER: readonly PayrollAbsenceStatus[] = ['vacation', 'sick', 'educational_leave', 'unpaid'];

/** Отсутствия месяца с днями: суммы отпускных и больничных — только из 1С. */
export const calcAbsenceLines = (calc: IPayrollCalcClosed): Array<{ status: PayrollAbsenceStatus; label: string; days: number }> => (
  ABSENCE_ORDER
    .filter(status => (calc.absences[status] ?? 0) > 0)
    .map(status => ({ status, label: CALC_ABSENCE_LABELS[status], days: calc.absences[status] }))
);

/** Строки расчёта в порядке листка. */
export const calcLines = (calc: IPayrollCalcClosed): IPayrollCalcLine[] => (
  PAYROLL_CALC_LINE_ORDER.flatMap(code => calc.lines.filter(line => line.code === code))
);

/** Пометка источника под суммой: восстановленная основа; закрыт по табелю с полной основой — null. */
export const calcSourceNote = (calc: PayrollCalc): string | null => {
  if (calc.state === 'not_closed') return 'Табель не закрыт';
  return calc.quality === 'reconstructed' ? 'Восстановлено по текущим графикам' : null;
};

/** «253189.50» → 253 189,50 ₽ числом; не число — null. */
export const calcAmount = (amount: string | null | undefined): number | null => {
  if (amount === null || amount === undefined) return null;
  const value = Number(amount);
  return Number.isFinite(value) ? value : null;
};

/** Сумма «К выплате (ФОТ)» за месяцы — только если все закрыты; иначе null. Счёт в копейках. */
export const calcNetTotal = (calcs: ReadonlyArray<PayrollCalc | undefined>): number | null => {
  let cents = 0;
  for (const calc of calcs) {
    if (!calc || calc.state !== 'closed') return null;
    cents += Math.round(Number(calc.net) * 100);
  }
  return cents / 100;
};
