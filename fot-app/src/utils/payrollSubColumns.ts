/**
 * Раскрытие столбцов «Расчётов» по «+» (решение пользователя 30.10.2026). «Доплаты» — переработка, проезд, проживание,
 * плановая и разовая (свёрнутые «Доплаты» — их сумма, calcSumAmount); «Удержания» (1С) — статьи «Оплачено» группы
 * «Удержано»; «Удержания (ФОТ)» — виды «Справочника». Сумма подстолбцов строки равна её итогу.
 *
 * Подстолбец — только с суммой хоть в одной загруженной строке («0.00» и минус — тоже сумма): отдел приходит целиком,
 * в «Все отделы» вид может добавиться при догрузке (как пустые столбцы, emptyPayrollColumns). Разбивку ФОТ присылает
 * только новый бэкенд: без неё «+» нет, иначе раскрытые «Доплаты» не сошлись бы с итогом. Раскрытие помнит браузер.
 */
import type { IPayrollCalcColumns, IPayrollTermsRow, PayrollPaidItemCode } from '../services/payrollService';
import { calcSumAmount, sumAmounts } from './payrollCalcColumns';
import type { PayrollTableColumn, PayrollTableColumns } from './payrollColumns';
import { PAYROLL_PAID_GROUPS } from './payrollPaid';

export type PayrollExpandableColumn = 'calc_supplements' | 'deductions' | 'calc_deductions';

/** Порядок — для хранилища. */
const EXPANDABLE_COLUMNS: readonly PayrollExpandableColumn[] = ['deductions', 'calc_supplements', 'calc_deductions'];

export const isExpandablePayrollColumn = (column: string): column is PayrollExpandableColumn => (
  (EXPANDABLE_COLUMNS as readonly string[]).includes(column)
);

/** Столбцы ФОТ под «+» у «Доплат»: ячейка — прежняя PayrollCalcCell (с подписью и ⚠). */
export type PayrollSupplementsColumn = 'calc_overtime' | 'calc_travel' | 'calc_housing';

/** key — составной («родитель:код»), стабильный между порциями. */
export type PayrollSubColumn =
  | { type: 'column'; key: string; label: string; column: PayrollSupplementsColumn }
  | { type: 'supplement'; key: string; label: string; part: 'planned' | 'one_time' }
  | { type: 'paid'; key: string; label: string; item: PayrollPaidItemCode }
  | { type: 'kind'; key: string; label: string; kindId: number };

/** Подстолбцы со своей ячейкой (PayrollSubColumnCell); ФОТ — все, кроме статей 1С. */
export type PayrollAmountSubColumn = Exclude<PayrollSubColumn, { type: 'column' }>;

const SUPPLEMENTS_SUB_COLUMNS: readonly PayrollSubColumn[] = [
  { type: 'column', key: 'calc_supplements:calc_overtime', label: 'Переработка', column: 'calc_overtime' },
  { type: 'column', key: 'calc_supplements:calc_travel', label: 'Компенсация проезда', column: 'calc_travel' },
  { type: 'column', key: 'calc_supplements:calc_housing', label: 'Проживание', column: 'calc_housing' },
  { type: 'supplement', key: 'calc_supplements:planned', label: 'Плановая', part: 'planned' },
  { type: 'supplement', key: 'calc_supplements:one_time', label: 'Разовая', part: 'one_time' },
];

const DEDUCTED_ITEMS = PAYROLL_PAID_GROUPS.filter(group => group.kind === 'deducted').flatMap(group => group.items);
const DEDUCTED_CODES = new Set<string>(DEDUCTED_ITEMS.map(item => item.code));

/**
 * Разбивка ФОТ пришла: у каждой строки с посчитанным ФОТ есть поля (по наличию, null — разбивка без суммы) и такая
 * строка хоть одна. Без calc, с calc: null, пока считается или с ошибкой — не в счёт.
 */
const hasCalcBreakdown = (rows: readonly IPayrollTermsRow[], fields: ReadonlyArray<keyof IPayrollCalcColumns>): boolean => {
  const calcs = rows.flatMap(row => (row.calc_status || !row.calc ? [] : [row.calc]));
  return calcs.length > 0 && calcs.every(calc => fields.every(field => field in calc));
};

/** Сумма подстолбца в строке, NUMERIC строкой; нет — null. */
export const subColumnAmount = (row: IPayrollTermsRow, sub: PayrollSubColumn): string | null => {
  switch (sub.type) {
    case 'column': return calcSumAmount(row, sub.column);
    case 'supplement':
      return (sub.part === 'planned' ? row.calc?.supplements_planned : row.calc?.supplements_one_time) ?? null;
    case 'paid':
      return sumAmounts((row.paid_deductions ?? []).filter(paid => paid.item === sub.item).map(paid => paid.amount));
    case 'kind': return row.calc?.deductions_by_kind?.find(kind => kind.kind_id === sub.kindId)?.amount ?? null;
  }
};

/**
 * Подстолбцы родителя с суммой хоть в одной строке: «Доплаты» — по порядку SUPPLEMENTS_SUB_COLUMNS; статьи 1С — порядок
 * и подписи PAYROLL_PAID_GROUPS, незнакомый код (CHECK не пустит) — следом, подписью-кодом, чтобы сумма не терялась;
 * виды ФОТ — по названию.
 */
export const payrollSubColumns = (rows: readonly IPayrollTermsRow[], parent: PayrollExpandableColumn): PayrollSubColumn[] => {
  switch (parent) {
    case 'calc_supplements':
      if (!hasCalcBreakdown(rows, ['supplements_planned', 'supplements_one_time'])) return [];
      return SUPPLEMENTS_SUB_COLUMNS.filter(sub => rows.some(row => subColumnAmount(row, sub) !== null));
    case 'deductions': {
      const items = new Set<string>(rows.flatMap(row => (row.paid_deductions ?? []).map(paid => paid.item)));
      const unknown = [...items].filter(code => !DEDUCTED_CODES.has(code)).sort();
      return [
        ...DEDUCTED_ITEMS.filter(item => items.has(item.code)).map(item => ({ code: item.code, label: item.label })),
        ...unknown.map(code => ({ code: code as PayrollPaidItemCode, label: code })),
      ].map(({ code, label }) => ({ type: 'paid', key: `deductions:${code}`, label, item: code }));
    }
    case 'calc_deductions': {
      if (!hasCalcBreakdown(rows, ['deductions_by_kind'])) return [];
      const kinds = new Map<number, string>();
      for (const row of rows) {
        for (const kind of row.calc?.deductions_by_kind ?? []) {
          if (!kinds.has(kind.kind_id)) kinds.set(kind.kind_id, kind.kind);
        }
      }
      return [...kinds]
        .sort(([idA, nameA], [idB, nameB]) => nameA.localeCompare(nameB, 'ru') || idA - idB)
        .map(([kindId, name]) => ({ type: 'kind', key: `calc_deductions:${kindId}`, label: name, kindId }));
    }
  }
};

/** Столбец таблицы: обычный или подстолбец раскрытого; key — для React. */
export type PayrollTableColumnEntry =
  | { kind: 'column'; key: PayrollTableColumn; column: PayrollTableColumns[number] }
  | { kind: 'sub'; key: string; parent: PayrollExpandableColumn; sub: PayrollSubColumn };

/**
 * Один список для colgroup, шапки, ячеек и colSpan: видимые столбцы (скрытые уже отфильтрованы — у скрытого итога нет
 * и подстолбцов), за раскрытым — его подстолбцы.
 */
export const payrollTableColumnList = (
  visibleColumns: PayrollTableColumns,
  expanded: ReadonlySet<PayrollExpandableColumn>,
  subColumns: ReadonlyMap<PayrollExpandableColumn, readonly PayrollSubColumn[]>,
): PayrollTableColumnEntry[] => visibleColumns.flatMap((column): PayrollTableColumnEntry[] => {
  const entry: PayrollTableColumnEntry = { kind: 'column', key: column.key, column };
  if (!isExpandablePayrollColumn(column.key) || !expanded.has(column.key)) return [entry];
  const parent = column.key;
  return [entry, ...(subColumns.get(parent) ?? []).map(sub => ({ kind: 'sub' as const, key: sub.key, parent, sub }))];
});

export const toggleExpandedColumn = (
  expanded: ReadonlySet<PayrollExpandableColumn>,
  column: PayrollExpandableColumn,
): Set<PayrollExpandableColumn> => {
  const next = new Set(expanded);
  if (next.has(column)) next.delete(column);
  else next.add(column);
  return next;
};

/** Раскрытые столбцы «Расчётов» — удобство браузера, как скрытые столбцы. */
export const PAYROLL_CALC_EXPANDED_KEY = 'fot:payroll-calc:expanded-columns';

/** Разбор сохранённого значения: неизвестные ключи и мусор отбрасываются. */
export const parseExpandedPayrollColumns = (raw: string | null): Set<PayrollExpandableColumn> => {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((value): value is PayrollExpandableColumn => typeof value === 'string' && isExpandablePayrollColumn(value)))
      : new Set();
  } catch {
    return new Set();
  }
};

export const loadExpandedPayrollColumns = (): Set<PayrollExpandableColumn> => {
  try {
    return parseExpandedPayrollColumns(window.localStorage.getItem(PAYROLL_CALC_EXPANDED_KEY));
  } catch {
    return new Set();
  }
};

export const saveExpandedPayrollColumns = (expanded: ReadonlySet<PayrollExpandableColumn>): void => {
  try {
    const ordered = EXPANDABLE_COLUMNS.filter(column => expanded.has(column));
    if (ordered.length === 0) window.localStorage.removeItem(PAYROLL_CALC_EXPANDED_KEY);
    else window.localStorage.setItem(PAYROLL_CALC_EXPANDED_KEY, JSON.stringify(ordered));
  } catch {
    // Хранилище недоступно (приватный режим, запрет) — раскрытие живёт до перезагрузки страницы.
  }
};
