/**
 * Столбцы состава зарплаты на «Расчётах» (решение пользователя 27.10.2026): что показать в ячейке и какие столбцы
 * пусты в выборке. ФОТ — расчёт по табелю (сервер, payroll-calc-columns.service): «Начислено по табелю», проезд,
 * отпускные и больничные (суммы 1С в расчёте, решение 30.10.2026), проживание, доплаты, удержания; только из 1С —
 * перерасчёт и ведомости выплаты по способам.
 * Закрыт табель или нет — на экране не помечается (решение 29.10.2026: незакрытый сервер считает по живому).
 * Неполный месяц не превращается в ноль: «Сумма» — «—». Выработка бригады не введена — подпись «выработка не
 * внесена» под «Начислено по табелю» и «Суммой», без ⚠; прочие причины (почасовая ставка, нет условий или нормы,
 * нет учтённых часов или ошибка бригады) — ⚠ с подсказкой.
 */
import type {
  IPayrollCalcColumns,
  IPayrollCardPayoutByMethod,
  IPayrollTermsRow,
  PayrollCalcColumnsIssue,
} from '../services/payrollService';
import { accrualPeriodCrossesYear, formatAccrualMonthLabel } from './payrollAccruals';
import type { PayrollTableColumn } from './payrollColumns';

/** Столбцы по расчёту ФОТ, суммы которых складываются по месяцам. */
export type PayrollCalcSumColumn =
  | 'calc_timesheet' | 'calc_overtime' | 'calc_travel' | 'calc_vacation' | 'calc_sick' | 'calc_housing'
  | 'calc_supplements' | 'calc_deductions' | 'calc_net';

const CALC_SUM_FIELD: Record<
  PayrollCalcSumColumn,
  'timesheet' | 'overtime' | 'travel' | 'vacation' | 'sick_leave' | 'housing' | 'supplements' | 'deductions' | 'net'
> = {
  calc_timesheet: 'timesheet',
  calc_overtime: 'overtime',
  calc_travel: 'travel',
  calc_vacation: 'vacation',
  calc_sick: 'sick_leave',
  calc_housing: 'housing',
  calc_supplements: 'supplements',
  calc_deductions: 'deductions',
  calc_net: 'net',
};

export const isCalcSumColumn = (column: PayrollTableColumn): column is PayrollCalcSumColumn => column in CALC_SUM_FIELD;

/** Источник столбцов ФОТ в подсказке шапки. */
const CALC_SOURCE = 'Расчёт ФОТ по табелю';

export const PAYROLL_CALC_HEADER_TITLES: Partial<Record<PayrollTableColumn, string>> = {
  calc_rate: 'Оклад (у почасовых — ставка) по условиям оплаты на последний день последнего выбранного месяца',
  calc_timesheet: `${CALC_SOURCE}: оклад по отработанным дням (с премиальной частью условий); `
    + 'у рабочих бригады — доля выработки по КТУ',
  calc_overtime: `${CALC_SOURCE}: выходы в выходные сверх нормы — днём, в будни — часы корректировки `
    + 'сверх 8 ч (в предпраздничный — сверх 7 ч); оклад / норма',
  calc_travel: CALC_SOURCE,
  calc_vacation: 'Из 1С: начислено («Оплачено»), нет — перечислено по ведомости; входит в «Сумму»',
  calc_sick: 'Из 1С: начислено («Оплачено»), нет — перечислено по ведомости; входит в «Сумму»',
  calc_housing: `${CALC_SOURCE}: квартира или доплата за общежитие`,
  paid_recalc: 'Из 1С, в «Сумму» не входит',
  calc_supplements: `${CALC_SOURCE}: плановая и разовая доплаты`,
  calc_deductions: 'Расчёт ФОТ: удержания «Справочника»',
  calc_net: 'К выплате по расчёту ФОТ, без НДФЛ — как «Сумма» в «Табель → Зарплата»: начислено по табелю + переработка '
    + '+ проезд + отпускные и больничные (1С) + проживание + доплаты − удержания (ФОТ)',
  card_payouts: 'Из 1С: ведомости выплаты по месяцу начисления, по видам выплаты',
};

const present = (value: string | null | undefined): value is string => value !== null && value !== undefined;

/** Сумма столбца ФОТ строки, NUMERIC строкой; нет — null. */
export const calcSumAmount = (row: IPayrollTermsRow, column: PayrollCalcSumColumn): string | null => (
  row.calc?.[CALC_SUM_FIELD[column]] ?? null
);

/** Есть неполные месяцы — суммы ФОТ строки не окончательные (в том числе выработка бригады не введена). */
export const calcHasIssues = (calc: IPayrollCalcColumns | null | undefined): boolean => (calc?.incomplete.length ?? 0) > 0;

const ISSUE_LABELS: Record<PayrollCalcColumnsIssue, string> = {
  hourly: 'почасовая ставка, ФОТ не считает',
  no_terms: 'нет условий оплаты',
  no_norm: 'нет нормы',
  brigade_output: 'выработка бригады не введена',
  brigade_no_hours: 'нет учтённых часов бригады',
  brigade_error: 'ошибка расчёта бригады',
  unknown_amount: 'сумма не посчитана',
};

/**
 * Подсказка ⚠, причины одного месяца — в одной части: «Неполный расчёт: август — почасовая ставка, ФОТ не считает;
 * октябрь — нет учтённых часов бригады». «Выработка не введена» сюда не входит — она подписью (calcBrigadeOutputSub);
 * других причин нет — null, ⚠ не показывается.
 */
export const calcIssuesNote = (calc: IPayrollCalcColumns | null | undefined): string | null => {
  if (!calc) return null;
  const byMonth = new Map<string, string[]>();
  for (const item of calc.incomplete) {
    const reasons = item.reasons.filter(reason => reason !== 'brigade_output');
    if (reasons.length > 0) byMonth.set(item.month, reasons.map(reason => ISSUE_LABELS[reason]));
  }
  if (byMonth.size === 0) return null;
  const months = [...byMonth.keys()].sort();
  const withYear = accrualPeriodCrossesYear(months);
  return `Неполный расчёт: ${months
    .map(month => `${formatAccrualMonthLabel(month, withYear).toLowerCase()} — ${byMonth.get(month)!.join(', ')}`)
    .join('; ')}`;
};

/** Подпись «выработка не внесена» под «Начислено по табелю» и «Суммой»: хоть в одном месяце выработки бригады нет. */
export const calcBrigadeOutputSub = (calc: IPayrollCalcColumns | null | undefined): string | null => (
  calc?.incomplete.some(item => item.reasons.includes('brigade_output')) ? 'выработка не внесена' : null
);

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

/** Способы выплаты ведомостей 1С по порядку ячейки и их подписи; незнакомые — следом по алфавиту, названием 1С. */
const CARD_PAYOUT_METHODS: ReadonlyArray<[string, string]> = [
  ['Аванс', 'Аванс'],
  ['Зарплата за месяц', 'Зарплата'],
  ['Премии', 'Премии'],
  ['Отпуска', 'Отпуска'],
  ['Увольнения', 'Увольнения'],
  ['Больничные листы', 'Больничные'],
  ['Вознаграждение сотрудникам по договорам ГПХ', 'ГПХ'],
  ['Материальная помощь', 'Мат. помощь'],
  ['Разовые начисления', 'Разовые'],
];
const CARD_PAYOUT_ORDER = new Map(CARD_PAYOUT_METHODS.map(([method, label], index) => [method, { label, index }]));

/** Строка ячейки «Выплаты на карту»: method — исходный способ 1С (ключ строки), label — подпись. */
export interface ICardPayoutLine {
  method: string;
  label: string;
  amount: string;
}

/**
 * Строки ячейки «Выплаты на карту» — каждый способ выплаты 1С с суммой, известные по порядку CARD_PAYOUT_METHODS.
 * Не массив (старый бэкенд) — пусто.
 */
export const cardPayoutLines = (
  payouts: readonly IPayrollCardPayoutByMethod[] | null | undefined,
): ICardPayoutLine[] => {
  if (!Array.isArray(payouts)) return [];
  const rank = (method: string): number => CARD_PAYOUT_ORDER.get(method)?.index ?? CARD_PAYOUT_METHODS.length;
  return payouts
    .filter(payout => present(payout.amount))
    .map(payout => ({
      method: payout.method,
      label: CARD_PAYOUT_ORDER.get(payout.method)?.label ?? payout.method,
      amount: payout.amount,
    }))
    .sort((a, b) => rank(a.method) - rank(b.method) || a.method.localeCompare(b.method, 'ru'));
};

/** «Итого» ячейки «Выплаты на карту» — в копейках, NUMERIC строкой; при одном виде и меньше — null. */
export const cardPayoutsTotal = (lines: readonly ICardPayoutLine[]): string | null => {
  if (lines.length < 2) return null;
  const cents = lines.reduce((sum, line) => sum + Math.round(Number(line.amount) * 100), 0);
  return (cents / 100).toFixed(2);
};

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
  'payout', 'accrued', 'deductions', 'calc_rate', 'calc_timesheet', 'calc_overtime', 'calc_travel', 'calc_vacation',
  'calc_sick', 'calc_housing', 'paid_recalc', 'calc_supplements', 'calc_deductions', 'calc_net', 'card_payouts',
]);

/**
 * Данные строки в столбце сумм: любая сумма, в том числе 0 и минус; у «Начислено по табелю» и «Суммы» — и неполный
 * расчёт (там «—» с подписью или ⚠: выборка из одних бригад без выработки не теряет столбцы).
 */
const hasColumnData = (row: IPayrollTermsRow, column: PayrollTableColumn): boolean => {
  switch (column) {
    case 'payout': return present(row.paid_total) || present(row.paid_deductions_total);
    case 'accrued': return present(row.paid_total);
    case 'deductions': return present(row.paid_deductions_total);
    case 'calc_rate': return Boolean(row.calc?.rate);
    case 'calc_timesheet': return present(row.calc?.timesheet) || calcHasIssues(row.calc);
    case 'calc_net': return present(row.calc?.net) || calcHasIssues(row.calc);
    case 'paid_recalc': return present(row.paid_recalc_prev);
    case 'card_payouts': return cardPayoutLines(row.card_payouts_by_method).length > 0;
    default: return isCalcSumColumn(column) && present(calcSumAmount(row, column));
  }
};

/** Столбцы по расчёту ФОТ — считаются отдельным запросом после строк. */
const CALC_COLUMNS: ReadonlySet<PayrollTableColumn> = new Set<PayrollTableColumn>([
  'calc_rate', 'calc_timesheet', 'calc_overtime', 'calc_travel', 'calc_vacation', 'calc_sick', 'calc_housing',
  'calc_supplements', 'calc_deductions', 'calc_net',
]);

export const isCalcColumn = (column: PayrollTableColumn): boolean => CALC_COLUMNS.has(column);

/**
 * Столбцы сумм без данных ни в одной загруженной строке. Строк нет — ничего не скрывается (шапка не скачет).
 * Видимость — по загруженным строкам: отдел целиком в первой порции (500), на корнях компаний и «Все отделы»
 * столбец может появиться при прокрутке (продуктовое ограничение, план 27.10). Пока ФОТ считается или расчёт
 * не удался (calcReady false), столбцы ФОТ не скрываются — иначе пропадали бы и появлялись.
 */
export const emptyPayrollColumns = (
  rows: readonly IPayrollTermsRow[],
  columns: ReadonlyArray<{ key: PayrollTableColumn }>,
  calcReady = true,
): Set<PayrollTableColumn> => {
  const empty = new Set<PayrollTableColumn>();
  if (rows.length === 0) return empty;
  for (const { key } of columns) {
    if (!SUM_COLUMNS.has(key) || (!calcReady && CALC_COLUMNS.has(key))) continue;
    if (!rows.some(row => hasColumnData(row, key))) empty.add(key);
  }
  return empty;
};
