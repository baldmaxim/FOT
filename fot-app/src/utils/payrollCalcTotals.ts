/**
 * Строка «Итого» на «Расчётах» (решение пользователя 05.11.2026): суммы столбцов по всей выборке, из тех же значений,
 * что в ячейках, в целых копейках (sumAmounts) — итог всегда равен сумме строк на экране. Пока порции и расчёт ФОТ не
 * завершены, итога нет («…»): частичная сумма выглядела бы как полная.
 *
 * У «Подразделения», «Должности», «Графика» и «Оклада» итога нет: оклады и почасовые ставки не складываются.
 * «Сумма», «Остаток к выплате» и «Начислено по табелю» неполного расчёта не знают — такие люди считаются отдельно
 * («без N чел.», причины в подсказке), чтобы итог не казался полным.
 */
import type { IPayrollTermsRow } from '../services/payrollService';
import {
  CALC_ISSUE_LABELS,
  calcSumAmount,
  cardPayoutLines,
  isCalcColumn,
  isCalcSumColumn,
  sumAmounts,
} from './payrollCalcColumns';
import type { PayrollTableColumn } from './payrollColumns';
import { formatPaidAmount } from './payrollPaid';
import { subColumnAmount, type PayrollTableColumnEntry } from './payrollSubColumns';

export interface IPayrollColumnTotal {
  /** Сумма столбца, NUMERIC строкой; ни одной суммы — null («—»). */
  amount: string | null;
  /** Столбец ФОТ: готов, только когда посчитаны все порции. */
  fromCalc: boolean;
  /** Сколько человек не вошло в сумму из-за неполного расчёта. */
  missing: number;
  /** Подсказка: кто не вошёл или из чего сумма; нечего сказать — null. */
  title: string | null;
}

/** Что готово: порции списка и расчёт ФОТ. */
export type PayrollTotalsPart = 'pending' | 'ready' | 'failed';

export interface IPayrollTotalsStatus {
  rows: PayrollTotalsPart;
  calc: PayrollTotalsPart;
}

/** Состояние ячейки: без всех строк итога нет ни у какого столбца, столбцу ФОТ нужен ещё и его расчёт. */
export const payrollTotalState = (status: IPayrollTotalsStatus, fromCalc: boolean): PayrollTotalsPart => {
  if (status.rows !== 'ready') return status.rows;
  return fromCalc ? status.calc : 'ready';
};

/** Столбцы, где «—» может означать «не посчитано», а не «нечего платить». */
const MISSING_COLUMNS: ReadonlySet<PayrollTableColumn> = new Set<PayrollTableColumn>([
  'calc_net', 'calc_remainder', 'calc_timesheet',
]);

/**
 * Почему суммы строки нет; пусто — считать нечего. «Нет дней в табеле» сюда не входит: это ноль, а не пропуск.
 * Нет поля calc — ФОТ за период не считается вообще (столбцы скрыты), не пропуск.
 */
const unknownReasons = (row: IPayrollTermsRow): string[] => {
  if (!('calc' in row)) return [];
  if (!row.calc) return [CALC_ISSUE_LABELS.unknown_amount];
  const reasons = row.calc.incomplete
    .flatMap(item => item.reasons)
    .filter(reason => reason !== 'no_days')
    .map(reason => CALC_ISSUE_LABELS[reason]);
  return row.calc.open_months.length > 0 ? [...reasons, CALC_ISSUE_LABELS.unknown_amount] : reasons;
};

/** Сумма столбца в строке: то же значение, что в ячейке. У столбца без итога (hasTotal) — null. */
const entryAmount = (row: IPayrollTermsRow, entry: PayrollTableColumnEntry): string | null => {
  if (entry.kind === 'sub') return subColumnAmount(row, entry.sub);
  const column = entry.key;
  if (column === 'deductions') return row.paid_deductions_total ?? null;
  if (column === 'paid_recalc') return row.paid_recalc_prev ?? null;
  if (column === 'card_payouts') return sumAmounts(cardPayoutLines(row.card_payouts_by_method).map(line => line.amount));
  return column === 'calc_remainder' || isCalcSumColumn(column) ? calcSumAmount(row, column) : null;
};

/** Столбцы сумм; подстолбцы «+» — всегда суммы. */
const hasTotal = (entry: PayrollTableColumnEntry): boolean => (
  entry.kind === 'sub'
  || entry.key === 'deductions' || entry.key === 'paid_recalc' || entry.key === 'card_payouts'
  || entry.key === 'calc_remainder' || isCalcSumColumn(entry.key)
);

/** Подсказка итога «Выплат на карту»: виды выплат теми же подписями и в том же порядке, что в ячейке. */
const cardPayoutsTitle = (rows: readonly IPayrollTermsRow[]): string | null => {
  const cents = new Map<string, number>();
  for (const row of rows) {
    for (const line of cardPayoutLines(row.card_payouts_by_method)) {
      cents.set(line.method, (cents.get(line.method) ?? 0) + Math.round(Number(line.amount) * 100));
    }
  }
  const lines = cardPayoutLines([...cents].map(([method, sum]) => ({ method, amount: (sum / 100).toFixed(2) })));
  return lines.length > 0 ? lines.map(line => `${line.label}: ${formatPaidAmount(Number(line.amount))}`).join('\n') : null;
};

const missingTotal = (
  rows: readonly IPayrollTermsRow[],
  entry: PayrollTableColumnEntry,
): Pick<IPayrollColumnTotal, 'missing' | 'title'> => {
  if (entry.kind !== 'column' || !MISSING_COLUMNS.has(entry.key)) return { missing: 0, title: null };
  let missing = 0;
  const labels = new Set<string>();
  for (const row of rows) {
    if (entryAmount(row, entry) !== null) continue;
    const reasons = unknownReasons(row);
    if (reasons.length === 0) continue;
    missing += 1;
    reasons.forEach(reason => labels.add(reason));
  }
  return { missing, title: missing > 0 ? `Не вошли ${missing} чел.: ${[...labels].join(', ')}` : null };
};

/** Итоги столбцов по ключу записи; столбца без итога в ответе нет. */
export const payrollColumnTotals = (
  rows: readonly IPayrollTermsRow[],
  entries: readonly PayrollTableColumnEntry[],
): Map<string, IPayrollColumnTotal> => {
  const totals = new Map<string, IPayrollColumnTotal>();
  for (const entry of entries) {
    if (!hasTotal(entry)) continue;
    const fromCalc = entry.kind === 'sub' ? entry.sub.type !== 'paid' : isCalcColumn(entry.key);
    const { missing, title } = missingTotal(rows, entry);
    totals.set(entry.key, {
      amount: sumAmounts(rows.map(row => entryAmount(row, entry))),
      fromCalc,
      missing,
      title: entry.kind === 'column' && entry.key === 'card_payouts' ? cardPayoutsTitle(rows) : title,
    });
  }
  return totals;
};
