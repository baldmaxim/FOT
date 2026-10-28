/**
 * «Свод» на «Расчётах»: строки сервера (сотрудник × объект × категория) → таблица объектов и таблица
 * сотрудников объекта. Суммы складываются в копейках; столбцы статей — только с ненулевыми суммами в
 * выбранной категории, в порядке и с подписями «Оплачено» (PAYROLL_PAID_GROUPS; «По трудовому договору» —
 * здесь «Зарплата»). Перед статьями — «К выплате», «Всего начислено» и «Всего удержано».
 * Экран и xlsx строятся из одних описаний столбцов (tableView.ts).
 */
import type { PayrollPaidItemCode, StaffCategory } from '../services/payrollService';
import type { IPayrollSummaryRow } from '../services/payrollSummaryService';
import { formatMonthsLabel } from './monthsSelection';
import { moscowTodayIso } from './moscowDate';
import { formatPaidAmount, PAYROLL_PAID_GROUPS, type PayrollPaidTotalKind } from './payrollPaid';
import { buildExportTable, REGISTRY_HEADER_EXTRA, type IRegistryColumn, type ITableExportSnapshot } from './tableView';

export type SummaryCategory = 'all' | StaffCategory;

/** Переключатель над таблицей. */
export const SUMMARY_CATEGORIES: ReadonlyArray<{ key: SummaryCategory; label: string }> = [
  { key: 'all', label: 'Все' },
  { key: 'itr', label: 'ИТР' },
  { key: 'office', label: 'Офис' },
  { key: 'worker', label: 'Рабочие' },
];

export const SUMMARY_CATEGORY_LABELS: Record<StaffCategory, string> = { itr: 'ИТР', office: 'Офис', worker: 'Рабочие' };

const ITEM_KIND = new Map<PayrollPaidItemCode, PayrollPaidTotalKind>(
  PAYROLL_PAID_GROUPS.flatMap(group => group.items.map(item => [item.code, group.kind] as const)),
);
/** Подписи «Свода», отличные от «Оплачено». */
const SUMMARY_ITEM_LABELS: Partial<Record<PayrollPaidItemCode, string>> = { contract: 'Зарплата' };
const ITEM_LABEL = new Map<PayrollPaidItemCode, string>(
  PAYROLL_PAID_GROUPS.flatMap(group => group.items.map(item => [item.code, SUMMARY_ITEM_LABELS[item.code] ?? item.label] as const)),
);
const ITEM_ORDER: PayrollPaidItemCode[] = PAYROLL_PAID_GROUPS.flatMap(group => group.items.map(item => item.code));

/** «175000.50» → 17500050; мусор — null. */
const toCents = (amount: string | undefined): number | null => {
  if (amount === undefined) return null;
  const value = Number(amount);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
};

/** Суммы строки в копейках: статья → копейки (статьи без сумм нет). */
export type SummaryCents = Partial<Record<PayrollPaidItemCode, number>>;

const addCents = (target: SummaryCents, source: SummaryCents): void => {
  for (const [item, cents] of Object.entries(source) as Array<[PayrollPaidItemCode, number]>) {
    target[item] = (target[item] ?? 0) + cents;
  }
};

const rowCents = (row: IPayrollSummaryRow): SummaryCents => {
  const cents: SummaryCents = {};
  for (const [item, amount] of Object.entries(row.amounts) as Array<[PayrollPaidItemCode, string]>) {
    const value = toCents(amount);
    if (value !== null) cents[item] = value;
  }
  return cents;
};

/** Итог раздела «Начислено» или «Удержано»; null — в разделе нет ни одной суммы. */
const kindTotal = (cents: SummaryCents, kind: PayrollPaidTotalKind): number | null => {
  let total: number | null = null;
  for (const [item, value] of Object.entries(cents) as Array<[PayrollPaidItemCode, number]>) {
    if (ITEM_KIND.get(item) === kind) total = (total ?? 0) + value;
  }
  return total;
};

/** «К выплате» — «Всего начислено» минус «Всего удержано»; null — сумм нет ни в одном разделе. */
const payoutTotal = (cents: SummaryCents): number | null => {
  const accrued = kindTotal(cents, 'accrued');
  const deducted = kindTotal(cents, 'deducted');
  return accrued === null && deducted === null ? null : (accrued ?? 0) - (deducted ?? 0);
};

/** Строка таблицы сотрудников объекта. */
export interface ISummaryEmployeeRow {
  key: string;
  employee_id: number;
  full_name: string;
  department: string | null;
  position: string | null;
  category: StaffCategory;
  cents: SummaryCents;
}

/** Строка таблицы объектов. */
export interface ISummaryObjectRow {
  object_key: string;
  object_name: string;
  /** Уникальные сотрудники объекта (после фильтра категории). */
  employee_ids: number[];
  cents: SummaryCents;
}

export const filterSummaryByCategory = (
  rows: ReadonlyArray<IPayrollSummaryRow>,
  category: SummaryCategory,
): IPayrollSummaryRow[] => (category === 'all' ? [...rows] : rows.filter(row => row.category === category));

export const toSummaryEmployeeRows = (rows: ReadonlyArray<IPayrollSummaryRow>): ISummaryEmployeeRow[] => rows.map(row => ({
  key: `${row.employee_id}|${row.category}|${row.object_key}`,
  employee_id: row.employee_id,
  full_name: row.full_name,
  department: row.department,
  position: row.position,
  category: row.category,
  cents: rowCents(row),
}));

/** Объекты: суммы сотрудников сложены, «Чел.» — уникальные сотрудники. */
export const groupSummaryByObject = (rows: ReadonlyArray<IPayrollSummaryRow>): ISummaryObjectRow[] => {
  const byObject = new Map<string, ISummaryObjectRow & { ids: Set<number> }>();
  for (const row of rows) {
    let target = byObject.get(row.object_key);
    if (!target) {
      target = { object_key: row.object_key, object_name: row.object_name, employee_ids: [], cents: {}, ids: new Set() };
      byObject.set(row.object_key, target);
    }
    target.ids.add(row.employee_id);
    addCents(target.cents, rowCents(row));
  }
  return [...byObject.values()].map(({ ids, ...row }) => ({ ...row, employee_ids: [...ids] }));
};

/** Статьи-столбцы: есть хоть одна ненулевая сумма в строках категории (на поиск не реагируют). */
export const summaryItems = (rows: ReadonlyArray<IPayrollSummaryRow>): PayrollPaidItemCode[] => {
  const present = new Set<PayrollPaidItemCode>();
  for (const row of rows) {
    for (const [item, amount] of Object.entries(row.amounts) as Array<[PayrollPaidItemCode, string]>) {
      const cents = toCents(amount);
      if (cents !== null && cents !== 0) present.add(item);
    }
  }
  return ITEM_ORDER.filter(item => present.has(item));
};

/** Сумма в ячейке: «175 000,00», «−2 500,25»; нет суммы — «—». */
const money = (cents: number | null | undefined): string => (cents == null ? '—' : formatPaidAmount(cents / 100));
const moneyExport = (cents: number | null | undefined): number | null => (cents == null ? null : cents / 100);

const MONEY_WIDTH = 132;
/**
 * Подпись заголовка: ПРОПИСНЫЕ 12px, 600, letter-spacing 0.04em — до ~9,8px на букву («ПРЕДЫДУЩИЙ»
 * 97,8px в Inter); к ней стрелка, воронка и паддинги (REGISTRY_HEADER_EXTRA) — на телефоне воронка
 * шире на 12px (тап-цель 28px, TableSortHeader.module.css).
 */
const HEADER_CHAR_WIDTH = 10;
const HEADER_TOUCH_FILTER_EXTRA = 12;

/**
 * Ширина столбца, при которой самое длинное слово подписи не налезает на стрелку и воронку: подпись
 * переносится только по словам («ПЕРЕРАСЧЁТ ЗА ПРЕДЫДУЩИЙ ПЕРИОД»), а «БЕЗОПАСНОСТИ» должно влезть целиком.
 */
const headerWidth = (label: string, min: number): number => {
  const longestWord = Math.max(...label.split(/\s+/).map(word => word.length));
  return Math.max(min, Math.ceil(longestWord * HEADER_CHAR_WIDTH) + REGISTRY_HEADER_EXTRA + HEADER_TOUCH_FILTER_EXTRA);
};

const moneyColumn = <Row extends { cents: SummaryCents },>(
  key: string,
  label: string,
  value: (row: Row) => number | null | undefined,
): IRegistryColumn<Row> => ({
  key,
  label,
  type: 'money',
  width: headerWidth(label, MONEY_WIDTH),
  nowrap: true,
  numeric: true,
  text: row => money(value(row)),
  sortValue: row => value(row) ?? null,
  exportValue: row => moneyExport(value(row)),
});

const amountColumns = <Row extends { cents: SummaryCents },>(items: ReadonlyArray<PayrollPaidItemCode>): Array<IRegistryColumn<Row>> => [
  moneyColumn<Row>('payout', 'К выплате', row => payoutTotal(row.cents)),
  moneyColumn<Row>('accrued', 'Всего начислено', row => kindTotal(row.cents, 'accrued')),
  moneyColumn<Row>('deducted', 'Всего удержано', row => kindTotal(row.cents, 'deducted')),
  ...items.map(item => moneyColumn<Row>(item, ITEM_LABEL.get(item) ?? item, row => row.cents[item])),
];

export const summaryObjectColumns = (items: ReadonlyArray<PayrollPaidItemCode>): Array<IRegistryColumn<ISummaryObjectRow>> => [
  {
    key: 'object_name', label: 'Объект', type: 'text',
    text: row => row.object_name, sortValue: row => row.object_name,
  },
  {
    key: 'employees', label: 'Чел.', type: 'int', width: headerWidth('Чел.', 84), nowrap: true, numeric: true,
    text: row => String(row.employee_ids.length), sortValue: row => row.employee_ids.length,
    exportValue: row => row.employee_ids.length,
  },
  ...amountColumns<ISummaryObjectRow>(items),
];

const orDash = (value: string | null): string => value || '—';

export const summaryEmployeeColumns = (
  items: ReadonlyArray<PayrollPaidItemCode>,
  withCategory: boolean,
): Array<IRegistryColumn<ISummaryEmployeeRow>> => [
  { key: 'full_name', label: 'ФИО', type: 'text', text: row => row.full_name, sortValue: row => row.full_name },
  {
    key: 'department', label: 'Отдел', type: 'text', width: 140,
    text: row => orDash(row.department), sortValue: row => row.department,
  },
  {
    key: 'position', label: 'Должность', type: 'text', width: headerWidth('Должность', 140),
    text: row => orDash(row.position), sortValue: row => row.position,
  },
  ...(withCategory ? [{
    key: 'category', label: 'Категория', type: 'text' as const, width: 120, nowrap: true,
    text: (row: ISummaryEmployeeRow) => SUMMARY_CATEGORY_LABELS[row.category],
    sortValue: (row: ISummaryEmployeeRow) => SUMMARY_CATEGORY_LABELS[row.category],
  }] : []),
  ...amountColumns<ISummaryEmployeeRow>(items),
];

/** Итог по столбцам сумм видимых строк: экран — текст, xlsx — рубли числом. */
const amountTotals = <Row extends { cents: SummaryCents },>(
  rows: ReadonlyArray<Row>,
  items: ReadonlyArray<PayrollPaidItemCode>,
): { display: Record<string, string>; export: Record<string, number | null> } => {
  const sum: SummaryCents = {};
  for (const row of rows) addCents(sum, row.cents);
  const display: Record<string, string> = {};
  const exported: Record<string, number | null> = {};
  for (const item of items) {
    display[item] = money(sum[item]);
    exported[item] = moneyExport(sum[item]);
  }
  for (const kind of ['accrued', 'deducted'] as const) {
    const total = kindTotal(sum, kind);
    display[kind] = money(total);
    exported[kind] = moneyExport(total);
  }
  const payout = payoutTotal(sum);
  display.payout = money(payout);
  exported.payout = moneyExport(payout);
  return { display, export: exported };
};

export const TOTAL_LABEL = 'Итого';

/** Строка «Итого»: текст на экране и значения xlsx по ключу столбца. */
export interface ISummaryTotals {
  display: Record<string, string>;
  export: Record<string, string | number | null>;
}

export const summaryObjectTotals = (items: ReadonlyArray<PayrollPaidItemCode>) => (
  rows: ReadonlyArray<ISummaryObjectRow>,
): ISummaryTotals | null => {
  if (rows.length === 0) return null;
  const amounts = amountTotals(rows, items);
  // Один сотрудник за несколько месяцев может быть на разных объектах — в итоге он один.
  const employees = new Set(rows.flatMap(row => row.employee_ids)).size;
  return {
    display: { ...amounts.display, object_name: TOTAL_LABEL, employees: String(employees) },
    export: { ...amounts.export, object_name: TOTAL_LABEL, employees },
  };
};

/** Таблица объектов вкладки — строки и столбцы, как в окне после её выбора (итоги всех вкладок над таблицей). */
export const summaryCategoryTable = (rows: ReadonlyArray<IPayrollSummaryRow>, category: SummaryCategory): {
  objects: ISummaryObjectRow[];
  columns: Array<IRegistryColumn<ISummaryObjectRow>>;
} => {
  const categoryRows = filterSummaryByCategory(rows, category);
  return { objects: groupSummaryByObject(categoryRows), columns: summaryObjectColumns(summaryItems(categoryRows)) };
};

/** «К выплате» строк — то же, что в строке «Итого»; строк нет — «—». */
export const summaryPayoutText = (rows: ReadonlyArray<{ cents: SummaryCents }>): string => {
  const sum: SummaryCents = {};
  for (const row of rows) addCents(sum, row.cents);
  return money(payoutTotal(sum));
};

export const summaryEmployeeTotals = (items: ReadonlyArray<PayrollPaidItemCode>) => (
  rows: ReadonlyArray<ISummaryEmployeeRow>,
): ISummaryTotals | null => {
  if (rows.length === 0) return null;
  const amounts = amountTotals(rows, items);
  return {
    display: { ...amounts.display, full_name: TOTAL_LABEL },
    export: { ...amounts.export, full_name: TOTAL_LABEL },
  };
};

/** Подпись периода: «июль 2026», пусто — «весь период». */
export const summaryPeriodLabel = (months: ReadonlyArray<string>): string => (
  months.length === 0 ? 'весь период' : formatMonthsLabel(months)
);

/** Снимок xlsx таблицы «Свода»: «Свод_Офис_2026-10-19.xlsx», подзаголовок — период, категория и дата. */
export const buildSummarySnapshot = <Row,>(params: {
  title: string;
  subject: string;
  periodLabel: string;
  categoryLabel: string;
  columns: ReadonlyArray<IRegistryColumn<Row>>;
}) => (rows: ReadonlyArray<Row>, totals?: Readonly<Record<string, string | number | null>>): ITableExportSnapshot => {
  const isoDate = moscowTodayIso();
  return buildExportTable({
    title: `${params.title}: ${params.subject}`,
    subtitle: `Период: ${params.periodLabel}. Категория: ${params.categoryLabel}. Дата выгрузки: ${isoDate.split('-').reverse().join('.')}`,
    fileName: `${params.title}_${params.subject}_${isoDate}.xlsx`.replace(/[\s/\\:*?"<>|]+/g, '_'),
    columns: params.columns,
    rows,
    totals,
  });
};
