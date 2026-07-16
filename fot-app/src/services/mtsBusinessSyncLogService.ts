import { apiClient } from '../api/client';

// «Лог синхронизации» МТС Бизнес: история прогонов всех фоновых синков и записи
// warn/error/diff по конкретным номерам (карточка на вкладке «Администрирование»).

export type MtsSyncRunStatus = 'running' | 'ok' | 'partial' | 'error' | 'interrupted';
export type MtsSyncLogLevel = 'info' | 'warn' | 'error';

export interface IMtsSyncRun {
  id: string;
  job: string;
  initiator: 'manual' | 'schedule';
  accountId: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: MtsSyncRunStatus;
  summary: string | null;
  stats: Record<string, unknown> | null;
  error: string | null;
}

export interface IMtsSyncLogEntry {
  id: number;
  runId: string | null;
  at: string;
  level: MtsSyncLogLevel;
  job: string;
  step: string | null;
  accountId: string | null;
  msisdn: string | null;
  errorCode: string | null;
  bucket: string | null;
  message: string;
  details: {
    fio?: { old: string; new: string };
    comment?: { old: string; new: string };
    [key: string]: unknown;
  } | null;
}

export interface IMtsSyncRunFilters {
  limit: number;
  offset: number;
  job?: string;
  onlyProblems?: boolean;
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

const qs = (params: Record<string, string | number | boolean | undefined>): string => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
};

export const mtsBusinessSyncLogService = {
  listRuns: async (filters: IMtsSyncRunFilters): Promise<{ runs: IMtsSyncRun[]; total: number }> => {
    const res = await apiClient.get<ApiResponse<{ runs: IMtsSyncRun[]; total: number }>>(
      `/mts-business/sync-log${qs({
        limit: filters.limit,
        offset: filters.offset,
        job: filters.job,
        onlyProblems: filters.onlyProblems ? true : undefined,
      })}`,
    );
    return res.data;
  },

  /** runId='standalone' — ошибки rolling-конвейера вне прогонов. */
  listEntries: async (
    runId: string,
    opts: { limit?: number; offset?: number; level?: string } = {},
  ): Promise<{ entries: IMtsSyncLogEntry[]; total: number }> => {
    const res = await apiClient.get<ApiResponse<{ entries: IMtsSyncLogEntry[]; total: number }>>(
      `/mts-business/sync-log/${runId}/entries${qs({ limit: opts.limit ?? 200, offset: opts.offset ?? 0, level: opts.level })}`,
    );
    return res.data;
  },
};
