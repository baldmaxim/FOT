import { useQuery } from '@tanstack/react-query';
import { sigurMonitorService, type SigurHealthCheckFilter } from '../services/sigurMonitorService';
import { skudService } from '../services/skudService';

export const getSkudMonitorLogsQueryKey = (checkFilter: SigurHealthCheckFilter) => ['skud-monitor', 'logs', checkFilter] as const;
export const getSkudSupabaseEventsQueryKey = (startDate: string, endDate: string, searchQuery: string) => ['skud-supabase', 'events', startDate, endDate, searchQuery] as const;
export const getSkudSupabaseSummaryQueryKey = (startDate: string) => ['skud-supabase', 'summary', startDate] as const;

export const useSkudMonitorLogs = (checkFilter: SigurHealthCheckFilter) => useQuery({
  queryKey: getSkudMonitorLogsQueryKey(checkFilter),
  queryFn: () => sigurMonitorService.getChecks({ limit: 20, status: checkFilter }),
  staleTime: 30_000,
  placeholderData: previousData => previousData,
});

export const useSkudSupabaseEvents = (
  startDate: string,
  endDate: string,
  searchQuery: string,
  enabled: boolean,
) => useQuery({
  queryKey: getSkudSupabaseEventsQueryKey(startDate, endDate, searchQuery),
  queryFn: ({ signal }) => skudService.getEvents({
    startDate,
    endDate,
    search: searchQuery || undefined,
  }, signal),
  enabled,
  placeholderData: previousData => previousData,
});

export const useSkudSupabaseSummary = (startDate: string, enabled: boolean) => useQuery({
  queryKey: getSkudSupabaseSummaryQueryKey(startDate),
  queryFn: ({ signal }) => skudService.getDailySummary(startDate, signal),
  enabled,
  placeholderData: previousData => previousData,
});
