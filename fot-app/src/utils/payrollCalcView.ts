/**
 * Сортировка и фильтр столбцов сумм «Расчётов» (решение пользователя 12.11.2026: «выбрать в столбце значение 0»).
 * Суммы ФОТ считаются на экране отдельными запросами по порциям, сервер по ним не сортирует. Поэтому вид строится на
 * клиенте по всем строкам выборки: ради «Итого» порции грузятся все. Фильтр отбирает по тексту ячейки («0,00», «—» —
 * не посчитано), сортировка идёт по числу, пустые уходят в конец. Подстолбцы «+» сюда не входят.
 */
import type { IPayrollTermsRow } from '../services/payrollService';
import { formatCalcRate, isCalcColumn } from './payrollCalcColumns';
import { payrollColumnAmount } from './payrollCalcTotals';
import { PAYROLL_CALC_TABLE_COLUMNS, type PayrollTableColumn } from './payrollColumns';
import { formatPaidAmount } from './payrollPaid';
import {
  applyTableView,
  columnFilterOptions,
  type IFilterOption,
  type ITableColumn,
  type ITableView,
} from './tableView';

/** Столбцы сумм «Расчётов» с сортировкой и фильтром на клиенте. */
const AMOUNT_VIEW_KEYS: ReadonlySet<PayrollTableColumn> = new Set<PayrollTableColumn>([
  'calc_net', 'calc_remainder', 'card_payouts', 'deductions', 'calc_rate', 'calc_timesheet', 'calc_vacation',
  'calc_sick', 'fss_payments', 'paid_recalc', 'calc_supplements', 'calc_deductions',
]);

export const isPayrollAmountViewColumn = (key: string): key is PayrollTableColumn => (
  AMOUNT_VIEW_KEYS.has(key as PayrollTableColumn)
);

/** Текст «пока считается» — как в ячейке; в фильтре такого значения нет. */
const PENDING_TEXT = '…';

/** Расчёт ФОТ строки ещё идёт или не удался: суммы столбца ФОТ неизвестны. */
const calcUnknown = (row: IPayrollTermsRow, column: PayrollTableColumn): boolean => (
  Boolean(row.calc_status) && isCalcColumn(column)
);

/** Текст ячейки, как в PayrollCalcCell: сумма с копейками, у «Оклада» — ставка, нет — «—». */
const cellText = (row: IPayrollTermsRow, column: PayrollTableColumn): string => {
  if (calcUnknown(row, column)) return row.calc_status === 'pending' ? PENDING_TEXT : '—';
  if (column === 'calc_rate') return formatCalcRate(row.calc?.rate ?? null);
  const amount = payrollColumnAmount(row, column);
  return amount === null ? '—' : formatPaidAmount(Number(amount));
};

const sortValue = (row: IPayrollTermsRow, column: PayrollTableColumn): number | null => {
  if (calcUnknown(row, column)) return null;
  const amount = column === 'calc_rate' ? row.calc?.rate?.amount ?? null : payrollColumnAmount(row, column);
  if (amount === null) return null;
  const value = Number(amount);
  return Number.isFinite(value) ? value : null;
};

/** Столбцы вида в порядке таблицы, с подписями шапки. */
export const PAYROLL_AMOUNT_VIEW_COLUMNS: ReadonlyArray<ITableColumn<IPayrollTermsRow>> = PAYROLL_CALC_TABLE_COLUMNS
  .filter(column => AMOUNT_VIEW_KEYS.has(column.key))
  .map(column => ({
    key: column.key,
    label: column.label,
    type: 'money' as const,
    text: row => cellText(row, column.key),
    sortValue: row => sortValue(row, column.key),
  }));

export const EMPTY_PAYROLL_AMOUNT_VIEW: ITableView = { sort: '', dir: 'asc', filters: {} };

/** Вид без скрытых столбцов (шестерёнкой или пустых): невидимый столбец не отбирает и не сортирует. */
export const visiblePayrollAmountView = (view: ITableView, hidden: ReadonlySet<PayrollTableColumn>): ITableView => {
  const isHidden = (key: string): boolean => hidden.has(key as PayrollTableColumn);
  const hiddenFilters = Object.keys(view.filters).filter(isHidden);
  const hiddenSort = view.sort !== '' && isHidden(view.sort);
  if (hiddenFilters.length === 0 && !hiddenSort) return view;
  const filters = Object.fromEntries(Object.entries(view.filters).filter(([key]) => !isHidden(key)));
  return { ...view, sort: hiddenSort ? '' : view.sort, filters };
};

/** Строки экрана: фильтры столбцов сумм, затем сортировка; без сортировки — порядок сервера. */
export const applyPayrollAmountView = (rows: ReadonlyArray<IPayrollTermsRow>, view: ITableView): IPayrollTermsRow[] => (
  applyTableView(rows, PAYROLL_AMOUNT_VIEW_COLUMNS, view)
);

/** Варианты фильтра столбца по возрастанию суммы, «—» в конце; «…» (ещё считается) не предлагается. */
export const payrollAmountFilterOptions = (
  rows: ReadonlyArray<IPayrollTermsRow>,
  view: ITableView,
  key: string,
): IFilterOption[] => (
  columnFilterOptions(rows, PAYROLL_AMOUNT_VIEW_COLUMNS, view.filters, key).filter(option => option.value !== PENDING_TEXT)
);

export const countPayrollAmountFilters = (view: ITableView): number => (
  Object.values(view.filters).filter(values => values.length > 0).length
);

/** Фильтры текстом для шапки выгрузки: «Сумма: 0,00; Остаток к выплате: —»; нет — ''. */
export const describePayrollAmountFilters = (view: ITableView): string => PAYROLL_AMOUNT_VIEW_COLUMNS
  .filter(column => (view.filters[column.key]?.length ?? 0) > 0)
  .map(column => `${column.label}: ${view.filters[column.key].join(', ')}`)
  .join('; ');
