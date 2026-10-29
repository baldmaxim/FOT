import type {
  IObjectKpiObjectStat,
  IObjectKpiReportRow,
  IPeriod,
  IReportPremiumRow,
} from '../api/objectKpi';
import { formatMoneyShort, formatMonthLabel, formatPercent } from './formatMoney';
import { shiftMonth } from './moscowDate';
import { PREMIUM_STATUS_SHORT, PREMIUM_STATUS_TEXT } from './premiumStatus';
import type { ITableColumn, ITableView } from './tableView';

/**
 * Таблицы вкладки «KPI объектов»: описания столбцов, сортировка, фильтры и снимок для xlsx.
 *
 * Строк не больше пары десятков (объекты или месяцы одного объекта), поэтому сортировка и
 * фильтры — на клиенте (общие функции — в tableView.ts). Деньги здесь сравниваются и передаются
 * как пришли с сервера; складывается только строка «Итого» (sumMoneyColumns) — в копейках.
 */

export {
  applyTableView,
  buildExportTable,
  columnFilterOptions,
  isColumnFiltered,
  setColumnFilter,
  toggleSort,
} from './tableView';
export type { IFilterOption, SortDir } from './tableView';

export type IKpiTableView = ITableView;

/** Класс ширины колонки в ObjectKpiTable.module.css. */
export type KpiColumnWidth = 'colObject' | 'colManager' | 'colMonth' | 'colMoney' | 'colPercent' | 'colShort';

export interface IKpiColumn<Row> extends ITableColumn<Row> {
  width: KpiColumnWidth;
}

const toSortNumber = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

/** Строка numeric «-123.45» из целых копеек — без float-деления. */
const formatKopecks = (kopecks: number): string => {
  const abs = Math.abs(kopecks);
  return `${kopecks < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

/**
 * Итоги денежных столбцов по переданным (видимым) строкам: ключ — column.key, сумма — строкой
 * numeric, как суммы с сервера; null — в столбце нет ни одного значения. Складываем целыми
 * копейками: сумма сотни миллиардов с дробями во float накопила бы ошибку округления.
 */
export const sumMoneyColumns = <Row,>(
  rows: ReadonlyArray<Row>,
  columns: ReadonlyArray<IKpiColumn<Row>>,
): Record<string, string | null> => {
  const totals: Record<string, string | null> = {};
  for (const column of columns) {
    if (column.type !== 'money' || !column.exportValue) continue;
    let kopecks: number | null = null;
    for (const row of rows) {
      const value = toSortNumber(column.exportValue(row));
      if (value !== null) kopecks = (kopecks ?? 0) + Math.round(value * 100);
    }
    totals[column.key] = kopecks === null ? null : formatKopecks(kopecks);
  }
  return totals;
};

const moneyColumn = <Row,>(
  key: string,
  label: string,
  value: (row: Row) => string | number | null,
  title?: string,
): IKpiColumn<Row> => ({
  key,
  label,
  type: 'money',
  width: 'colMoney',
  title,
  text: row => formatMoneyShort(value(row)),
  sortValue: row => toSortNumber(value(row)),
  exportValue: row => value(row),
});

const percentColumn = <Row,>(value: (row: Row) => string | number | null): IKpiColumn<Row> => ({
  key: 'pct',
  label: '%',
  type: 'percent',
  width: 'colPercent',
  text: row => formatPercent(value(row)),
  sortValue: row => toSortNumber(value(row)),
  exportValue: row => value(row),
});

/** Премия руководителя в строке месяца: состояние запроса, скрытые руководители, статусы. */
export interface IPremiumView {
  state: 'loading' | 'error' | 'ready';
  /** Ключ — «руководитель|месяц»: премия по приказу принадлежит человеку, а не объекту. */
  byKey: ReadonlyMap<string, IReportPremiumRow>;
  /** Руководители с объектами вне скоупа зрителя: совокупную премию не показываем вовсе. */
  hidden: ReadonlySet<number>;
}

export interface IPremiumCell {
  text: string;
  title?: string;
  muted: boolean;
  /** Сумма рассчитанной премии; null — в ячейке подпись, а не деньги. */
  amount: string | null;
}

/** Состояния колонки «Премия»: считается, ошибка, скрыта по доступу, не рассчитана. */
export const premiumCell = (row: IObjectKpiReportRow, premium: IPremiumView): IPremiumCell => {
  const managerId = row.primary_manager_id;
  if (!managerId) return { text: '—', title: 'За месяц нет закреплённого руководителя', muted: false, amount: null };
  if (premium.state === 'loading') return { text: '…', muted: true, amount: null };
  if (premium.state === 'error') return { text: 'н/д', title: 'Не удалось рассчитать премию', muted: true, amount: null };
  if (premium.hidden.has(managerId)) {
    return {
      text: '—',
      title: 'Недоступно: у руководителя есть объекты вне вашего доступа',
      muted: true,
      amount: null,
    };
  }

  const item = premium.byKey.get(`${managerId}|${row.period_month}`);
  if (!item) return { text: '—', title: 'Премия за этот месяц не рассчитывалась', muted: false, amount: null };
  if (item.status !== 'calculated') {
    return {
      text: PREMIUM_STATUS_SHORT[item.status],
      title: PREMIUM_STATUS_TEXT[item.status],
      muted: true,
      amount: null,
    };
  }
  return {
    text: formatMoneyShort(item.premium_amount),
    title: 'Совокупно за все объекты руководителя (п. 3.5)',
    muted: false,
    amount: item.premium_amount,
  };
};

/** Ключ премии в IPremiumView.byKey. */
const premiumKey = (employeeId: number, periodMonth: string): string => `${employeeId}|${periodMonth}`;

/** Премия пары в копейках; null — не рассчитана или сумма не число. Ноль — валидная премия. */
const calculatedKopecks = (item: IReportPremiumRow | undefined): number | null => {
  if (!item || item.status !== 'calculated') return null;
  const value = toSortNumber(item.premium_amount);
  return value === null ? null : Math.round(value * 100);
};

/**
 * Премия строки «Все объекты» — общий разбор для ячейки и «Итого», чтобы они не разошлись.
 * keys — уникальные пары «руководитель|месяц» строки; calculated — рассчитанные из них.
 */
interface IObjectPremiumState {
  kind: 'no_manager' | 'loading' | 'error' | 'hidden' | 'ready';
  keys: string[];
  calculated: Map<string, number>;
}

const objectPremiumState = (row: IObjectKpiObjectStat, premium: IPremiumView): IObjectPremiumState => {
  const pairs = new Map<string, number>();
  for (const item of row.manager_months ?? []) {
    pairs.set(premiumKey(item.employee_id, item.period_month), item.employee_id);
  }
  const keys = [...pairs.keys()];
  const calculated = new Map<string, number>();
  if (keys.length === 0) return { kind: 'no_manager', keys, calculated };
  if (premium.state !== 'ready') return { kind: premium.state, keys, calculated };
  // Хоть один руководитель скрыт — скрыта вся строка: частичная сумма выглядела бы полной.
  if ([...pairs.values()].some(id => premium.hidden.has(id))) return { kind: 'hidden', keys, calculated };

  for (const key of keys) {
    const kopecks = calculatedKopecks(premium.byKey.get(key));
    if (kopecks !== null) calculated.set(key, kopecks);
  }
  return { kind: 'ready', keys, calculated };
};

/**
 * «Премия» в строке объекта за выбранные месяцы: сумма рассчитанных месяцев основных
 * руководителей. Не рассчитано ни одного — подпись статуса, если он у всех месяцев один.
 */
export const objectPremiumCell = (row: IObjectKpiObjectStat, premium: IPremiumView): IPremiumCell => {
  const state = objectPremiumState(row, premium);
  if (state.kind === 'no_manager') {
    return { text: '—', title: 'За выбранные месяцы нет закреплённого руководителя', muted: false, amount: null };
  }
  if (state.kind === 'loading') return { text: '…', muted: true, amount: null };
  if (state.kind === 'error') return { text: 'н/д', title: 'Не удалось рассчитать премию', muted: true, amount: null };
  if (state.kind === 'hidden') {
    return {
      text: '—',
      title: 'Недоступно: у руководителя есть объекты вне вашего доступа',
      muted: true,
      amount: null,
    };
  }

  if (state.calculated.size > 0) {
    let kopecks = 0;
    for (const value of state.calculated.values()) kopecks += value;
    const amount = formatKopecks(kopecks);
    const partial = state.calculated.size < state.keys.length
      ? `. Рассчитана только часть периода: ${state.calculated.size} из ${state.keys.length} мес.`
      : '';
    return {
      text: formatMoneyShort(amount),
      title: `Совокупно за все объекты руководителя (п. 3.5)${partial}`,
      muted: false,
      amount,
    };
  }

  const statuses = new Set(state.keys.map(key => premium.byKey.get(key)?.status ?? null));
  const [status] = statuses;
  if (statuses.size === 1 && status && status !== 'calculated') {
    return { text: PREMIUM_STATUS_SHORT[status], title: PREMIUM_STATUS_TEXT[status], muted: true, amount: null };
  }
  return { text: '—', title: 'Премия за выбранные месяцы не рассчитана', muted: false, amount: null };
};

/**
 * «Итого» премии по видимым строкам: каждая пара «руководитель|месяц» один раз — у руководителя
 * двух объектов одна и та же премия стоит в обеих строках. Скрытые строки в итог не идут.
 */
export const objectPremiumTotal = (
  rows: ReadonlyArray<IObjectKpiObjectStat>,
  premium: IPremiumView,
): string | null => {
  if (premium.state !== 'ready') return null;
  const pairs = new Map<string, number>();
  for (const row of rows) {
    const state = objectPremiumState(row, premium);
    if (state.kind !== 'ready') continue;
    for (const [key, kopecks] of state.calculated) pairs.set(key, kopecks);
  }
  if (pairs.size === 0) return null;
  let kopecks = 0;
  for (const value of pairs.values()) kopecks += value;
  return formatKopecks(kopecks);
};

/**
 * Таблица «Все объекты»: строка на объект за выбранные месяцы. «Премия» — после руководителя:
 * она принадлежит ему, а не объекту (п. 3.5).
 */
export const buildObjectColumns = (premium: IPremiumView): Array<IKpiColumn<IObjectKpiObjectStat>> => [
  {
    key: 'object',
    label: 'Объект',
    type: 'text',
    width: 'colObject',
    text: row => row.object_name,
    sortValue: row => row.object_name,
  },
  {
    key: 'manager',
    label: 'Руководитель',
    type: 'text',
    width: 'colManager',
    text: row => row.manager_names.join(', ') || '—',
    sortValue: row => row.manager_names.join(', ') || null,
  },
  {
    key: 'premium',
    label: 'Премия',
    type: 'money',
    width: 'colMoney',
    text: row => objectPremiumCell(row, premium).text,
    sortValue: row => toSortNumber(objectPremiumCell(row, premium).amount),
    exportValue: row => objectPremiumCell(row, premium).amount,
  },
  moneyColumn('contract', 'Договор с ДС', row => row.contract_total),
  moneyColumn('ks6', 'КС-6', row => row.ks2_cumulative_before),
  moneyColumn('remainder', 'Остаток', row => row.remainder),
  moneyColumn('ks2', 'КС-2', row => row.fact_amount),
  moneyColumn('plan', 'План', row => row.plan_amount),
  percentColumn(row => row.completion_pct),
];

/**
 * Таблица объекта по месяцам. КС-6 — сумма КС-2 за все прошлые месяцы (со стартом из ручного
 * остатка), поэтому в каждой строке «Договор − КС-6 = Остаток» (п. 2.2). КС-2 — акты месяца,
 * у прогнозного месяца — его план.
 */
export const buildMonthColumns = (premium: IPremiumView): Array<IKpiColumn<IObjectKpiReportRow>> => [
  {
    key: 'premium',
    label: 'Премия',
    type: 'money',
    width: 'colMoney',
    text: row => premiumCell(row, premium).text,
    sortValue: row => toSortNumber(premiumCell(row, premium).amount),
    exportValue: row => premiumCell(row, premium).amount,
  },
  {
    key: 'month',
    label: 'Месяц',
    type: 'text',
    width: 'colMonth',
    text: row => formatMonthLabel(row.period_month),
    sortValue: row => row.period_month,
  },
  {
    key: 'manager',
    label: 'Руководитель',
    type: 'text',
    width: 'colManager',
    text: row => row.primary_manager_name ?? '—',
    sortValue: row => row.primary_manager_name,
  },
  moneyColumn('contract', 'Договор с ДС', row => row.contract_total),
  moneyColumn('ks6', 'КС-6', row => row.ks2_cumulative_before),
  moneyColumn('remainder', 'Остаток', row => row.remainder),
  moneyColumn(
    'ks2',
    'КС-2',
    row => row.fact_amount,
    'Подписано за месяц, с учётом уменьшений объёма (п. 3.1, 3.3)',
  ),
  {
    key: 'months_left',
    label: 'Мес.',
    type: 'int',
    width: 'colShort',
    text: row => (row.months_remaining === null ? '—' : String(row.months_remaining)),
    sortValue: row => row.months_remaining,
    exportValue: row => row.months_remaining,
  },
  moneyColumn('plan', 'План месяца', row => row.plan_amount),
  percentColumn(row => row.completion_pct),
];

/** Месяцы окна расчёта по порядку (YYYY-MM). */
export const listWindowMonths = (period: IPeriod): string[] => {
  const result: string[] = [];
  for (let month = period.from; month <= period.to; month = shiftMonth(month, 1)) {
    result.push(month);
    if (result.length > 240) break;  // страховка от кривого окна
  }
  return result;
};

/** Месяц по умолчанию — прошлый (от текущего месяца сервера), если он есть в окне; иначе весь период. */
export const defaultMonths = (options: ReadonlyArray<string>, currentMonth: string): string[] => {
  const previous = shiftMonth(currentMonth, -1);
  return options.includes(previous) ? [previous] : [];
};

/** Параметры запроса премии; null — запрос ещё рано слать. */
export interface IPremiumRequest {
  period: IPeriod | null;
  objectId: string | null;
  months: string[] | null;
}

/**
 * Когда и с чем звать премию. С объектом — по его полному окну (месяцы режет таблица), как
 * раньше. «Все объекты» — только после базового окна: иначе первым ушёл бы тяжёлый запрос за
 * весь период, а за ним второй — за месяц по умолчанию. Пустой выбор — «весь период».
 */
export const objectPremiumRequest = (params: {
  objectId: string;
  tablePeriod: IPeriod | undefined;
  basePeriod: IPeriod | undefined;
  activeMonths: ReadonlyArray<string>;
}): IPremiumRequest | null => {
  if (params.objectId) {
    return params.tablePeriod ? { period: params.tablePeriod, objectId: params.objectId, months: null } : null;
  }
  if (!params.basePeriod) return null;
  return {
    period: null,
    objectId: null,
    months: params.activeMonths.length > 0 ? [...params.activeMonths].sort() : null,
  };
};
