import { useQuery } from '@tanstack/react-query';
import { mtsBusinessSyncLogService, type IMtsSyncRunFilters } from '../services/mtsBusinessSyncLogService';

// «Лог синхронизации» МТС Бизнес: список прогонов + ленивые записи раскрытого
// прогона (enabled только когда прогон развёрнут — не грузим всё сразу).

export const getMtsBusinessSyncLogRunsKey = (filters: IMtsSyncRunFilters) =>
  ['mts-business', 'sync-log', 'runs', filters] as const;

export const useMtsBusinessSyncLogRuns = (filters: IMtsSyncRunFilters, enabled: boolean) => useQuery({
  queryKey: getMtsBusinessSyncLogRunsKey(filters),
  queryFn: () => mtsBusinessSyncLogService.listRuns(filters),
  staleTime: 30_000,
  enabled,
});

export const useMtsBusinessSyncLogEntries = (runId: string | null) => useQuery({
  queryKey: ['mts-business', 'sync-log', 'entries', runId] as const,
  queryFn: () => mtsBusinessSyncLogService.listEntries(runId as string),
  staleTime: 30_000,
  enabled: runId != null,
});
