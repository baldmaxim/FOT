import { useCallback, useMemo, useRef, useState, type FC } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Settings } from 'lucide-react';

import {
  payrollService,
  PAYROLL_TERMS_PAGE_SIZE,
  defaultCalcTypeFor,
  type IPayrollColumnFilters,
  type IPayrollTermsCursor,
  type IPayrollTermsRow,
  type IPayrollTermsViewParams,
  type PayrollSortDir,
  type PayrollSortKey,
} from '../../services/payrollService';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { usePayrollHiddenColumns } from '../../hooks/usePayrollHiddenColumns';
import { useStructureTree } from '../../hooks/useStructure';
import { useStaffSectionDepartments } from '../../hooks/useStaffSectionDepartments';
import { shouldLoadMore } from '../../utils/staffLoadMore';
import { filterDepartmentTreeByIds } from '../../utils/departmentUtils';
import { moscowTodayIso } from '../../utils/moscowDate';
import { payrollAccrualMonths } from '../../utils/payrollAccruals';
import {
  countActivePayrollColumnFilters,
  isPayrollColumnFilterActive,
  serializePayrollColumnFilters,
  setPayrollColumnFilter,
} from '../../utils/payrollColumnFilters';
import type { PayrollTableColumn } from '../../utils/payrollColumns';
import { SearchInput } from '../../components/ui/SearchInput';
import { AssignTermsModal } from '../../components/salary/AssignTermsModal';
import { EmployeePayrollModal } from '../../components/salary/EmployeePayrollModal';
import { PayrollAccrualsPopover } from '../../components/salary/PayrollAccrualsPopover';
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

export const CompensationTermsPage: FC = () => {
  const { success, error: showError, warning } = useToast();
  const { canEditPage } = useAuth();
  const queryClient = useQueryClient();
  const canEdit = canEditPage('/salary/terms');

  // Дата выборки фиксируется на открытии экрана: условия и графики — «на сегодня» по Москве,
  // как на сервере. Дата браузера в другом поясе давала бы соседний день.
  const [date] = useState(moscowTodayIso);
  // Начисления — за закрытые месяцы перед месяцем этой даты.
  const accrualMonths = useMemo(() => payrollAccrualMonths(date), [date]);
  const [departmentId, setDepartmentId] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<PayrollSortKey>('name');
  const [dir, setDir] = useState<PayrollSortDir>('asc');
  const [columnFilters, setColumnFilters] = useState<IPayrollColumnFilters>({});
  const [openFilter, setOpenFilter] = useState<{ column: PayrollSortKey; anchor: HTMLElement } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // Карточка одного сотрудника и массовое назначение — разные окна.
  const [cardRow, setCardRow] = useState<IPayrollTermsRow | null>(null);
  const [bulkRows, setBulkRows] = useState<IPayrollTermsRow[] | null>(null);

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
    queryKey: ['payroll-terms', 'infinite', viewParams, sort, dir],
    queryFn: ({ pageParam, signal }) => payrollService.listTerms({
      ...viewParams,
      sort,
      dir,
      pageSize: PAYROLL_TERMS_PAGE_SIZE,
      cursor: pageParam,
    }, signal),
    initialPageParam: null as IPayrollTermsCursor | null,
    getNextPageParam: last => last.meta.next_cursor ?? undefined,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  const {
    data, hasNextPage, isFetchingNextPage, isFetchNextPageError, isPlaceholderData, fetchNextPage,
  } = termsQuery;

  const rows = useMemo(() => data?.pages.flatMap(page => page.rows) ?? [], [data]);
  const meta = data?.pages[0]?.meta;
  const total = meta?.total ?? 0;

  const structureTree = useStructureTree();
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

  // Смена фильтра меняет выборку: снимаем выделение, иначе можно назначить условия
  // строкам, которых на экране уже нет.
  const changeSearch = (value: string) => {
    setSearch(value);
    setSelected(new Set());
  };
  const changeDepartment = (id: string) => {
    setDepartmentId(id);
    setSelected(new Set());
  };

  /** Тот же столбец — смена направления, другой — по возрастанию. */
  const handleSort = useCallback((key: PayrollSortKey) => {
    setDir(prevDir => (key === sort ? (prevDir === 'asc' ? 'desc' : 'asc') : 'asc'));
    setSort(key);
    setSelected(new Set());
  }, [sort]);

  const handleOpenFilter = useCallback((column: PayrollSortKey, anchor: HTMLElement) => {
    setOpenFilter({ column, anchor });
  }, []);

  const applyColumnFilter = useCallback((column: PayrollSortKey, value: (string | null)[] | string | null) => {
    setColumnFilters(prev => setPayrollColumnFilter(prev, column, value));
    setSelected(new Set());
  }, []);

  const closeFilter = useCallback(() => setOpenFilter(null), []);

  // Шестерёнка «Столбцы таблицы». Скрытый столбец не должен фильтровать и сортировать невидимо —
  // его фильтр и сортировка снимаются вместе со скрытием.
  const [columnsAnchor, setColumnsAnchor] = useState<HTMLElement | null>(null);
  const clearHiddenColumnConditions = (column: PayrollTableColumn) => {
    if (column === 'accruals') return;
    const hadFilter = isPayrollColumnFilterActive(columnFilters, column);
    if (hadFilter) setColumnFilters(prev => setPayrollColumnFilter(prev, column, null));
    if (sort === column) {
      setSort('name');
      setDir('asc');
    }
    if (hadFilter || sort === column) setSelected(new Set());
  };
  const { hidden: hiddenColumns, setColumnVisible, showAll } = usePayrollHiddenColumns(clearHiddenColumnConditions);
  /** Закрытие меню возвращает фокус на шестерёнку — клавиатура не теряет место. */
  const closeColumnsMenu = () => {
    columnsAnchor?.focus();
    setColumnsAnchor(null);
  };

  // Суммы по месяцам из ячейки «Начисления». Закрытие возвращает фокус на ячейку, если строка
  // ещё отрисована (виртуализация могла её убрать).
  const [accrualsFor, setAccrualsFor] = useState<{ row: IPayrollTermsRow; anchor: HTMLElement } | null>(null);
  const openAccruals = useCallback((row: IPayrollTermsRow, anchor: HTMLElement) => {
    setAccrualsFor({ row, anchor });
  }, []);
  const closeAccruals = () => {
    if (accrualsFor?.anchor.isConnected) accrualsFor.anchor.focus();
    setAccrualsFor(null);
  };

  const resetColumnFilters = () => {
    setColumnFilters({});
    setSelected(new Set());
  };

  const assignMutation = useMutation({
    mutationFn: async (payload: Parameters<typeof payrollService.assignBulk>[1] & { ids: number[] }) => {
      const { ids, ...rest } = payload;
      return ids.length === 1
        ? payrollService.assign(ids[0], rest).then(() => ({ applied: [{ employee_id: ids[0], terms_id: 0 }], skipped: [] }))
        : payrollService.assignBulk(ids, rest);
    },
    onSuccess: (result) => {
      // Префикс сбрасывает и список, и историю зарплаты в карточке.
      queryClient.invalidateQueries({ queryKey: ['payroll-terms'] });
      setSelected(new Set());
      setCardRow(null);
      setBulkRows(null);
      if (result.skipped.length > 0) {
        warning(`Применено: ${result.applied.length}. Отклонено: ${result.skipped.length} — ${result.skipped[0].message}`);
      } else {
        success(`Условия оплаты назначены: ${result.applied.length}`);
      }
    },
    // Ошибку сохранения показывает само окно (ввод не теряется). Тост — только если окно
    // успели закрыть, пока шёл запрос.
    onError: (err: Error) => {
      if (!cardRow && !bulkRows) showError(err.message || 'Не удалось назначить условия');
    },
  });
  const { reset: resetAssign } = assignMutation;
  const saveError = assignMutation.isError
    ? (assignMutation.error?.message || 'Не удалось назначить условия')
    : null;

  const toggleOne = useCallback((employeeId: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(employeeId)) next.delete(employeeId);
      else next.add(employeeId);
      return next;
    });
  }, []);

  /** Право на страницу и скоуп правки этого сотрудника (can_edit нет у старого бэкенда — решит сервер). */
  const isRowEditable = useCallback(
    (row: IPayrollTermsRow) => canEdit && row.can_edit !== false,
    [canEdit],
  );

  // Выделяются только редактируемые строки: назначить условия остальным всё равно нельзя.
  const editableRows = useMemo(() => rows.filter(isRowEditable), [rows, isRowEditable]);
  const allLoadedSelected = editableRows.length > 0 && editableRows.every(row => selected.has(row.employee_id));
  const toggleAll = useCallback(() => {
    setSelected(allLoadedSelected ? new Set() : new Set(editableRows.map(row => row.employee_id)));
  }, [allLoadedSelected, editableRows]);

  // Ошибка прошлого сохранения не должна всплыть в новом окне.
  const openOne = useCallback((row: IPayrollTermsRow) => {
    resetAssign();
    setCardRow(row);
  }, [resetAssign]);

  const openBulk = () => {
    const chosen = editableRows.filter(row => selected.has(row.employee_id));
    if (chosen.length === 0) return;
    resetAssign();
    setBulkRows(chosen);
  };

  const resetKey = `${departmentId}|${debouncedSearch}|${columnFiltersKey}|${sort}|${dir}`;

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <div className={styles.search}>
          <SearchInput value={search} onValueChange={changeSearch} placeholder="Поиск по ФИО..." aria-label="Поиск по ФИО" />
        </div>
        <div className={styles.department}>
          <DepartmentTreeSelect
            departments={departments}
            value={departmentId}
            onChange={changeDepartment}
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
          {selected.size > 0 && <span className={styles.selectedInfo}>Выделено: {selected.size}</span>}
          <button
            type="button"
            className={styles.primaryButton}
            disabled={!canEdit || selected.size === 0}
            onClick={openBulk}
          >
            Назначить выделенным
          </button>
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
            selected={selected}
            allSelected={allLoadedSelected}
            canEdit={canEdit}
            hiddenColumns={hiddenColumns}
            onToggleOne={toggleOne}
            onToggleAll={toggleAll}
            onEdit={openOne}
            onLoadMore={loadMore}
            resetKey={resetKey}
            sort={sort}
            dir={dir}
            onSort={handleSort}
            columnFilters={columnFilters}
            onOpenFilter={handleOpenFilter}
            accrualMonths={accrualMonths}
            onOpenAccruals={openAccruals}
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
          hidden={hiddenColumns}
          onToggle={setColumnVisible}
          onShowAll={showAll}
          onClose={closeColumnsMenu}
        />
      )}

      {accrualsFor && (
        <PayrollAccrualsPopover
          row={accrualsFor.row}
          months={accrualMonths}
          anchor={accrualsFor.anchor}
          onClose={closeAccruals}
        />
      )}

      {cardRow && (
        <EmployeePayrollModal
          row={cardRow}
          canEdit={isRowEditable(cardRow)}
          defaultDate={date}
          isSaving={assignMutation.isPending}
          saveError={saveError}
          onClose={() => setCardRow(null)}
          onSubmit={(payload) => assignMutation.mutate({ ...payload, ids: [cardRow.employee_id] })}
          resolveDefaultCalcType={defaultCalcTypeFor}
        />
      )}

      {bulkRows && (
        <AssignTermsModal
          count={bulkRows.length}
          defaultDate={date}
          isSaving={assignMutation.isPending}
          saveError={saveError}
          onClose={() => setBulkRows(null)}
          onSubmit={(payload) => assignMutation.mutate({
            ...payload,
            ids: bulkRows.map(row => row.employee_id),
          })}
          resolveDefaultCalcType={defaultCalcTypeFor}
        />
      )}
    </div>
  );
};
