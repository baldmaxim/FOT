import { useCallback, useMemo, useState, type FC, type ReactNode } from 'react';
import { Download, Settings } from 'lucide-react';

import {
  type IPayrollColumnFilters,
  type IPayrollColumnValuesParams,
  type IPayrollTermsRow,
  type IPayrollTermsViewParams,
  type PayrollPaidMonths,
  type PayrollSortDir,
  type PayrollSortKey,
} from '../../services/payrollService';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { usePayrollCalcExport } from '../../hooks/usePayrollCalcExport';
import { usePayrollAmountView, usePayrollAmountViewRows } from '../../hooks/usePayrollAmountView';
import { usePayrollCalcPageColumns } from '../../hooks/usePayrollCalcPageColumns';
import { usePayrollTermsInfiniteList } from '../../hooks/usePayrollTermsInfiniteList';
import { usePayrollTermsPayouts } from '../../hooks/usePayrollTermsPayouts';
import { usePayrollExpandedColumns } from '../../hooks/usePayrollExpandedColumns';
import { usePayrollHiddenColumns } from '../../hooks/usePayrollHiddenColumns';
import { usePayrollStructureTree } from '../../hooks/useStructure';
import { useStaffSectionDepartments } from '../../hooks/useStaffSectionDepartments';
import { filterDepartmentTreeByIds, findDepartmentName } from '../../utils/departmentUtils';
import { payrollAccrualMonths } from '../../utils/payrollAccruals';
import {
  countActivePayrollColumnFilters,
  isPayrollColumnFilterActive,
  PAYROLL_FILTER_COLUMN_LABELS,
  serializePayrollColumnFilters,
  setPayrollColumnFilter,
  type PayrollColumnFilterValue,
} from '../../utils/payrollColumnFilters';
import {
  isSortablePayrollColumn,
  PAYROLL_TERMS_COLUMNS_KEY,
  PAYROLL_TERMS_TABLE_COLUMNS,
  type PayrollTableColumn,
  type PayrollTableColumns,
} from '../../utils/payrollColumns';
import { emptyPayrollColumns } from '../../utils/payrollCalcColumns';
import { isPayrollAmountViewColumn, PAYROLL_AMOUNT_EMPTY_TEXT } from '../../utils/payrollCalcView';
import type { IPayrollTotalsStatus } from '../../utils/payrollCalcTotals';
import { formatPaidPeriod, type PayrollPaidTotalKind } from '../../utils/payrollPaid';
import type { ICalcMonthFilter } from '../../utils/payrollViews';
import { PAYROLL_GROUP_LABELS, PAYROLL_GROUP_OPTIONS, payrollGroupValue, pickDepartmentOrGroup } from '../../utils/payrollDepartmentGroups';
import { ColumnValuesFilterPopover } from '../../components/ui/ColumnValuesFilterPopover';
import { SearchInput } from '../../components/ui/SearchInput';
import { PayrollColumnFilterPopover } from '../../components/salary/PayrollColumnFilterPopover';
import { PayrollColumnsMenu } from '../../components/salary/PayrollColumnsMenu';
import { PayrollObjectFilterField } from '../../components/salary/PayrollObjectFilterField';
import { PayrollTermsTable } from '../../components/salary/PayrollTermsTable';
import { DepartmentTreeSelect } from '../../components/staff/DepartmentTreeSelect';
import styles from './CompensationTermsPage.module.css';

interface ICompensationTermsPageProps {
  /** Дата выборки — одна на список и карточку «Подробно» (см. PaymentsTab). */
  date: string;
  /** Список на экране. Скрытый список не размонтируется: фильтры, выделение и прокрутка сохраняются. */
  active: boolean;
  /** «Расчёты»: только этот сотрудник (по id) — его карточка открыта в «Подробно». */
  employeeId?: number;
  /** Поиск по ФИО — общий у «Условий оплаты» и «Расчётов»: крестик на одном экране чистит оба. */
  search: string;
  onSearchChange: (value: string) => void;
  /** Отдел или бригада — общие у «Условий оплаты» и «Расчётов»: выбор и крестик на одном экране — на обоих. */
  departmentId: string;
  onDepartmentChange: (id: string) => void;
  /** Клик по строке — карточка этого сотрудника. */
  onOpenEmployee: (row: IPayrollTermsRow) => void;
  /** Кнопки панели перед шестерёнкой («Справочник» на «Расчётах»). */
  actionsExtra?: ReactNode;
  /** Ключ хранилища скрытых столбцов (шестерёнка). */
  hiddenColumnsKey?: string;
  /** Столбцы таблицы; по умолчанию — «Условия оплаты». */
  columns?: PayrollTableColumns;
  /**
   * «Расчёты»: месяцы сумм таблицы; null — месяцы ещё грузятся, список ждёт.
   * Не передан — «Условия оплаты», сумм нет.
   */
  paidMonths?: PayrollPaidMonths | null;
  /** Клик по сумме «Удержания (1С)»: строка, раздел, кнопка (вернуть фокус) и месяцы сумм строки. */
  onOpenPaidItems?: (row: IPayrollTermsRow, kind: PayrollPaidTotalKind, trigger: HTMLButtonElement, months: PayrollPaidMonths) => void;
  /**
   * «Расчёты»: группа отделов (ИТР / Офис / Рабочие в списке «Все отделы») и объект месяца, как в «Своде».
   * Не передан — ни групп, ни поля объекта («Условия оплаты»).
   */
  monthFilter?: ICalcMonthFilter;
  onMonthFilterChange?: (next: ICalcMonthFilter) => void;
}


export const CompensationTermsPage: FC<ICompensationTermsPageProps> = ({
  date,
  active,
  employeeId,
  search,
  onSearchChange,
  departmentId,
  onDepartmentChange,
  onOpenEmployee,
  actionsExtra,
  hiddenColumnsKey = PAYROLL_TERMS_COLUMNS_KEY,
  columns = PAYROLL_TERMS_TABLE_COLUMNS,
  paidMonths,
  onOpenPaidItems,
  monthFilter,
  onMonthFilterChange,
}) => {
  const [sort, setSort] = useState<PayrollSortKey>('name');
  const [dir, setDir] = useState<PayrollSortDir>('asc');
  const [columnFilters, setColumnFilters] = useState<IPayrollColumnFilters>({});
  const [openFilter, setOpenFilter] = useState<{ column: PayrollSortKey; anchor: HTMLElement } | null>(null);
  // «Расчёты»: сортировка и фильтры столбцов сумм — на клиенте (строки — usePayrollAmountViewRows ниже).
  const amountState = usePayrollAmountView();

  // Поиск идёт на сервере по всему штату, а не по загруженным порциям.
  const debouncedSearch = useDebouncedValue(search.trim(), 300);

  // Одинаковые фильтры дают одинаковую строку — один ключ кэша.
  const columnFiltersKey = serializePayrollColumnFilters(columnFilters);
  const activeFilterCount = countActivePayrollColumnFilters(columnFilters);

  // Группа и объект — не для одного сотрудника; объект — только за месяцы списком (сервер иначе отвечает 400).
  const monthsList = Array.isArray(paidMonths) && paidMonths.length > 0 ? paidMonths : null;
  const group = employeeId === undefined ? monthFilter?.group ?? undefined : undefined;
  const objectKey = monthsList && employeeId === undefined ? monthFilter?.object?.key : undefined;

  const viewParams = useMemo<IPayrollTermsViewParams>(() => ({
    date,
    departmentId: departmentId || undefined,
    q: debouncedSearch || undefined,
    cf: columnFiltersKey || undefined,
    employeeId,
    group,
    objectKey,
  }), [date, departmentId, debouncedSearch, columnFiltersKey, employeeId, group, objectKey]);

  // Список «Все отделы»: на «Расчётах» в нём и группы (payrollDepartmentGroups.ts).
  const handleDepartmentChange = (value: string) => {
    if (!monthFilter || !onMonthFilterChange) return onDepartmentChange(value);
    const next = pickDepartmentOrGroup(value);
    if (next.group !== monthFilter.group) onMonthFilterChange({ ...monthFilter, group: next.group });
    if (next.departmentId !== departmentId) onDepartmentChange(next.departmentId);
  };

  const { termsQuery, rows, loadMore, retryNextPage } = usePayrollTermsInfiniteList({
    viewParams, sort, dir, date, paidMonths, active,
  });
  const { data, hasNextPage, isFetchingNextPage, isFetchNextPageError, isPlaceholderData } = termsQuery;

  // «Расчёты»: столбцы ФОТ — по порциям, по одной (usePayrollCalcPageColumns).
  const isCalcScreen = paidMonths !== undefined;
  const { calcMerge, retryCalc } = usePayrollCalcPageColumns({ pages: data?.pages, rows, enabled: isCalcScreen, active });
  // «Выплачено» — за закрытые месяцы перед месяцем даты показанных строк.
  const shownDate = data?.pages[0]?.date ?? date;
  const accrualMonths = useMemo(() => payrollAccrualMonths(shownDate), [shownDate]);
  const meta = data?.pages[0]?.meta;
  const total = meta?.total ?? 0;
  // Период сумм «Расчётов» — тех строк, что на экране.
  const shownPaidMonths = data?.pages[0]?.paidMonths ?? null;
  const paidPeriod = shownPaidMonths === null ? undefined : formatPaidPeriod(shownPaidMonths);

  const handleOpenPaidItems = useCallback((row: IPayrollTermsRow, kind: PayrollPaidTotalKind, trigger: HTMLButtonElement) => {
    // Кнопки сумм есть только у строк с суммами — месяцы к этому времени известны.
    if (shownPaidMonths !== null) onOpenPaidItems?.(row, kind, trigger, shownPaidMonths);
  }, [onOpenPaidItems, shownPaidMonths]);

  const structureTree = usePayrollStructureTree();
  const sectionDepartments = useStaffSectionDepartments();
  // Только ветки компаний (СУ-10, СМ, Бригады), как «Все отделы» в «Управлении кадрами»:
  // «Уволенные», «test», «Допуск Везде» скрыты; подрядчики исключены из списка и так.
  // Пока id не загрузились или запрос упал — дерево без фильтра, а не пустой список.
  const departments = useMemo(() => {
    const tree = structureTree.data?.departments ?? [];
    const sections = sectionDepartments.data;
    if (!sections) return tree;
    return filterDepartmentTreeByIds(tree, new Set([...sections.su10, ...sections.sm, ...sections.brigades]));
  }, [structureTree.data, sectionDepartments.data]);

  const handleOpenFilter = useCallback((column: PayrollSortKey, anchor: HTMLElement) => {
    setOpenFilter({ column, anchor });
  }, []);

  const applyColumnFilter = useCallback((column: PayrollSortKey, value: PayrollColumnFilterValue) => {
    setColumnFilters(prev => setPayrollColumnFilter(prev, column, value));
  }, []);

  const closeFilter = useCallback(() => setOpenFilter(null), []);

  // Шестерёнка «Столбцы таблицы». Скрытый столбец не должен фильтровать и сортировать невидимо —
  // его фильтр и сортировка снимаются вместе со скрытием.
  const [columnsAnchor, setColumnsAnchor] = useState<HTMLElement | null>(null);
  const clearHiddenColumnConditions = (column: PayrollTableColumn) => {
    // Столбец суммы «Расчётов» — сортировка и фильтр на клиенте.
    if (isCalcScreen && isPayrollAmountViewColumn(column)) {
      amountState.clearColumn(column);
      return;
    }
    // Без сортировки и фильтра.
    if (!isSortablePayrollColumn(column)) return;
    if (isPayrollColumnFilterActive(columnFilters, column)) {
      setColumnFilters(prev => setPayrollColumnFilter(prev, column, null));
    }
    if (sort === column) {
      setSort('name');
      setDir('asc');
    }
  };
  const { hidden: hiddenColumns, setColumnVisible, showAll } = usePayrollHiddenColumns(
    hiddenColumnsKey,
    columns,
    clearHiddenColumnConditions,
  );
  // «Условия оплаты»: «Выплачено» — месяц из 1С, иначе расчёт ФОТ, по порциям (usePayrollTermsPayouts); столбец скрыт —
  // не считается.
  const { payoutsMerge } = usePayrollTermsPayouts({
    pages: data?.pages,
    rows,
    enabled: !isCalcScreen && !hiddenColumns.has('accruals'),
    active,
  });
  const tableRows = isCalcScreen ? calcMerge.rows : payoutsMerge.rows;
  // «Расчёты»: «+» у «Доплат» и «Удержаний» раскрывает столбцы по видам; что раскрыто — помнит браузер.
  const { expanded: expandedColumns, toggleExpanded } = usePayrollExpandedColumns();
  // «Расчёты»: столбцы сумм без данных скрываются сами, когда загружены все порции; выбор шестерёнки не меняется.
  const emptyColumns = useMemo(
    () => (paidMonths === undefined || hasNextPage
      ? new Set<PayrollTableColumn>()
      : emptyPayrollColumns(tableRows, columns, calcMerge.ready)),
    [paidMonths, hasNextPage, tableRows, columns, calcMerge.ready],
  );
  const tableHiddenColumns = useMemo(
    () => (emptyColumns.size === 0 ? hiddenColumns : new Set([...hiddenColumns, ...emptyColumns])),
    [hiddenColumns, emptyColumns],
  );
  // «Расчёты»: сортировка и фильтр столбцов сумм — на клиенте по всем строкам (все порции грузятся ради «Итого»).
  // Пустые столбцы считаются по всем строкам, а не по отобранным: фильтр «—» не должен скрыть свой же столбец.
  const amountView = usePayrollAmountViewRows(amountState, tableRows, tableHiddenColumns);
  const amountSortActive = amountView.sortActive;
  // В таблице только «не посчитанные» (клик по «Не посчитано» или «Сумма: —» в воронке): в «Итого» — «←» назад.
  const uncountedFilter = amountView.view.filters.calc_net;
  const uncountedShown = isCalcScreen && uncountedFilter?.length === 1 && uncountedFilter[0] === PAYROLL_AMOUNT_EMPTY_TEXT;
  const clearAmountSort = amountState.clearSort;

  /**
   * Тот же столбец — смена направления, другой — по возрастанию. При сортировке по сумме серверный столбец не подсвечен:
   * клик по нему снимает сортировку сумм и ставит его по возрастанию.
   */
  const handleSort = useCallback((key: PayrollSortKey) => {
    if (amountSortActive) {
      clearAmountSort();
      setDir('asc');
    } else {
      setDir(prevDir => (key === sort ? (prevDir === 'asc' ? 'desc' : 'asc') : 'asc'));
    }
    setSort(key);
  }, [sort, amountSortActive, clearAmountSort]);
  /** Закрытие меню возвращает фокус на шестерёнку — клавиатура не теряет место. */
  const closeColumnsMenu = () => {
    columnsAnchor?.focus();
    setColumnsAnchor(null);
  };

  // Уход со списка (другая вкладка, «Назад» браузера) закрывает всплывающие окна: они в портале,
  // и visibility: hidden списка их не прячет. Выбор подразделения перемонтируется — его
  // список тоже в портале. Фильтры и прокрутка остаются. Паттерн «состояние из прошлого
  // рендера» вместо setState-в-effect (react.dev «You Might Not Need an Effect»).
  const [wasActive, setWasActive] = useState(active);
  const [departmentSelectKey, setDepartmentSelectKey] = useState(0);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active) {
      setOpenFilter(null);
      amountState.closeFilter();
      setColumnsAnchor(null);
      setDepartmentSelectKey(key => key + 1);
    }
  }

  const resetColumnFilters = () => {
    setColumnFilters({});
    amountState.resetFilters();
  };
  const filterCount = activeFilterCount + amountView.filterCount;

  // «Итого» — только на «Расчётах». Прежние строки другого фильтра (keepPreviousData) считать нельзя: «…».
  const rowsStatus: IPayrollTotalsStatus['rows'] = isFetchNextPageError ? 'failed'
    : hasNextPage || isPlaceholderData ? 'pending' : 'ready';
  const calcStatus: IPayrollTotalsStatus['calc'] = calcMerge.failed ? 'failed' : calcMerge.ready ? 'ready' : 'pending';
  const totalsStatus = useMemo<IPayrollTotalsStatus | undefined>(
    () => (isCalcScreen ? { rows: rowsStatus, calc: calcStatus } : undefined),
    [isCalcScreen, rowsStatus, calcStatus],
  );

  // Варианты фильтра столбца — по тем же людям, что в строках за выбранные месяцы.
  const columnValuesParams = useMemo<IPayrollColumnValuesParams>(
    () => (paidMonths ? { ...viewParams, paidMonths } : viewParams),
    [viewParams, paidMonths],
  );

  const resetKey = `${departmentId}|${debouncedSearch}|${columnFiltersKey}|${sort}|${dir}|${employeeId ?? ''}|${group ?? ''}|${objectKey ?? ''}|${amountView.viewKey}`;

  // «Экспорт» «Расчётов» — вся выборка экрана. Пока новая выборка не загрузилась или поиск не применён, на экране
  // прежние строки: кнопка неактивна, чтобы файл не разошёлся с тем, что выбрано.
  const { exporting, exportCalc } = usePayrollCalcExport();
  const handleExport = () => {
    if (!data || shownPaidMonths === null) return;
    void exportCalc({
      pages: data.pages,
      months: shownPaidMonths,
      viewParams,
      sort,
      dir,
      columns,
      hidden: hiddenColumns,
      expanded: expandedColumns,
      departmentName: departmentId ? findDepartmentName(departments, departmentId) ?? 'выбранный отдел' : null,
      categoryLabel: group ? PAYROLL_GROUP_LABELS[group] : null,
      objectName: objectKey ? monthFilter?.object?.name ?? null : null,
      search: debouncedSearch,
      filters: columnFilters,
      amountView: amountView.view,
    });
  };

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <div className={styles.search}>
          <SearchInput clearable value={search} onValueChange={onSearchChange}placeholder="Поиск по ФИО..." aria-label="Поиск по ФИО" />
        </div>
        <div className={styles.department}>
          <DepartmentTreeSelect
            key={departmentSelectKey}
            departments={departments}
            value={monthFilter?.group ? payrollGroupValue(monthFilter.group) : departmentId}
            onChange={handleDepartmentChange}
            isLoading={structureTree.isPending}
            isError={structureTree.isError}
            onRetry={() => { void structureTree.refetch(); }}
            groups={monthFilter ? PAYROLL_GROUP_OPTIONS : undefined}
          />
        </div>
        {isCalcScreen && monthFilter && onMonthFilterChange && (
          // Тот же ключ, что у отдела: уход с «Расчётов» перемонтирует поле и закрывает его список в портале.
          <PayrollObjectFilterField
            key={departmentSelectKey}
            months={monthsList}
            date={date}
            departmentId={departmentId}
            group={monthFilter.group}
            value={monthFilter.object}
            onChange={object => onMonthFilterChange({ ...monthFilter, object })}
          />
        )}
        {filterCount > 0 && (
          <button type="button" className={styles.resetFilters} onClick={resetColumnFilters}>
            Сбросить фильтры ({filterCount})
          </button>
        )}
        <div className={styles.actions}>
          {actionsExtra}
          {isCalcScreen && (
            <button
              type="button"
              className={styles.exportButton}
              disabled={exporting || isPlaceholderData || total === 0 || search.trim() !== debouncedSearch}
              onClick={handleExport}
            >
              <Download size={14} aria-hidden="true" />
              {exporting ? 'Готовим…' : 'Экспорт'}
            </button>
          )}
          <button
            type="button"
            className={hiddenColumns.size > 0 ? `${styles.iconButton} ${styles.iconButtonActive}` : styles.iconButton}
            aria-label="Столбцы таблицы"
            aria-haspopup="dialog"
            aria-expanded={columnsAnchor !== null}
            title={hiddenColumns.size > 0 ? `Столбцы таблицы · скрыто: ${hiddenColumns.size}` : 'Столбцы таблицы'}
            onClick={event => setColumnsAnchor(event.currentTarget)}
          >
            <Settings size={18} aria-hidden="true" />
          </button>
        </div>
      </div>

      {isCalcScreen && calcMerge.failed && (
        <div className={styles.stateError}>
          Не удалось посчитать ФОТ
          <button type="button" className={styles.retryButton} onClick={retryCalc}>
            Повторить
          </button>
        </div>
      )}

      {meta && !meta.contractors_excluded && (
        <div className={styles.warning}>
          Не найден узел «Подрядные организации» — в списке могут оказаться сотрудники подрядчиков.
        </div>
      )}

      {termsQuery.isPending && <div className={styles.state}>Загрузка…</div>}
      {termsQuery.isError && !data && (
        <div className={styles.stateError}>
          Не удалось загрузить условия оплаты
          <button type="button" className={styles.retryButton} onClick={() => { void termsQuery.refetch(); }}>
            Повторить
          </button>
        </div>
      )}

      {data && (
        <>
          <PayrollTermsTable
            rows={amountView.viewRows}
            columns={columns}
            hiddenColumns={tableHiddenColumns}
            onEdit={onOpenEmployee}
            onLoadMore={loadMore}
            resetKey={resetKey}
            sort={sort}
            dir={dir}
            onSort={handleSort}
            columnFilters={columnFilters}
            onOpenFilter={handleOpenFilter}
            accrualMonths={accrualMonths}
            paidPeriod={paidPeriod}
            onOpenPaidItems={onOpenPaidItems ? handleOpenPaidItems : undefined}
            expandedColumns={isCalcScreen ? expandedColumns : undefined}
            onToggleExpand={isCalcScreen ? toggleExpanded : undefined}
            totalsStatus={totalsStatus}
            amountView={isCalcScreen ? amountView.view : undefined}
            onAmountSort={amountState.sortBy}
            onOpenAmountFilter={amountState.openFilterFor}
            // Список «Не посчитано» — фильтром «Суммы»: у скрытого столбца фильтр не действует, подпись не нажимается.
            onShowUncounted={isCalcScreen && !tableHiddenColumns.has('calc_net') ? amountState.showUncounted : undefined}
            onHideUncounted={uncountedShown ? amountState.hideUncounted : undefined}
          />
          <div className={styles.footer}>
            {isFetchNextPageError ? (
              <>
                <span className={styles.footerError}>Не удалось загрузить следующую порцию</span>
                <button type="button" className={styles.retryButton} onClick={retryNextPage}>
                  Повторить
                </button>
              </>
            ) : (
              <span>
                Загружено {rows.length} из {total}{isFetchingNextPage ? ' — загрузка…' : ''}
              </span>
            )}
          </div>
        </>
      )}

      {openFilter && (
        <PayrollColumnFilterPopover
          key={openFilter.column}
          column={openFilter.column}
          label={PAYROLL_FILTER_COLUMN_LABELS[openFilter.column]}
          filters={columnFilters}
          viewParams={columnValuesParams}
          anchor={openFilter.anchor}
          allowFired={isCalcScreen}
          onApply={applyColumnFilter}
          onClose={closeFilter}
        />
      )}

      {amountState.openFilter && (
        <ColumnValuesFilterPopover
          key={amountState.openFilter.column}
          label={amountView.filterLabel}
          options={amountView.filterOptions}
          selected={amountView.view.filters[amountState.openFilter.column] ?? []}
          anchor={amountState.openFilter.anchor}
          onApply={amountState.applyFilter}
          onClose={amountState.closeFilter}
        />
      )}

      {columnsAnchor && (
        <PayrollColumnsMenu
          anchor={columnsAnchor}
          columns={columns}
          hidden={hiddenColumns}
          empty={emptyColumns}
          onToggle={setColumnVisible}
          onShowAll={showAll}
          onClose={closeColumnsMenu}
        />
      )}
    </div>
  );
};
