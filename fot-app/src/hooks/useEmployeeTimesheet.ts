import { useQueries, useQuery } from '@tanstack/react-query';
import { timesheetService } from '../services/timesheetService';
import type { TimesheetResponse } from '../types';

const EMPTY_TIMESHEET_RESPONSES: TimesheetResponse[] = [];

export const getEmployeeTimesheetMonthQueryKey = (employeeId: number, monthKey: string) => (
  ['employee-timesheet-summary', employeeId, monthKey] as const
);

export const useEmployeeTimesheetMonth = (
  employeeId: number | null | undefined,
  monthKey: string | null | undefined,
  enabled = true,
) => useQuery({
  queryKey: employeeId && monthKey
    ? getEmployeeTimesheetMonthQueryKey(employeeId, monthKey)
    : ['employee-timesheet-summary', 'disabled'],
  queryFn: () => timesheetService.getAll({ month: monthKey!, employee_id: employeeId! }),
  enabled: Boolean(employeeId && monthKey && enabled),
  staleTime: 30_000,
  placeholderData: previousData => previousData,
});

export const useEmployeeTimesheetMonths = (
  employeeId: number | null | undefined,
  monthKeys: string[],
  enabled = true,
) => {
  const results = useQueries({
    queries: monthKeys.map(monthKey => ({
      queryKey: getEmployeeTimesheetMonthQueryKey(employeeId!, monthKey),
      queryFn: () => timesheetService.getAll({ month: monthKey, employee_id: employeeId! }),
      enabled: Boolean(employeeId && enabled),
      staleTime: 30_000,
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
