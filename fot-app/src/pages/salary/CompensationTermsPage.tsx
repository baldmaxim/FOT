import { useCallback, useMemo, useRef, useState, type FC, type ReactNode } from 'react';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { Settings } from 'lucide-react';

import {
  payrollService,
  PAYROLL_TERMS_PAGE_SIZE,
  type IPayrollColumnFilters,
  type IPayrollTermsCursor,
  type IPayrollTermsRow,
  type IPayrollTermsViewParams,
  type PayrollPaidMonths,
  type PayrollSortDir,
  type PayrollSortKey,
} from '../../services/payrollService';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { usePayrollHiddenColumns } from '../../hooks/usePayrollHiddenColumns';
import { usePayrollStructureTree } from '../../hooks/useStructure';
import { useStaffSectionDepartments } from '../../hooks/useStaffSectionDepartments';
import { shouldLoadMore } from '../../utils/staffLoadMore';
import { filterDepartmentTreeByIds } from '../../utils/departmentUtils';
import { payrollAccrualMonths } from '../../utils/payrollAccruals';
import {
  countActivePayrollColumnFilters,
  isPayrollColumnFilterActive,
  serializePayrollColumnFilters,
  setPayrollColumnFilter,
} from '../../utils/payrollColumnFilters';
import {
  PAYROLL_TERMS_COLUMNS_KEY,
  PAYROLL_TERMS_TABLE_COLUMNS,
  type PayrollTableColumn,
  type PayrollTableColumns,
} from '../../utils/payrollColumns';
import { formatPaidPeriod, type PayrollPaidTotalKind } from '../../utils/payrollPaid';
import { SearchInput } from '../../components/ui/SearchInput';
import { PayrollColumnFilterPopover } from '../../components/salary/PayrollColumnFilterPopover';
import { PayrollColumnsMenu } from '../../components/salary/PayrollColumnsMenu';
import { PayrollTermsTable } from '../../components/salary/PayrollTermsTable';
import { DepartmentTreeSelect } from '../../components/staff/DepartmentTreeSelect';
import styles from './CompensationTermsPage.module.css';

/** Подписи столбцов для заголовка окна фильтра. */
const COLUMN_LABELS: Record<PayrollSortKey, string> = {
  name: 'Сотрудник',
  department: 'Подразделение',
  position: 'Должность',
  schedule: 'График работы',
  salary: 'Оклад',
  bonus: 'Премиальная часть',
  housing: 'Компенсация проживания',
};

interface ICompensationTermsPageProps {
  /** Дата выборки — одна на список и карточку «Подробно» (см. PaymentsTab). */
  date: string;
  /** Список на экране. Скрытый список не размонтируется: фильтры, выделение и прокрутка сохраняются. */
  active: boolean;
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
   * «Расчёты»: месяцы сумм «К выплате», «Начислено» и «Удержаний»; null — месяцы ещё грузятся, список ждёт.
   * Не передан — «Условия оплаты», сумм нет.
   */
  paidMonths?: PayrollPaidMonths | null;
  /** Клик по сумме «Начислено» или «Удержания»: строка, раздел, кнопка (вернуть фокус) и месяцы сумм строки. */
  onOpenPaidItems?: (row: IPayrollTermsRow, kind: PayrollPaidTotalKind, trigger: HTMLButtonElement, months: PayrollPaidMonths) => void;
}

export const CompensationTermsPage: FC<ICompensationTermsPageProps> = ({
  date,
  active,
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
  }), [date, departmentId, debouncedSearch, columnFiltersKey]);

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
    data, hasNextPage, isFetchingNextPage, isFetchNextPageError, isPlaceholderData, fetchNextPage,
  } = termsQuery;

  const rows = useMemo(() => data?.pages.flatMap(page => page.rows) ?? [], [data]);
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

  const applyColumnFilter = useCallback((column: PayrollSortKey, value: (string | null)[] | string | null) => {
    setColumnFilters(prev => setPayrollColumnFilter(prev, column, value));
  }, []);

  const closeFilter = useCallback(() => setOpenFilter(null), []);

  // Шестерёнка «Столбцы таблицы». Скрытый столбец не должен фильтровать и сортировать невидимо —
  // его фильтр и сортировка снимаются вместе со скрытием.
  const [columnsAnchor, setColumnsAnchor] = useState<HTMLElement | null>(null);
  const clearHiddenColumnConditions = (column: PayrollTableColumn) => {
    // Без сортировки и фильтра.
    if (column === 'accruals' || column === 'payout' || column === 'accrued' || column === 'deductions') return;
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

  const resetKey = `${departmentId}|${debouncedSearch}|${columnFiltersKey}|${sort}|${dir}`;

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
            rows={rows}
            columns={columns}
            hiddenColumns={hiddenColumns}
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
          label={COLUMN_LABELS[openFilter.column]}
          filters={columnFilters}
          viewParams={viewParams}
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
          onToggle={setColumnVisible}
          onShowAll={showAll}
          onClose={closeColumnsMenu}
        />
      )}
    </div>
  );
};
