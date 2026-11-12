import { useCallback, useMemo, useState } from 'react';

import type { IPayrollTermsRow } from '../services/payrollService';
import {
  applyPayrollAmountView,
  countPayrollAmountFilters,
  EMPTY_PAYROLL_AMOUNT_VIEW,
  payrollAmountFilterOptions,
  PAYROLL_AMOUNT_VIEW_COLUMNS,
  visiblePayrollAmountView,
} from '../utils/payrollCalcView';
import type { PayrollTableColumn } from '../utils/payrollColumns';
import { setColumnFilter, toggleSort, type ITableView } from '../utils/tableView';

interface IOpenAmountFilter {
  column: PayrollTableColumn;
  anchor: HTMLElement;
}

/**
 * «Расчёты»: выбор сортировки и фильтров столбцов сумм (payrollCalcView.ts) и открытое окно фильтра. Отдельно от строк
 * (usePayrollAmountViewRows): снимать условия скрытого столбца нужно раньше, чем известны скрытые столбцы.
 */
export const usePayrollAmountView = () => {
  const [view, setView] = useState<ITableView>(EMPTY_PAYROLL_AMOUNT_VIEW);
  const [openFilter, setOpenFilter] = useState<IOpenAmountFilter | null>(null);

  const sortBy = useCallback((column: PayrollTableColumn) => setView(prev => toggleSort(prev, column)), []);
  const openFilterFor = useCallback((column: PayrollTableColumn, anchor: HTMLElement) => setOpenFilter({ column, anchor }), []);
  const closeFilter = useCallback(() => setOpenFilter(null), []);
  const applyFilter = useCallback((values: string[] | null) => {
    if (openFilter) setView(prev => setColumnFilter(prev, openFilter.column, values));
  }, [openFilter]);
  /** Столбец скрыт шестерёнкой: его фильтр и сортировка снимаются, а не ждут его возвращения. */
  const clearColumn = useCallback((column: PayrollTableColumn) => {
    setView(prev => (prev.sort !== column && !prev.filters[column]
      ? prev
      : { ...setColumnFilter(prev, column, null), sort: prev.sort === column ? '' : prev.sort }));
  }, []);
  /** Сортировка по серверному столбцу заменяет сортировку сумм. */
  const clearSort = useCallback(() => setView(prev => (prev.sort === '' ? prev : { ...prev, sort: '' })), []);
  const resetFilters = useCallback(() => setView(prev => ({ ...prev, filters: {} })), []);

  return { view, openFilter, sortBy, openFilterFor, closeFilter, applyFilter, clearColumn, clearSort, resetFilters };
};

/**
 * Вид на экране: rows — все строки экрана, hidden — скрытые шестерёнкой и пустые столбцы (их фильтр и сортировка не
 * действуют). Без сортировки и фильтров строки те же (тот же массив) — таблица не перерисовывается зря.
 */
export const usePayrollAmountViewRows = (
  state: Pick<ReturnType<typeof usePayrollAmountView>, 'view' | 'openFilter'>,
  rows: IPayrollTermsRow[],
  hidden: ReadonlySet<PayrollTableColumn>,
) => {
  const { view: chosen, openFilter } = state;
  const view = useMemo(() => visiblePayrollAmountView(chosen, hidden), [chosen, hidden]);
  const filterCount = countPayrollAmountFilters(view);
  const viewRows = useMemo(
    () => (view.sort === '' && filterCount === 0 ? rows : applyPayrollAmountView(rows, view)),
    [rows, view, filterCount],
  );
  /** Варианты открытого фильтра — по всем строкам экрана, без фильтра самого столбца. */
  const filterOptions = useMemo(
    () => (openFilter ? payrollAmountFilterOptions(rows, view, openFilter.column) : []),
    [openFilter, rows, view],
  );
  const filterLabel = openFilter
    ? PAYROLL_AMOUNT_VIEW_COLUMNS.find(column => column.key === openFilter.column)?.label ?? ''
    : '';

  return {
    view,
    /** Сортировка сумм выбрана (видимым столбцом): серверная не подсвечивается. */
    sortActive: view.sort !== '',
    viewRows,
    filterCount,
    filterOptions,
    filterLabel,
    /** Ключ для возврата прокрутки наверх. */
    viewKey: JSON.stringify(view),
  };
};
