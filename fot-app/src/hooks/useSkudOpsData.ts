import { useQuery } from '@tanstack/react-query';
import { sigurMonitorService } from '../services/sigurMonitorService';
import { skudService } from '../services/skudService';

export const getSkudMonitorDashboardQueryKey = (
  incidentFilter: 'all' | 'open' | 'resolved',
  checkFilter: 'all' | 'success' | 'failure' | 'silence',
) => ['skud-monitor', 'dashboard', incidentFilter, checkFilter] as const;

export const getSkudMonitorIncidentQueryKey = (incidentId: number | null) => ['skud-monitor', 'incident', incidentId] as const;
export const getSkudSupabaseEventsQueryKey = (startDate: string, endDate: string, searchQuery: string) => ['skud-supabase', 'events', startDate, endDate, searchQuery] as const;
export const getSkudSupabaseSummaryQueryKey = (startDate: string) => ['skud-supabase', 'summary', startDate] as const;

export const useSkudMonitorDashboard = (
  incidentFilter: 'all' | 'open' | 'resolved',
  checkFilter: 'all' | 'success' | 'failure' | 'silence',
) => useQuery({
  queryKey: getSkudMonitorDashboardQueryKey(incidentFilter, checkFilter),
  queryFn: async () => {
    const [status, incidents, checks] = await Promise.all([
      sigurMonitorService.getStatus(),
      sigurMonitorService.getIncidents({ limit: 20, status: incidentFilter }),
      sigurMonitorService.getChecks({ limit: 30, status: checkFilter }),
    ]);
    return { status, incidents, checks };
  },
  staleTime: 30_000,
  placeholderData: previousData => previousData,
});

export const useSkudMonitorIncident = (incidentId: number | null) => useQuery({
  queryKey: getSkudMonitorIncidentQueryKey(incidentId),
  queryFn: () => sigurMonitorService.getIncident(incidentId as number),
  enabled: !!incidentId,
  staleTime: 30_000,
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
