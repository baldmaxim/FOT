import { useQuery } from '@tanstack/react-query';
import { productionCalendarService } from '../services/productionCalendarService';
import { settingsService } from '../services/settingsService';

export const getR2StatusQueryKey = () => ['settings', 'r2-status'] as const;
export const getSigurMonitorSettingsQueryKey = () => ['settings', 'sigur-monitor'] as const;
export const getTimesheetReminderSettingsQueryKey = () => ['settings', 'timesheet-reminders'] as const;
export const getEmployeeTransferSettingsQueryKey = () => ['settings', 'employee-transfer'] as const;
export const getDashboardSettingsQueryKey = () => ['settings', 'dashboard'] as const;
export const getProductionCalendarQueryKey = (year: number) => ['production-calendar', year] as const;

export const useR2Status = () => useQuery({
  queryKey: getR2StatusQueryKey(),
  queryFn: () => settingsService.getR2Status(),
  staleTime: 5 * 60_000,
});

export const useSigurMonitorSettings = () => useQuery({
  queryKey: getSigurMonitorSettingsQueryKey(),
  queryFn: () => settingsService.getSigurMonitorSettings(),
  staleTime: 5 * 60_000,
});

export const useTimesheetReminderSettings = () => useQuery({
  queryKey: getTimesheetReminderSettingsQueryKey(),
  queryFn: () => settingsService.getTimesheetReminderSettings(),
  staleTime: 5 * 60_000,
});

export const useEmployeeTransferSettings = () => useQuery({
  queryKey: getEmployeeTransferSettingsQueryKey(),
  queryFn: () => settingsService.getEmployeeTransferSettings(),
  staleTime: 5 * 60_000,
});

export const useDashboardSettings = () => useQuery({
  queryKey: getDashboardSettingsQueryKey(),
  queryFn: () => settingsService.getDashboardSettings(),
  staleTime: 5 * 60_000,
});

export const useProductionCalendar = (year: number) => useQuery({
  queryKey: getProductionCalendarQueryKey(year),
  queryFn: () => productionCalendarService.getByYear(year),
  staleTime: 5 * 60_000,
  placeholderData: previousData => previousData,
});
