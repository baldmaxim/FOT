import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { employeeService, type StaffApiStatus, type StaffPeriod } from '../services/employeeService';

export const STAFF_CATEGORY_COUNTS_QUERY_KEY = ['employees', 'category-counts'] as const;

interface IUseStaffCategoryCountsParams {
  section: string;
  departmentId: string;
  search: string;
  scheduleId: string;
  status: StaffApiStatus;
  period: StaffPeriod | null;
  /** Сериализованные фильтры столбцов ('' — нет). */
  cf: string;
  enabled: boolean;
}

/** Ключ фильтров разбивки — тот же набор, что у таблицы: по нему плашка сверяет, что числа про текущий список. */
export const staffCategoryFiltersKey = (params: Omit<IUseStaffCategoryCountsParams, 'enabled'>): string =>
  JSON.stringify([
    params.section,
    params.departmentId || null,
    params.search || '',
    params.scheduleId || null,
    params.status,
    params.period ?? null,
    params.cf || '',
  ]);

/**
 * ИТР / Рабочие / Остальные таблицы «Текущие сотрудники» (плашка в шапке). Те же фильтры, статус и период, что у
 * списка. Префикс ['employees'] — обновляется вместе со списком после приёма, увольнения, перевода в неактивные.
 * Ответ несёт filtersKey запроса: прежние данные (keepPreviousData) не выдаются за числа нового набора.
 */
export const useStaffCategoryCounts = ({ enabled, ...params }: IUseStaffCategoryCountsParams) => {
  const filtersKey = staffCategoryFiltersKey(params);
  return useQuery({
    queryKey: [...STAFF_CATEGORY_COUNTS_QUERY_KEY, filtersKey],
    queryFn: async ({ signal }) => ({
      filtersKey,
      counts: await employeeService.getCategoryCounts({
        section: params.section,
        departmentId: params.departmentId || undefined,
        search: params.search || undefined,
        scheduleId: params.scheduleId || undefined,
        status: params.status,
        period: params.period ?? undefined,
        cf: params.cf || undefined,
      }, signal),
    }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    enabled,
  });
};
