import { useCallback, useEffect, useMemo, useRef, useState, type FC, type ReactNode } from 'react';
import { keepPreviousData, useInfiniteQuery, useQueries, useQueryClient } from '@tanstack/react-query';
import { Download, Settings } from 'lucide-react';

import {
  payrollService,
  PAYROLL_TERMS_PAGE_SIZE,
  type IPayrollColumnFilters,
  type IPayrollColumnValuesParams,
  type IPayrollTermsCursor,
  type IPayrollTermsRow,
  type IPayrollTermsViewParams,
  type PayrollPaidMonths,
  type PayrollSortDir,
  type PayrollSortKey,
} from '../../services/payrollService';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { usePayrollCalcExport } from '../../hooks/usePayrollCalcExport';
import { usePayrollExpandedColumns } from '../../hooks/usePayrollExpandedColumns';
import { usePayrollHiddenColumns } from '../../hooks/usePayrollHiddenColumns';
import { usePayrollStructureTree } from '../../hooks/useStructure';
import { useStaffSectionDepartments } from '../../hooks/useStaffSectionDepartments';
import { shouldLoadMore } from '../../utils/staffLoadMore';
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
import {
  calcColumnsQueryKey,
  calcPageRequests,
  calcQueryEnabled,
  mergeCalcColumns,
  toCalcQueryState,
  type CalcQueryState,
} from '../../utils/payrollCalcPages';
import type { IPayrollTotalsStatus } from '../../utils/payrollCalcTotals';
import { formatPaidPeriod, type PayrollPaidTotalKind } from '../../utils/payrollPaid';
import { SearchInput } from '../../components/ui/SearchInput';
import { PayrollColumnFilterPopover } from '../../components/salary/PayrollColumnFilterPopover';
import { PayrollColumnsMenu } from '../../components/salary/PayrollColumnsMenu';
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
}) => {
  // «Выплачено» — за закрытые месяцы перед месяцем этой даты.
  const accrualMonths = useMemo(() => payrollAccrualMonths(date), [date]);
  const [sort, setSort] = useState<PayrollSortKey>('name');
  const [dir, setDir] = useState<PayrollSortDir>('asc');
  const [columnFilters, setColumnFilters] = useState<IPayrollColumnFilters>({});
  const [openFilter, setOpenFilter] = useState<{ column: PayrollSortKey; anchor: HTMLElement } | null>(null);

  // Поиск идёт на сервере по всему штату, а не по загруженным порциям.
  const debouncedSearch = useDebouncedValue(search.trim(), 300);

  // Одинаковые фильтры дают одинаковую строку — один ключ кэша.
  const columnFiltersKey = serializePayrollColumnFilters(columnFilters);
  const activeFilterCount = countActivePayrollColumnFilters(columnFilters);

  const viewParams = useMemo<IPayrollTermsViewParams>(() => ({
    date,
    departmentId: departmentId || undefined,
    q: debouncedSearch || undefined,
    cf: columnFiltersKey || undefined,
    employeeId,
  }), [date, departmentId, debouncedSearch, columnFiltersKey, employeeId]);

  const termsQuery = useInfiniteQuery({
    queryKey: ['payroll-terms', 'infinite', viewParams, sort, dir, paidMonths ?? null],
    // Порция помнит месяцы, с которыми запрошена: пока грузится новый период, на экране прежние
    // строки (keepPreviousData) — и подпись периода должна оставаться их, а не уже выбранной.
    queryFn: async ({ pageParam, signal }) => ({
      ...await payrollService.listTerms({
        ...viewParams,
        sort,
        dir,
        pageSize: PAYROLL_TERMS_PAGE_SIZE,
        cursor: pageParam,
        paidMonths: paidMonths ?? undefined,
        // «Расчёты»: строки сразу, столбцы ФОТ — отдельными запросами ниже.
        deferCalc: paidMonths !== undefined,
      }, signal),
      paidMonths: paidMonths ?? null,
    }),
    initialPageParam: null as IPayrollTermsCursor | null,
    getNextPageParam: last => last.meta.next_cursor ?? undefined,
    enabled: paidMonths !== null,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  const {
    data, hasNextPage, isFetching, isFetchingNextPage, isFetchNextPageError, isPlaceholderData, fetchNextPage,
  } = termsQuery;

  const rows = useMemo(() => data?.pages.flatMap(page => page.rows) ?? [], [data]);

  // «Расчёты»: столбцы ФОТ — по каждой порции её же id и месяцами, по одной (payrollCalcPages.ts). Следующая порция
  // ждёт, пока предыдущая завершится; скрытый экран не считает.
  const isCalcScreen = paidMonths !== undefined;
  const queryClient = useQueryClient();
  const calcRequests = useMemo(() => (isCalcScreen && data ? calcPageRequests(data.pages) : []), [isCalcScreen, data]);
  const cachedCalcStates = calcRequests.map(request => toCalcQueryState(queryClient.getQueryState(calcColumnsQueryKey(request))));
  const calcStates = useQueries({
    queries: calcRequests.map((request, index) => ({
      queryKey: calcColumnsQueryKey(request),
      queryFn: ({ signal }: { signal: AbortSignal }) => payrollService.calcColumns(request.ids, request.months, signal),
      enabled: calcQueryEnabled(index, cachedCalcStates, active),
      staleTime: 30_000,
      // Расчёт тяжёлый: повтор — по кнопке, не сам.
      retry: false,
    })),
    combine: results => results.map((result): CalcQueryState => {
      if (result.isSuccess) return { status: 'success', result: result.data };
      return result.isError ? { status: 'error' } : { status: 'pending' };
    }),
  });
  const calcMerge = useMemo(() => mergeCalcColumns(rows, calcRequests, calcStates), [rows, calcRequests, calcStates]);
  const tableRows = isCalcScreen ? calcMerge.rows : rows;
  /** «Повторить» — только порции, которые не посчитались. */
  const retryCalc = () => {
    calcRequests.forEach((request, index) => {
      if (calcStates[index]?.status === 'error') {
        void queryClient.refetchQueries({ queryKey: calcColumnsQueryKey(request), exact: true });
      }
    });
  };
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

  // Синхронный флаг «порция уже запрошена»: isFetchingNextPage обновится только после рендера,
  // и быстрая прокрутка успела бы отправить одну и ту же порцию дважды.
  const inFlightRef = useRef(false);

  const loadMore = useCallback((lastVisibleIndex: number) => {
    const allowed = shouldLoadMore({
      lastVisibleIndex,
      loadedCount: rows.length,
      hasNextPage,
      inFlight: inFlightRef.current,
      isFetchingNextPage,
      isPlaceholderData,
      isFetchNextPageError,
    });
    if (!allowed) return;
    inFlightRef.current = true;
    void fetchNextPage({ cancelRefetch: false }).finally(() => { inFlightRef.current = false; });
  }, [rows.length, hasNextPage, isFetchingNextPage, isPlaceholderData, isFetchNextPageError, fetchNextPage]);

  // «Расчёты»: «Итого» — по всей выборке, поэтому порции грузятся сами, не дожидаясь прокрутки. По isFetching, а не по
  // inFlightRef: ref сбросится после рендера, и эффект, не увидев перемены, остановил бы догрузку. Упавшая — по кнопке.
  useEffect(() => {
    if (!isCalcScreen || !active || !hasNextPage) return;
    if (isFetching || isPlaceholderData || isFetchNextPageError) return;
    void fetchNextPage({ cancelRefetch: false });
  }, [isCalcScreen, active, hasNextPage, isFetching, isPlaceholderData, isFetchNextPageError, fetchNextPage]);

  /** Повтор упавшей порции — только по кнопке: автоповтор у нижней границы дал бы цикл запросов. */
  const retryNextPage = () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    void fetchNextPage({ cancelRefetch: false }).finally(() => { inFlightRef.current = false; });
  };

  /** Тот же столбец — смена направления, другой — по возрастанию. */
  const handleSort = useCallback((key: PayrollSortKey) => {
    setDir(prevDir => (key === sort ? (prevDir === 'asc' ? 'desc' : 'asc') : 'asc'));
    setSort(key);
  }, [sort]);

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
      setColumnsAnchor(null);
      setDepartmentSelectKey(key => key + 1);
    }
  }

  const resetColumnFilters = () => setColumnFilters({});

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

  const resetKey = `${departmentId}|${debouncedSearch}|${columnFiltersKey}|${sort}|${dir}|${employeeId ?? ''}`;

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
      search: debouncedSearch,
      filters: columnFilters,
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
            value={departmentId}
            onChange={onDepartmentChange}
            isLoading={structureTree.isPending}
            isError={structureTree.isError}
            onRetry={() => { void structureTree.refetch(); }}
          />
        </div>
        {activeFilterCount > 0 && (
          <button type="button" className={styles.resetFilters} onClick={resetColumnFilters}>
            Сбросить фильтры ({activeFilterCount})
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
            rows={tableRows}
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
          onApply={applyColumnFilter}
          onClose={closeFilter}
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
