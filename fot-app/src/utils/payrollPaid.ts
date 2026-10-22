/**
 * «Оплачено» в карточке «Зарплата → Подробно»: статьи «Сводной ведомости» ЗУП строками, месяц
 * столбцом. Статьи — в двух разделах ведомости: начислено (1) и удержано (3). Только чтение:
 * суммы приходят из 1С (API или выгрузка); показываются лишь статьи, по которым сумма есть.
 * Коды статей — те же, что в CHECK миграции 301 и в payroll-paid.service.ts на сервере.
 */
import type { IPayrollPaidAmount, PayrollPaidItemCode, PayrollPaidMonths } from '../services/payrollService';
import { formatMonthsLabel } from './monthsSelection';

export interface IPayrollPaidItem {
  code: PayrollPaidItemCode;
  label: string;
}

/** Итог, в который идёт группа: раздел ведомости ЗУП. */
export type PayrollPaidTotalKind = 'accrued' | 'deducted';

export interface IPayrollPaidGroup {
  /** Подзаголовок группы в таблице; null — основные строки, без подзаголовка. */
  label: string | null;
  kind: PayrollPaidTotalKind;
  items: readonly IPayrollPaidItem[];
}

/** Группы сверху вниз. В комментарии — столбец «Сводной ведомости» ЗУП. */
export const PAYROLL_PAID_GROUPS: readonly IPayrollPaidGroup[] = [
  {
    label: null,
    kind: 'accrued',
    items: [
      { code: 'contract', label: 'По трудовому договору' }, // 1.1.1 Начислено по графику
      { code: 'bonus', label: 'Премиальная' }, // 1.1.5 Ежемесячные доплаты и премии
      { code: 'sick_leave', label: 'Больничный' }, // 1.1.4 Оплата больничных листов
      { code: 'vacation', label: 'Отпуска' }, // 1.3.13 Оплата отпуска
    ],
  },
  {
    label: 'Доп. начисления',
    kind: 'accrued',
    items: [
      { code: 'housing', label: 'Компенсация проживания' }, // 1.3.11 + 1.3.12 (в общежитии)
      { code: 'travel', label: 'Проезд' }, // 1.3.16
      { code: 'overtime', label: 'Переработка' }, // 1.1.2
      { code: 'recalc_prev', label: 'Перерасчёт за предыдущий период' }, // 1.1.6
      { code: 'severance', label: 'Выходное пособие при увольнении' }, // 1.3.2
      { code: 'supplement', label: 'Разовая доплата' }, // 1.3.5
      { code: 'planned_supplement', label: 'Плановая доплата' },
      { code: 'loan', label: 'Займ' }, // 1.3.7
    ],
  },
  {
    label: 'Удержано',
    kind: 'deducted',
    items: [
      { code: 'meals', label: 'Питание' }, // 3.13
      { code: 'workwear', label: 'Спецодежда' }, // 3.15
      { code: 'safety_fine', label: 'Нарушение техники безопасности' }, // 3.18
      { code: 'fines', label: 'Штрафы' }, // 3.21
      { code: 'writ_deduction', label: 'Удержание по исп. листу' }, // 3.20
    ],
  },
];

/**
 * Строки итогов над статьями: только общая сумма начислений — «Выплачено». Удержания видны
 * в раскрытой строке «Выплачено» (группа «Удержано»).
 */
export const PAYROLL_PAID_TOTALS: ReadonlyArray<{ kind: PayrollPaidTotalKind; label: string }> = [
  { kind: 'accrued', label: 'Выплачено' },
];

export const paidCellKey = (month: string, item: PayrollPaidItemCode): string => `${month}:${item}`;

/** Сумма в ячейке: с разделителем тысяч, копейки — только если есть: «175 000», «55 057,30». */
export const formatPaidAmount = (value: number): string => value.toLocaleString('ru-RU', {
  minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
  maximumFractionDigits: 2,
});

/** Суммы с сервера по ключу ячейки «YYYY-MM:статья»: «175000.00» → 175000. */
export const toPaidAmounts = (rows: readonly IPayrollPaidAmount[]): ReadonlyMap<string, number> => {
  const amounts = new Map<string, number>();
  for (const row of rows) {
    const value = Number(row.amount);
    if (Number.isFinite(value)) amounts.set(paidCellKey(row.month, row.item), value);
  }
  return amounts;
};

/**
 * Группы для раскрытой таблицы: только статьи, по которым есть сумма хотя бы за один месяц окна;
 * группа без таких статей не показывается.
 */
export const visiblePaidGroups = (
  months: readonly string[],
  amounts: ReadonlyMap<string, number>,
): IPayrollPaidGroup[] => PAYROLL_PAID_GROUPS
  .map(group => ({
    ...group,
    items: group.items.filter(item => months.some(month => amounts.has(paidCellKey(month, item.code)))),
  }))
  .filter(group => group.items.length > 0);

/** Итоги: null — в группе нет ни одной суммы («—»), 0 — суммы есть и дают ноль. */
export type PayrollPaidTotals = Record<PayrollPaidTotalKind, number | null>;

/** В копейках: сумма дробных рублей в float копила бы ошибку («0,1 + 0,2»). */
const addCents = (sum: number | null, value: number): number => (sum ?? 0) + Math.round(value * 100);

const centsToRub = (totals: PayrollPaidTotals): PayrollPaidTotals => ({
  accrued: totals.accrued === null ? null : totals.accrued / 100,
  deducted: totals.deducted === null ? null : totals.deducted / 100,
});

/** «Итого» статьи за выбранные месяцы: null — сумм нет ни за один («—»). */
export const paidItemTotal = (
  months: readonly string[],
  amounts: ReadonlyMap<string, number>,
  item: PayrollPaidItemCode,
): number | null => {
  let cents: number | null = null;
  for (const month of months) {
    const value = amounts.get(paidCellKey(month, item));
    if (value !== undefined) cents = addCents(cents, value);
  }
  return cents === null ? null : cents / 100;
};

/** Итоги начислений и удержаний по месяцам и за всё окно. */
export const paidTotals = (
  months: readonly string[],
  amounts: ReadonlyMap<string, number>,
): { byMonth: Record<string, PayrollPaidTotals>; overall: PayrollPaidTotals } => {
  const byMonth: Record<string, PayrollPaidTotals> = {};
  const overall: PayrollPaidTotals = { accrued: null, deducted: null };
  for (const month of months) {
    const cents: PayrollPaidTotals = { accrued: null, deducted: null };
    for (const group of PAYROLL_PAID_GROUPS) {
      for (const item of group.items) {
        const value = amounts.get(paidCellKey(month, item.code));
        if (value === undefined) continue;
        cents[group.kind] = addCents(cents[group.kind], value);
        overall[group.kind] = addCents(overall[group.kind], value);
      }
    }
    byMonth[month] = centsToRub(cents);
  }
  return { byMonth, overall: centsToRub(overall) };
};

/** Месяцы, за которые есть суммы, — по возрастанию, без повторов (окно удержаний на «Расчётах», и для «весь период»). */
export const paidAmountMonths = (rows: readonly IPayrollPaidAmount[]): string[] => (
  [...new Set(rows.map(row => row.month))].sort()
);

/** Период сумм «Расчётов»: 'all' или пусто — «весь период», как у «Свода». */
export const formatPaidPeriod = (months: PayrollPaidMonths): string => (
  months === 'all' || months.length === 0 ? 'весь период' : formatMonthsLabel(months)
);

/** «К выплате» — начислено минус удержано, как в «Своде»; null — сумм нет ни в одном разделе. */
export const paidPayout = (totals: PayrollPaidTotals): number | null => (
  totals.accrued === null && totals.deducted === null
    ? null
    : (Math.round((totals.accrued ?? 0) * 100) - Math.round((totals.deducted ?? 0) * 100)) / 100
);

/** Месяц «Истории выплат»: итоги разделов, «К выплате» и статьи с суммами. */
export interface IPaidHistoryMonth {
  month: string;
  totals: PayrollPaidTotals;
  payout: number | null;
  groups: IPayrollPaidGroup[];
}

/** Год «Истории выплат»: его месяцы (новые сверху) и итоги за год. */
export interface IPaidHistoryYear {
  year: string;
  months: IPaidHistoryMonth[];
  totals: PayrollPaidTotals;
  payout: number | null;
}

export interface IPaidHistory {
  /** Месяцы с суммами, новые сверху. */
  months: IPaidHistoryMonth[];
  /** Те же месяцы по годам, новые сверху. */
  years: IPaidHistoryYear[];
  amounts: ReadonlyMap<string, number>;
  overall: PayrollPaidTotals;
  overallPayout: number | null;
}

/** «История выплат» в карточке: все месяцы, за которые из 1С пришли суммы. */
export const paidHistory = (rows: readonly IPayrollPaidAmount[]): IPaidHistory => {
  const months = paidAmountMonths(rows);
  const amounts = toPaidAmounts(rows);
  const { byMonth, overall } = paidTotals(months, amounts);
  const historyMonths = [...months].reverse().map(month => ({
    month,
    totals: byMonth[month],
    payout: paidPayout(byMonth[month]),
    groups: visiblePaidGroups([month], amounts),
  }));
  // Map хранит порядок вставки — годы тоже новые сверху.
  const byYear = new Map<string, IPaidHistoryMonth[]>();
  for (const entry of historyMonths) {
    const year = entry.month.slice(0, 4);
    byYear.set(year, [...(byYear.get(year) ?? []), entry]);
  }
  const years = [...byYear].map(([year, yearMonths]): IPaidHistoryYear => {
    const totals = paidTotals(yearMonths.map(entry => entry.month), amounts).overall;
    return { year, months: yearMonths, totals, payout: paidPayout(totals) };
  });
  return {
    months: historyMonths,
    years,
    amounts,
    overall,
    overallPayout: paidPayout(overall),
  };
};

/** Начало окна «за всё время» — раньше любых сумм ЗУП. */
export const PAYROLL_PAID_ALL_FROM = '2000-01';

/**
 * Окно запроса сумм для месяцев «Расчётов»: выбранные — от первого до последнего (лишние месяцы
 * отсекает pickPaidRows), 'all' или пусто — за всё время по текущий месяц.
 */
export const paidMonthsRange = (months: PayrollPaidMonths, currentMonth: string): { from: string; to: string } => {
  if (months === 'all' || months.length === 0) return { from: PAYROLL_PAID_ALL_FROM, to: currentMonth };
  const sorted = [...months].sort();
  return { from: sorted[0], to: sorted[sorted.length - 1] };
};

/** Суммы только выбранных месяцев (выбор может идти вразброс); 'all' или пусто — все. */
export const pickPaidRows = (rows: readonly IPayrollPaidAmount[], months: PayrollPaidMonths): IPayrollPaidAmount[] => {
  if (months === 'all' || months.length === 0) return [...rows];
  const selected = new Set(months);
  return rows.filter(row => selected.has(row.month));
};

const KIND_CODES: Record<PayrollPaidTotalKind, ReadonlySet<PayrollPaidItemCode>> = {
  accrued: new Set(PAYROLL_PAID_GROUPS.filter(group => group.kind === 'accrued').flatMap(group => group.items.map(item => item.code))),
  deducted: new Set(PAYROLL_PAID_GROUPS.filter(group => group.kind === 'deducted').flatMap(group => group.items.map(item => item.code))),
};

/** Суммы статей одного раздела ведомости: начисления или удержания. */
export const pickPaidKind = (rows: readonly IPayrollPaidAmount[], kind: PayrollPaidTotalKind): IPayrollPaidAmount[] => (
  rows.filter(row => KIND_CODES[kind].has(row.item))
);
