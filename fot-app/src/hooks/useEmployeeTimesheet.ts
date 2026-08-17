import { useQueries, useQuery } from '@tanstack/react-query';
import { timesheetService } from '../services/timesheetService';
import type { TimesheetResponse } from '../types';

const EMPTY_TIMESHEET_RESPONSES: TimesheetResponse[] = [];

// 'with-objects': запрашиваем табель с детализацией по объектам (include_objects=true),
// чтобы дневной итог совпадал с интерактивным табелем 100% (там include_objects всегда true).
// Маркер в ключе исключает выдачу кэша старого варианта без объектов. Инвалидации по
// префиксу ['employee-timesheet-summary', employeeId] продолжают работать.
export const getEmployeeTimesheetMonthQueryKey = (employeeId: number, monthKey: string) => (
  ['employee-timesheet-summary', employeeId, monthKey, 'with-objects'] as const
);

const getCurrentMonthKey = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

export const useEmployeeTimesheetMonth = (
  employeeId: number | null | undefined,
  monthKey: string | null | undefined,
  enabled = true,
) => {
  // Текущий месяц: сегодняшний день ещё идёт, часы растут с каждым проходом. Глобально
  // (App.tsx) рефетч при монтировании и возврате на вкладку выключен — вкладка, открытая
  // с утра, показывала бы часы на момент загрузки, тогда как блок проходов СКУД
  // перезапрашивается по клику и живёт «сейчас». Для текущего месяца рефетч включаем.
  const isCurrentMonth = monthKey === getCurrentMonthKey();

  return useQuery({
    queryKey: employeeId && monthKey
      ? getEmployeeTimesheetMonthQueryKey(employeeId, monthKey)
      : ['employee-timesheet-summary', 'disabled'],
    queryFn: () => timesheetService.getAll({ month: monthKey!, employee_id: employeeId!, include_objects: true }),
    enabled: Boolean(employeeId && monthKey && enabled),
    staleTime: isCurrentMonth ? 60_000 : 5 * 60_000,
    gcTime: 15 * 60_000,
    refetchOnMount: isCurrentMonth ? 'always' : false,
    refetchOnWindowFocus: isCurrentMonth,
    placeholderData: previousData => previousData,
  });
};

export const useEmployeeTimesheetMonths = (
  employeeId: number | null | undefined,
  monthKeys: string[],
  enabled = true,
) => {
  const results = useQueries({
    queries: monthKeys.map(monthKey => ({
      queryKey: getEmployeeTimesheetMonthQueryKey(employeeId!, monthKey),
      queryFn: () => timesheetService.getAll({ month: monthKey, employee_id: employeeId!, include_objects: true }),
      enabled: Boolean(employeeId && enabled),
      staleTime: 5 * 60_000,
  gcTime: 15 * 60_000,
      placeholderData: (previousData: TimesheetResponse | undefined) => previousData,
    })),
  });

  if (monthKeys.length === 0 || !employeeId || !enabled) {
    return {
      data: EMPTY_TIMESHEET_RESPONSES,
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null as unknown,
      results,
    };
  }

  return {
    data: results.flatMap(result => (result.data ? [result.data] : [])),
    isLoading: results.some(result => result.isLoading),
    isFetching: results.some(result => result.isFetching),
    isError: results.some(result => result.isError),
    error: results.find(result => result.error)?.error ?? null,
    results,
  };
};
