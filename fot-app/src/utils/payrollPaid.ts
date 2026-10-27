/**
 * «Оплачено» в карточке «Зарплата → Подробно»: статьи «Сводной ведомости» ЗУП строками, месяц
 * столбцом. Статьи — в двух разделах ведомости: начислено (1) и удержано (3). Только чтение:
 * суммы приходят из 1С (API или выгрузка); показываются лишь статьи, по которым сумма есть.
 * Коды статей — те же, что в CHECK миграции 334 и в payroll-paid.service.ts на сервере.
 */
import type { IEmployeePayout1c } from '../services/payroll1cPayoutsService';
import type { IPayrollPaidAmount, PayrollPaidItemCode, PayrollPaidMonths } from '../services/payrollService';
import { formatMonthsLabel } from './monthsSelection';
import { payoutsByMonth, payoutsTotal } from './payroll1cPayouts';
import { shiftMonth } from './moscowDate';

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
      { code: 'kpi', label: 'KPI' }, // Начислено по KPI — итог четырёх KPI
      { code: 'premium', label: 'Премия' }, // Премия
      { code: 'premium_contract', label: 'Премия % по договору' }, // Премия % по договору
      { code: 'gph', label: 'Выплата по договору ГПХ' }, // Выплата по договору ГПХ
      { code: 'extra_work', label: 'Допработы' }, // Допработы
      { code: 'substitution', label: 'Замещение' }, // Замещение
      { code: 'car_compensation', label: 'Компенсация использования личного а/м' }, // то же
      { code: 'deposit', label: 'Депонент' }, // Депонент
      { code: 'day_rate', label: 'Оплата по дневному тарифу' }, // Оплата по дневному тарифу
      { code: 'workwear_accrual', label: 'Спецодежда (начисление)' }, // Спецодежда в начислениях
      { code: 'advance_accrual', label: 'Аванс (начисление)' }, // «Аванс» — доп. начисление в ведомости бригады
      { code: 'fine_refund', label: 'Возврат штрафа' }, // «Возврат штрафа» — доп. начисление в ведомости бригады
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
      { code: 'vacation_deduction', label: 'Оплата отпуска (удержание)' }, // Оплата отпуска
      { code: 'loan_repayment', label: 'Погашение займа' }, // Займ
      { code: 'loan_interest', label: '% Займа' }, // % Займа
      { code: 'apartment', label: 'Квартиры' }, // Квартиры
      { code: 'imprest', label: 'Подотчёт' }, // Подотчет
      { code: 'third_party', label: 'Удержание в пользу третьего лица' }, // Удержание из ЗП сотрудника в пользу третьего лица
      { code: 'transport', label: 'Транспортные затраты' }, // Транспортные затраты
      { code: 'mobile', label: 'Моб. телефон' }, // Моб.телефон
      { code: 'bank_fees', label: 'Банковские издержки по исп. листам' }, // то же
      { code: 'alimony', label: 'Алименты' }, // Алименты
      { code: 'tmc', label: 'ТМЦ' }, // ТМЦ
      { code: 'car_rent', label: 'Удержание по договору аренды а/м' }, // то же
      { code: 'property_damage', label: 'Порча имущества' }, // «Порча имущества» в ведомости бригады
      // Перенос удержаний в ведомости бригады: долг прошлых месяцев − закрыто 1С − перенесено дальше; бывает с минусом.
      // С ней «К выплате» = выплачено по ведомости (Л/С + «К выдаче»), расшифровка — payroll_paid_debts.
      { code: 'prior_debts', label: 'Погашение долгов прошлых месяцев' },
    ],
  },
];

export const paidCellKey = (month: string, item: PayrollPaidItemCode): string => `${month}:${item}`;

/** Сумма в ячейке: с разделителем тысяч, копейки — всегда: «175 000,00», «55 057,30». */
export const formatPaidAmount = (value: number): string => value.toLocaleString('ru-RU', {
  minimumFractionDigits: 2,
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

/**
 * Месяцы выбора «Оплачено» в карточке «Подробно» (окно — по возрастанию): только те, за которые из 1С пришли суммы.
 * paidMonths = null — суммы ещё грузятся или не загрузились: всё окно, выбор не блокируется.
 */
export const paidMonthOptions = (windowMonths: readonly string[], paidMonths: ReadonlySet<string> | null): string[] => (
  paidMonths ? windowMonths.filter(month => paidMonths.has(month)) : [...windowMonths]
);

/**
 * Месяц «Оплачено» по умолчанию: последний с суммами раньше текущего (текущий ещё не закрыт); раньше текущего
 * сумм нет — последний с суммами (данные только за текущий — текущий). Сумм нет или ещё грузятся — прошлый месяц.
 * Так умолчание и «Очистить» указывают на доступный месяц, если он есть.
 */
export const defaultPaidMonth = (
  options: readonly string[],
  paidMonths: ReadonlySet<string> | null,
  currentMonth: string,
): string => {
  const previous = shiftMonth(currentMonth, -1);
  if (!paidMonths) return previous;
  return options.filter(month => month < currentMonth).at(-1) ?? options.at(-1) ?? previous;
};

/** Сколько прошлых месяцев «Расчёты» дают выбрать без сумм 1С: у них — расчёт ФОТ по закрытому табелю. */
export const CALC_RECENT_MONTHS = 6;

/**
 * Месяцы выбора «Расчётов» (столбцы по расчёту ФОТ и из 1С). Допустимы месяцы «Оплачено», месяцы ведомостей в банк
 * и CALC_RECENT_MONTHS прошлых; по умолчанию — по «Оплачено», как прежде (на нём и «Свод»). paidMonths = null —
 * месяцы 1С ещё грузятся: допустимо всё окно, выбор не блокируется. payoutMonths = null — ведомостей нет или не
 * загрузились.
 */
export const calcMonthsSelection = (input: {
  currentMonth: string;
  /** Окно выбора по возрастанию (текущий и прошлые месяцы). */
  windowMonths: readonly string[];
  paidMonths: readonly string[] | null;
  payoutMonths: readonly string[] | null;
}): { options: string[]; selectable: ReadonlySet<string> | null; defaultMonth: string } => {
  const paid = input.paidMonths ? new Set(input.paidMonths) : null;
  const recent = Array.from({ length: CALC_RECENT_MONTHS }, (_, index) => shiftMonth(input.currentMonth, -1 - index));
  const allMonths = [...new Set([...input.windowMonths, ...(input.paidMonths ?? []), ...(input.payoutMonths ?? [])])].sort();
  const selectable = paid ? new Set([...paid, ...recent, ...(input.payoutMonths ?? [])]) : null;
  return {
    options: paidMonthOptions(allMonths, selectable),
    selectable,
    defaultMonth: defaultPaidMonth(paidMonthOptions(allMonths, paid), paid, input.currentMonth),
  };
};

/**
 * Месяцы, по которым строятся таблица и «Свод». Не выбирали — умолчание. Пока суммы грузятся, выбрать можно любой
 * месяц окна — после загрузки месяцы без сумм из выбора отбрасываются, ничего не осталось — умолчание.
 * Состояние выбора не переписывается: результат производный.
 */
export const effectivePaidMonths = (
  chosen: readonly string[] | null,
  paidMonths: ReadonlySet<string> | null,
  defaultMonth: string,
): string[] => {
  if (!chosen) return [defaultMonth];
  if (!paidMonths) return [...chosen];
  const valid = chosen.filter(month => paidMonths.has(month));
  return valid.length > 0 ? valid : [defaultMonth];
};

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

/** Месяц «Истории выплат»: итоги разделов, «К выплате», статьи с суммами и «Перечислено (1С)». */
export interface IPaidHistoryMonth {
  month: string;
  totals: PayrollPaidTotals;
  payout: number | null;
  groups: IPayrollPaidGroup[];
  /** Перечислено по ведомостям выплаты 1С за месяц начисления; null — ведомостей нет. Справочно. */
  transferred: number | null;
  transfers: IEmployeePayout1c[];
}

/** Год «Истории выплат»: его месяцы (новые сверху) и итоги за год. */
export interface IPaidHistoryYear {
  year: string;
  months: IPaidHistoryMonth[];
  totals: PayrollPaidTotals;
  payout: number | null;
  transferred: number | null;
}

export interface IPaidHistory {
  /** Месяцы с суммами, новые сверху. */
  months: IPaidHistoryMonth[];
  /** Те же месяцы по годам, новые сверху. */
  years: IPaidHistoryYear[];
  amounts: ReadonlyMap<string, number>;
  overall: PayrollPaidTotals;
  overallPayout: number | null;
  overallTransferred: number | null;
}

/**
 * «История выплат» в карточке: все месяцы, за которые из 1С пришли суммы «Оплачено» или ведомости выплаты
 * (месяц может быть только с перечислением — «Начислено» и «К выплате» тогда «—»).
 */
export const paidHistory = (
  rows: readonly IPayrollPaidAmount[],
  payouts: readonly IEmployeePayout1c[] = [],
  /** Месяцы без сумм 1С, которые всё равно нужны в списке (расчёт ФОТ по закрытому табелю). */
  extraMonths: readonly string[] = [],
): IPaidHistory => {
  const transfers = payoutsByMonth(payouts);
  const months = [...new Set([...paidAmountMonths(rows), ...transfers.keys(), ...extraMonths])].sort();
  const amounts = toPaidAmounts(rows);
  const { byMonth, overall } = paidTotals(months, amounts);
  const historyMonths = [...months].reverse().map(month => ({
    month,
    totals: byMonth[month],
    payout: paidPayout(byMonth[month]),
    groups: visiblePaidGroups([month], amounts),
    transferred: transfers.get(month)?.total ?? null,
    transfers: transfers.get(month)?.documents ?? [],
  }));
  // Map хранит порядок вставки — годы тоже новые сверху.
  const byYear = new Map<string, IPaidHistoryMonth[]>();
  for (const entry of historyMonths) {
    const year = entry.month.slice(0, 4);
    byYear.set(year, [...(byYear.get(year) ?? []), entry]);
  }
  const years = [...byYear].map(([year, yearMonths]): IPaidHistoryYear => {
    const yearMonthKeys = yearMonths.map(entry => entry.month);
    const totals = paidTotals(yearMonthKeys, amounts).overall;
    return { year, months: yearMonths, totals, payout: paidPayout(totals), transferred: payoutsTotal(transfers, yearMonthKeys) };
  });
  return {
    months: historyMonths,
    years,
    amounts,
    overall,
    overallPayout: paidPayout(overall),
    overallTransferred: payoutsTotal(transfers, months),
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
