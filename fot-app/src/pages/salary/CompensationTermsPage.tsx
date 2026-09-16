import { useCallback, useMemo, useRef, useState, type FC } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import {
  payrollService,
  PAYROLL_TERMS_PAGE_SIZE,
  defaultCalcTypeFor,
  type IPayrollTermsCursor,
  type IPayrollTermsRow,
} from '../../services/payrollService';
import { useToast } from '../../contexts/ToastContext';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useStructureTree } from '../../hooks/useStructure';
import { shouldLoadMore } from '../../utils/staffLoadMore';
import { SearchInput } from '../../components/ui/SearchInput';
import { AssignTermsModal } from '../../components/salary/AssignTermsModal';
import { PayrollTermsTable } from '../../components/salary/PayrollTermsTable';
import { DepartmentTreeSelect } from '../../components/staff/DepartmentTreeSelect';
import type { OrgDepartmentNode } from '../../types';
import styles from './CompensationTermsPage.module.css';

/** Дерево без ветки подрядчиков: они исключены из списка, выбор их узла всегда давал бы 0. */
const withoutNode = (nodes: OrgDepartmentNode[], excludedId: string | null): OrgDepartmentNode[] => (
  excludedId
    ? nodes
      .filter(node => node.id !== excludedId)
      .map(node => ({ ...node, children: withoutNode(node.children ?? [], excludedId) }))
    : nodes
);

/**
 * Сегодня по часам браузера. toISOString() дал бы дату UTC: после местной полуночи
 * (до 03:00 по Москве) выборка шла бы на вчерашний день.
 */
const today = (): string => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
};

export const CompensationTermsPage: FC = () => {
  const { success, error: showError, warning } = useToast();
  const queryClient = useQueryClient();

  // Дата выборки фиксируется на открытии экрана: условия и графики — «на сегодня».
  const [date] = useState(today);
  const [departmentId, setDepartmentId] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [modalFor, setModalFor] = useState<IPayrollTermsRow[] | null>(null);

  // Поиск идёт на сервере по всему штату, а не по загруженным порциям.
  const debouncedSearch = useDebouncedValue(search.trim(), 300);

  const termsQuery = useInfiniteQuery({
    queryKey: ['payroll-terms', 'infinite', date, departmentId, debouncedSearch],
    queryFn: ({ pageParam, signal }) => payrollService.listTerms({
      date,
      departmentId: departmentId || undefined,
      q: debouncedSearch || undefined,
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
  const contractorRootId = meta?.contractor_root_id ?? null;
  const departments = useMemo(
    () => withoutNode(structureTree.data?.departments ?? [], contractorRootId),
    [structureTree.data, contractorRootId],
  );

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

  const assignMutation = useMutation({
    mutationFn: async (payload: Parameters<typeof payrollService.assignBulk>[1] & { ids: number[] }) => {
      const { ids, ...rest } = payload;
      return ids.length === 1
        ? payrollService.assign(ids[0], rest).then(() => ({ applied: [{ employee_id: ids[0], terms_id: 0 }], skipped: [] }))
        : payrollService.assignBulk(ids, rest);
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['payroll-terms'] });
      setSelected(new Set());
      setModalFor(null);
      if (result.skipped.length > 0) {
        warning(`Применено: ${result.applied.length}. Отклонено: ${result.skipped.length} — ${result.skipped[0].message}`);
      } else {
        success(`Условия оплаты назначены: ${result.applied.length}`);
      }
    },
    onError: (err: Error) => showError(err.message || 'Не удалось назначить условия'),
  });

  const toggleOne = useCallback((employeeId: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(employeeId)) next.delete(employeeId);
      else next.add(employeeId);
      return next;
    });
  }, []);

  const allLoadedSelected = rows.length > 0 && rows.every(row => selected.has(row.employee_id));
  const toggleAll = useCallback(() => {
    setSelected(allLoadedSelected ? new Set() : new Set(rows.map(row => row.employee_id)));
  }, [allLoadedSelected, rows]);

  const openOne = useCallback((row: IPayrollTermsRow) => setModalFor([row]), []);

  const openBulk = () => {
    const chosen = rows.filter(row => selected.has(row.employee_id));
    if (chosen.length > 0) setModalFor(chosen);
  };

  const resetKey = `${departmentId}|${debouncedSearch}`;

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
        <div className={styles.actions}>
          {selected.size > 0 && <span className={styles.selectedInfo}>Выделено: {selected.size}</span>}
          <button
            type="button"
            className={styles.primaryButton}
            disabled={selected.size === 0}
            onClick={openBulk}
          >
            Назначить выделенным
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
            onToggleOne={toggleOne}
            onToggleAll={toggleAll}
            onEdit={openOne}
            onLoadMore={loadMore}
            resetKey={resetKey}
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

      {modalFor && (
        <AssignTermsModal
          rows={modalFor}
          defaultDate={date}
          isSaving={assignMutation.isPending}
          onClose={() => setModalFor(null)}
          onSubmit={(payload) => assignMutation.mutate({
            ...payload,
            ids: modalFor.map(row => row.employee_id),
          })}
          resolveDefaultCalcType={defaultCalcTypeFor}
        />
      )}
    </div>
  );
};
