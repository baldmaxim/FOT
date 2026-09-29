import type {
  IObjectKpiExportTable,
  IObjectKpiObjectStat,
  IObjectKpiReportRow,
  IPeriod,
  IReportPremiumRow,
  ObjectKpiExportColumnType,
} from '../api/objectKpi';
import { formatMoneyShort, formatMonthLabel, formatPercent } from './formatMoney';
import { shiftMonth } from './moscowDate';
import { PREMIUM_STATUS_SHORT, PREMIUM_STATUS_TEXT } from './premiumStatus';

/**
 * Таблицы вкладки «KPI объектов»: описания столбцов, сортировка, фильтры и снимок для xlsx.
 *
 * Строк не больше пары десятков (объекты или месяцы одного объекта), поэтому сортировка и
 * фильтры — на клиенте. Экран, варианты фильтра и снимок экспорта строятся из одних и тех же
 * описаний: выгрузка не может разойтись с тем, что видит пользователь. Деньги здесь не
 * считаются — только сравниваются и передаются как пришли с сервера.
 */

export type SortDir = 'asc' | 'desc';

export interface IKpiTableView {
  sort: string;
  dir: SortDir;
  /** Столбец → выбранные тексты ячеек. */
  filters: Record<string, string[]>;
}

/** Класс ширины колонки в ObjectKpiTable.module.css. */
export type KpiColumnWidth = 'colObject' | 'colManager' | 'colMonth' | 'colMoney' | 'colPercent' | 'colShort';

export interface IKpiColumn<Row> {
  key: string;
  label: string;
  type: ObjectKpiExportColumnType;
  width: KpiColumnWidth;
  /** Подсказка заголовка. */
  title?: string;
  /** Текст ячейки на экране — он же значение в фильтре столбца. */
  text: (row: Row) => string;
  /** Значение сортировки; null — в конце при любом направлении. */
  sortValue: (row: Row) => number | string | null;
  /** Точное значение для xlsx (сумма — строкой numeric, как с сервера); null — текст экрана. */
  exportValue?: (row: Row) => string | number | null;
}

export interface IFilterOption {
  value: string;
  count: number;
}

const toSortNumber = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
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

/** Таблица «Все объекты»: строка на объект за выбранные месяцы. */
export const OBJECT_STAT_COLUMNS: ReadonlyArray<IKpiColumn<IObjectKpiObjectStat>> = [
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
  moneyColumn('contract', 'Договор с ДС', row => row.contract_total),
  moneyColumn('ks6', 'КС-6', row => row.ks2_cumulative_before),
  moneyColumn('remainder', 'Остаток', row => row.remainder),
  moneyColumn('ks2', 'КС-2', row => row.fact_amount),
  moneyColumn('plan', 'План', row => row.plan_amount),
  percentColumn(row => row.completion_pct),
];

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

/** Строка проходит фильтры всех столбцов, кроме skipKey (варианты самого столбца — без его фильтра). */
const passesFilters = <Row,>(
  row: Row,
  columns: ReadonlyArray<IKpiColumn<Row>>,
  filters: Record<string, string[]>,
  skipKey?: string,
): boolean => columns.every((column) => {
  if (column.key === skipKey) return true;
  const selected = filters[column.key];
  return !selected || selected.length === 0 || selected.includes(column.text(row));
});

const compareValues = (a: number | string, b: number | string): number => (
  typeof a === 'number' && typeof b === 'number'
    ? a - b
    : String(a).localeCompare(String(b), 'ru', { numeric: true, sensitivity: 'base' })
);

/** Сравнение для сортировки: пустые — в конце при любом направлении, как у кадров. */
const compareSortEntries = (
  a: number | string | null,
  b: number | string | null,
  factor: number,
): number => {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compareValues(a, b) * factor;
};

/** Видимые строки: фильтры столбцов, затем сортировка (устойчивая — равные в прежнем порядке). */
export const applyTableView = <Row,>(
  rows: ReadonlyArray<Row>,
  columns: ReadonlyArray<IKpiColumn<Row>>,
  view: IKpiTableView,
): Row[] => {
  const filtered = rows.filter(row => passesFilters(row, columns, view.filters));
  const column = columns.find(item => item.key === view.sort);
  if (!column) return filtered;
  const factor = view.dir === 'asc' ? 1 : -1;
  return filtered
    .map((row, index) => ({ row, index, value: column.sortValue(row) }))
    .sort((a, b) => compareSortEntries(a.value, b.value, factor) || a.index - b.index)
    .map(item => item.row);
};

/**
 * Варианты фильтра столбца со счётчиками — по строкам, прошедшим фильтры ОСТАЛЬНЫХ столбцов
 * (как у кадров). Выбранные значения, которых в строках больше нет (сменили месяцы), остаются
 * в списке с нулём: иначе снять такую галочку было бы нечем.
 */
export const columnFilterOptions = <Row,>(
  rows: ReadonlyArray<Row>,
  columns: ReadonlyArray<IKpiColumn<Row>>,
  filters: Record<string, string[]>,
  key: string,
): IFilterOption[] => {
  const column = columns.find(item => item.key === key);
  if (!column) return [];

  const entries = new Map<string, { count: number; sort: number | string | null }>();
  for (const row of rows) {
    if (!passesFilters(row, columns, filters, key)) continue;
    const text = column.text(row);
    const entry = entries.get(text);
    if (entry) entry.count += 1;
    else entries.set(text, { count: 1, sort: column.sortValue(row) });
  }
  for (const value of filters[key] ?? []) {
    if (!entries.has(value)) entries.set(value, { count: 0, sort: null });
  }

  return [...entries.entries()]
    .sort(([, a], [, b]) => compareSortEntries(a.sort, b.sort, 1))
    .map(([value, entry]) => ({ value, count: entry.count }));
};

export const isColumnFiltered = (view: IKpiTableView, key: string): boolean =>
  (view.filters[key]?.length ?? 0) > 0;

/** Повторный клик по столбцу меняет направление, другой столбец — по возрастанию. */
export const toggleSort = (view: IKpiTableView, key: string): IKpiTableView => (
  view.sort === key
    ? { ...view, dir: view.dir === 'asc' ? 'desc' : 'asc' }
    : { ...view, sort: key, dir: 'asc' }
);

/** Фильтр одного столбца; null или пустой список — снять. */
export const setColumnFilter = (view: IKpiTableView, key: string, values: string[] | null): IKpiTableView => {
  const filters = { ...view.filters };
  if (values && values.length > 0) filters[key] = values;
  else delete filters[key];
  return { ...view, filters };
};

/** Снимок таблицы для xlsx: «№» и столбцы экрана, строки — видимые, в порядке экрана. */
export const buildExportTable = <Row,>(params: {
  title: string;
  subtitle: string;
  fileName: string;
  columns: ReadonlyArray<IKpiColumn<Row>>;
  rows: ReadonlyArray<Row>;
  isMuted?: (row: Row) => boolean;
}): IObjectKpiExportTable => ({
  title: params.title,
  subtitle: params.subtitle,
  file_name: params.fileName,
  columns: [
    { label: '№', type: 'int' },
    ...params.columns.map(column => ({ label: column.label, type: column.type })),
  ],
  rows: params.rows.map((row, index) => ({
    cells: [index + 1, ...params.columns.map(column => column.exportValue?.(row) ?? column.text(row))],
    ...(params.isMuted?.(row) ? { muted: true } : {}),
  })),
});

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

/** «август 2026»; подряд — «июль 2026 — сентябрь 2026»; вразброс — «июль 2026, сентябрь 2026». */
export const formatMonthsLabel = (months: ReadonlyArray<string>): string => {
  const sorted = [...months].sort();
  if (sorted.length === 0) return '';
  const label = (month: string) => formatMonthLabel(`${month}-01`);
  if (sorted.length === 1) return label(sorted[0]);
  const contiguous = sorted.every((month, index) => index === 0 || shiftMonth(sorted[index - 1], 1) === month);
  return contiguous
    ? `${label(sorted[0])} — ${label(sorted[sorted.length - 1])}`
    : sorted.map(label).join(', ');
};
