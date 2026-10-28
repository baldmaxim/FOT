/**
 * Столбцы состава зарплаты на «Расчётах» (решение пользователя 27.10.2026): что показать в ячейке и какие столбцы
 * пусты в выборке. ФОТ — расчёт по закрытому табелю (сервер, payroll-calc-columns.service): «Начислено по табелю»,
 * проезд, проживание, доплаты, удержания; из 1С — отпускные, больничные, перерасчёт и ведомости в банк.
 * Незакрытый или неполный месяц не превращается в ноль: строка помечается во всех столбцах ФОТ.
 */
import type {
  IPayrollCalcColumns,
  IPayrollCardPayouts,
  IPayrollTermsRow,
  PayrollCalcColumnsIssue,
} from '../services/payrollService';
import { accrualPeriodCrossesYear, formatAccrualMonthLabel } from './payrollAccruals';
import type { PayrollTableColumn } from './payrollColumns';

/** Столбцы по расчёту ФОТ, суммы которых складываются по месяцам. */
export type PayrollCalcSumColumn =
  | 'calc_timesheet' | 'calc_overtime' | 'calc_travel' | 'calc_housing' | 'calc_supplements' | 'calc_deductions'
  | 'calc_net';

const CALC_SUM_FIELD: Record<
  PayrollCalcSumColumn,
  'timesheet' | 'overtime' | 'travel' | 'housing' | 'supplements' | 'deductions' | 'net'
> = {
  calc_timesheet: 'timesheet',
  calc_overtime: 'overtime',
  calc_travel: 'travel',
  calc_housing: 'housing',
  calc_supplements: 'supplements',
  calc_deductions: 'deductions',
  calc_net: 'net',
};

export const isCalcSumColumn = (column: PayrollTableColumn): column is PayrollCalcSumColumn => column in CALC_SUM_FIELD;

/** Подсказки шапки: из чего столбец. */
export const PAYROLL_CALC_HEADER_TITLES: Partial<Record<PayrollTableColumn, string>> = {
  calc_rate: 'Оклад (у почасовых — ставка) по условиям оплаты на последний день последнего выбранного месяца',
  calc_timesheet: 'Расчёт ФОТ по закрытому табелю: оклад по отработанным дням (с премиальной частью условий); '
    + 'у рабочих бригады — доля выработки по КТУ',
  calc_overtime: 'Расчёт ФОТ по закрытому табелю: выходы в выходные сверх нормы — днём, в будни — часы корректировки '
    + 'сверх 8 ч (в предпраздничный — сверх 7 ч); оклад / норма',
  calc_travel: 'Расчёт ФОТ по закрытому табелю',
  paid_vacation: 'Из 1С, в «Сумму» не входит',
  paid_sick: 'Из 1С, в «Сумму» не входит',
  calc_housing: 'Расчёт ФОТ по закрытому табелю: квартира или доплата за общежитие',
  paid_recalc: 'Из 1С, в «Сумму» не входит',
  calc_supplements: 'Расчёт ФОТ по закрытому табелю: плановая и разовая доплаты',
  calc_deductions: 'Расчёт ФОТ: удержания «Справочника»',
  calc_net: 'К выплате по расчёту ФОТ, без НДФЛ — как «Сумма» в «Табель → Зарплата»: начислено по табелю + переработка '
    + '+ проезд + проживание + доплаты − удержания (ФОТ)',
  card_payouts: 'Из 1С: ведомости в банк по месяцу начисления',
};

const present = (value: string | null | undefined): value is string => value !== null && value !== undefined;

/** Сумма столбца ФОТ строки, NUMERIC строкой; нет — null. */
export const calcSumAmount = (row: IPayrollTermsRow, column: PayrollCalcSumColumn): string | null => (
  row.calc?.[CALC_SUM_FIELD[column]] ?? null
);

/** Есть незакрытые или неполные месяцы — суммы ФОТ строки частичные. */
export const calcHasIssues = (calc: IPayrollCalcColumns | null | undefined): boolean => (
  (calc?.open_months.length ?? 0) > 0 || (calc?.incomplete.length ?? 0) > 0
);

/** «Начислено по табелю» нечем показать: суммы нет, а табель не закрыт — в ячейке «не закрыт». */
export const calcNotClosed = (calc: IPayrollCalcColumns | null | undefined): boolean => (
  calc?.timesheet === null && calc.open_months.length > 0
);

const ISSUE_LABELS: Record<PayrollCalcColumnsIssue, string> = {
  hourly: 'почасовая ставка, ФОТ не считает',
  no_terms: 'нет условий оплаты',
  no_norm: 'нет нормы',
  brigade_output: 'выработка бригады не введена',
  brigade_error: 'ошибка расчёта бригады',
  unknown_amount: 'сумма не посчитана',
};

/** Подсказка ⚠: «Неполный расчёт: август — почасовая ставка, ФОТ не считает; сентябрь — табель не закрыт». */
export const calcIssuesNote = (calc: IPayrollCalcColumns | null | undefined): string | null => {
  if (!calc || !calcHasIssues(calc)) return null;
  const parts = [
    ...calc.open_months.map(month => ({ month, text: 'табель не закрыт' })),
    ...calc.incomplete.map(item => ({ month: item.month, text: item.reasons.map(reason => ISSUE_LABELS[reason]).join(', ') })),
  ].sort((a, b) => a.month.localeCompare(b.month));
  const withYear = accrualPeriodCrossesYear(parts.map(part => part.month));
  return `Неполный расчёт: ${parts
    .map(part => `${formatAccrualMonthLabel(part.month, withYear).toLowerCase()} — ${part.text}`)
    .join('; ')}`;
};

/** «Переработка»: из чего — «2 вых. · 6 ч»; нет — null. */
export const overtimeNote = (calc: IPayrollCalcColumns | null | undefined): string | null => {
  if (!calc) return null;
  const parts = [
    ...(calc.overtime_days > 0 ? [`${calc.overtime_days} вых.`] : []),
    ...(calc.overtime_hours > 0 ? [`${String(calc.overtime_hours).replace('.', ',')} ч`] : []),
  ];
  return parts.length > 0 ? parts.join(' · ') : null;
};

/** «Проживание»: вид — квартира или общежитие (за несколько месяцев — оба). */
export const housingKindsLabel = (calc: IPayrollCalcColumns | null | undefined): string | null => {
  if (!calc || calc.housing_kinds.length === 0) return null;
  return calc.housing_kinds.map(kind => (kind === 'apartment' ? 'квартира' : 'общежитие')).join(', ');
};

const CARD_PAYOUT_LABELS: ReadonlyArray<[keyof IPayrollCardPayouts, string]> = [
  ['advance', 'Аванс'],
  ['salary', 'ЗП'],
  ['premium', 'Премия'],
];

/** Строки ячейки «Выплаты на карту» — только виды с суммой, по порядку: аванс, ЗП, премия. */
export const cardPayoutLines = (
  payouts: IPayrollCardPayouts | null | undefined,
): Array<{ label: string; amount: string }> => (
  payouts
    ? CARD_PAYOUT_LABELS.flatMap(([key, label]) => {
      const amount = payouts[key];
      return present(amount) ? [{ label, amount }] : [];
    })
    : []
);

/** Ставка «Оклада»: оклад — с копейками, почасовая — до 4 знаков и «₽/ч». */
export const formatCalcRate = (rate: IPayrollCalcColumns['rate']): string => {
  if (!rate) return '—';
  const value = Number(rate.amount);
  if (!Number.isFinite(value)) return '—';
  const digits = { minimumFractionDigits: 2, maximumFractionDigits: rate.calc_type === 'hourly' ? 4 : 2 };
  const text = value.toLocaleString('ru-RU', digits);
  return rate.calc_type === 'hourly' ? `${text} ₽/ч` : text;
};

/** Столбцы сумм «Расчётов»: без данных ни в одной загруженной строке — скрываются сами. */
const SUM_COLUMNS: ReadonlySet<PayrollTableColumn> = new Set<PayrollTableColumn>([
  'payout', 'accrued', 'deductions', 'calc_rate', 'calc_timesheet', 'calc_overtime', 'calc_travel', 'paid_vacation',
  'paid_sick', 'calc_housing', 'paid_recalc', 'calc_supplements', 'calc_deductions', 'calc_net', 'card_payouts',
]);

/** Данные строки в столбце сумм: любая сумма, в том числе 0 и минус; у «Начислено по табелю» — и неполный расчёт. */
const hasColumnData = (row: IPayrollTermsRow, column: PayrollTableColumn): boolean => {
  switch (column) {
    case 'payout': return present(row.paid_total) || present(row.paid_deductions_total);
    case 'accrued': return present(row.paid_total);
    case 'deductions': return present(row.paid_deductions_total);
    case 'calc_rate': return Boolean(row.calc?.rate);
    case 'calc_timesheet': return present(row.calc?.timesheet) || calcHasIssues(row.calc);
    case 'paid_vacation': return present(row.paid_vacation);
    case 'paid_sick': return present(row.paid_sick_leave);
    case 'paid_recalc': return present(row.paid_recalc_prev);
    case 'card_payouts': return cardPayoutLines(row.card_payouts).length > 0;
    default: return isCalcSumColumn(column) && present(calcSumAmount(row, column));
  }
};

/**
 * Столбцы сумм без данных ни в одной загруженной строке. Строк нет — ничего не скрывается (шапка не скачет).
 * Видимость — по загруженным строкам: отдел целиком в первой порции (500), на корнях компаний и «Все отделы»
 * столбец может появиться при прокрутке (продуктовое ограничение, план 27.10).
 */
export const emptyPayrollColumns = (
  rows: readonly IPayrollTermsRow[],
  columns: ReadonlyArray<{ key: PayrollTableColumn }>,
): Set<PayrollTableColumn> => {
  const empty = new Set<PayrollTableColumn>();
  if (rows.length === 0) return empty;
  for (const { key } of columns) {
    if (SUM_COLUMNS.has(key) && !rows.some(row => hasColumnData(row, key))) empty.add(key);
  }
  return empty;
};
