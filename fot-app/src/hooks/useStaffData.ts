import { useCallback, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Employee } from '../types';
import type { StaffPeriod, StaffSortDir, StaffSortKey } from '../services/employeeService';
import { useStructureTree } from './useStructure';
import {
  EMPTY_EMPLOYEE_COUNTS,
  employeeCountsQueryKey,
  infiniteEmployeesQueryKey,
  useEmployeeCountsQuery,
  useInfiniteEmployeesQuery,
} from './useEmployeeDirectory';
import {
  buildPageIdChunks,
  mergeEmployeePages,
  patchEmployeeInPages,
  type IEmployeePagesData,
} from '../utils/staffInfiniteList';
import { shouldLoadMore } from '../utils/staffLoadMore';
import { STAFF_MONTH_MOVEMENT_QUERY_KEY } from './useStaffMonthMovement';

/** Порция «Текущих сотрудников»: догружается при прокрутке к концу списка. */
export const STAFF_CHUNK_SIZE = 500;

const EMPTY_EMPLOYEES: Employee[] = [];
const EMPTY_CHUNKS: number[][] = [];

interface IUseStaffDataParams {
  search?: string;
  departmentId?: string;
  scheduleId?: string;
  /** Раздел (su10 | sm | contractors | all). */
  section?: string;
  status?: 'active' | 'fired' | 'excluded';
  sort: StaffSortKey;
  dir: StaffSortDir;
  period?: StaffPeriod;
  /** false — список не запрашивается (раздел по умолчанию ещё не определён). */
  enabled?: boolean;
}

export const useStaffData = (params: IUseStaffDataParams) => {
  const { search, departmentId, scheduleId, section, status = 'active', sort, dir, period, enabled = true } = params;
  const queryClient = useQueryClient();
  const structureQuery = useStructureTree();
  const employeesParams = {
    pageSize: STAFF_CHUNK_SIZE,
    search: search || undefined,
    departmentId: departmentId || undefined,
    scheduleId: scheduleId || undefined,
    section: section || undefined,
    status,
    // Новый клиент всегда сортирует явно: сервер отдаёт курсор { key, isNull, id }.
    sort,
    dir,
    period: period || undefined,
    view: 'staff' as const,
  };
  const employeesQueryKey = infiniteEmployeesQueryKey(employeesParams);
  const employeesQuery = useInfiniteEmployeesQuery(employeesParams, enabled);
  const countsQuery = useEmployeeCountsQuery(false);

  const pages = employeesQuery.data?.pages;
  const employees = useMemo(() => (pages ? mergeEmployeePages(pages) : EMPTY_EMPLOYEES), [pages]);
  const pageIdChunks = useMemo(() => (pages ? buildPageIdChunks(pages) : EMPTY_CHUNKS), [pages]);
  const total = pages?.[0]?.meta.total ?? 0;

  const counts = countsQuery.data || EMPTY_EMPLOYEE_COUNTS;
  const departments = structureQuery.data?.departments || [];

  // Синхронный guard: isFetchingNextPage обновится только после рендера, а события прокрутки
  // приходят раньше — без ref одна граница отправила бы несколько запросов.
  const inFlightRef = useRef(false);
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, isPlaceholderData, fetchNextPage } = employeesQuery;

  const loadMore = useCallback((lastVisibleIndex: number) => {
    const allowed = shouldLoadMore({
      lastVisibleIndex,
      loadedCount: employees.length,
      hasNextPage,
      inFlight: inFlightRef.current,
      isFetchingNextPage,
      isPlaceholderData,
      isFetchNextPageError,
    });
    if (!allowed) return;
    inFlightRef.current = true;
    void fetchNextPage({ cancelRefetch: false }).finally(() => { inFlightRef.current = false; });
  }, [employees.length, hasNextPage, isFetchingNextPage, isPlaceholderData, isFetchNextPageError, fetchNextPage]);

  /** Повтор упавшей порции — только по кнопке, автодогрузка после ошибки остановлена. */
  const retryNextPage = useCallback(() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    void fetchNextPage({ cancelRefetch: false }).finally(() => { inFlightRef.current = false; });
  }, [fetchNextPage]);

  const patchEmployee = useCallback((id: number, patch: Partial<Employee>) => {
    queryClient.setQueryData<IEmployeePagesData>(employeesQueryKey, previous => patchEmployeeInPages(previous, id, patch));
  }, [employeesQueryKey, queryClient]);

  /**
   * Изменилось значение активного столбца сортировки: строка могла сменить место. Порции
   * перечитываются последовательно с первой, курсоры пересчитываются по свежим данным —
   * без дублей и пропусков, таблица на время перезапроса не пропадает.
   */
  const reloadFromStart = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: employeesQueryKey, exact: true });
  }, [employeesQueryKey, queryClient]);

  const refresh = useCallback(() => {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: employeesQueryKey }),
      queryClient.invalidateQueries({ queryKey: employeeCountsQueryKey(false) }),
      // Приём, увольнение, восстановление меняют чипы «с начала месяца».
      queryClient.invalidateQueries({ queryKey: STAFF_MONTH_MOVEMENT_QUERY_KEY }),
    ]);
  }, [employeesQueryKey, queryClient]);

  return {
    employees,
    pageIdChunks,
    total,
    departments,
    countsByDepartment: counts.byDepartment,
    loading: !enabled || employeesQuery.isPending || structureQuery.isPending || countsQuery.isPending,
    isFirstPageError: employeesQuery.isError && !pages,
    firstPageError: employeesQuery.error,
    retryFirstPage: employeesQuery.refetch,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    loadMore,
    retryNextPage,
    totalActive: counts.byStatus.active,
    refresh,
    reloadFromStart,
    patchEmployee,
  };
};
