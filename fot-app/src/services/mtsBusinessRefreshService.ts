import { apiClient } from '../api/client';

// «Обновить всё» — запуск/статус фонового полного обновления модуля МТС Бизнес
// (номера, ФИО, комментарии, балансы, детализация, тарифы/услуги) + статусы
// фоновых планировщиков для вкладки «Администрирование».

export type MtsRefreshStepStatus = 'pending' | 'running' | 'ok' | 'unavailable' | 'error';

export interface IMtsRefreshStep {
  accountId: string;
  accountLabel: string;
  step: string;
  label: string;
  status: MtsRefreshStepStatus;
  count: number | null;
  message: string | null;
}

export interface IMtsRefreshAllStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  window: { dateFrom: string; dateTo: string } | null;
  steps: IMtsRefreshStep[];
  error: string | null;
}

export interface IMtsRefreshAllSchedule {
  enabled: boolean;
  hourMsk: number;
}

export interface IMtsSchedulerStatusRow {
  id: string;
  label: string;
  lastRunAt: string | null;
  /** 'partial' — прогон завершился, но часть номеров/секций с ошибкой. */
  lastStatus: 'ok' | 'partial' | 'error' | null;
  lastMessage: string | null;
  lastResult: Record<string, unknown> | null;
}

/** Настройки непрерывного конвейера свежести (звонки/начисления). */
export interface IMtsRollingSettings {
  enabled: boolean;
  /** Доля лимита запросов МТС под фоновое обновление, % (10–90). */
  budgetSharePercent: number;
  /** Как часто обновлять активные номера (мин). */
  hotMinutes: number;
  /** Как часто обновлять неактивные номера (ч). */
  coldHours: number;
}

export interface IMtsRollingAccountStat {
  accountId: string;
  accountLabel: string;
  pending: number;
  synced: number;
  failed: number;
  noAccess: number;
  unavailable: number;
  transient: number;
}

export interface IMtsRollingStatus {
  enabled: boolean;
  running: boolean;
  dryRun: boolean;
  settings: IMtsRollingSettings | null;
  lastTickAt: string | null;
  syncedLastHour: number;
  accounts: IMtsRollingAccountStat[];
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export const mtsBusinessRefreshService = {
  startRefreshAll: async (input: { accountId?: string; dateFrom?: string; dateTo?: string } = {}): Promise<{ started: boolean }> => {
    const res = await apiClient.post<ApiResponse<{ started: boolean }>>('/mts-business/refresh-all', { ...input, confirmed: true });
    return res.data;
  },

  getStatus: async (): Promise<IMtsRefreshAllStatus> => {
    const res = await apiClient.get<ApiResponse<IMtsRefreshAllStatus>>('/mts-business/refresh-all/status');
    return res.data;
  },

  getSchedulersStatus: async (): Promise<IMtsSchedulerStatusRow[]> => {
    const res = await apiClient.get<ApiResponse<IMtsSchedulerStatusRow[]>>('/mts-business/schedulers/status');
    return res.data;
  },

  getSchedule: async (): Promise<IMtsRefreshAllSchedule> => {
    const res = await apiClient.get<ApiResponse<IMtsRefreshAllSchedule>>('/mts-business/refresh-all/schedule');
    return res.data;
  },

  setSchedule: async (input: IMtsRefreshAllSchedule): Promise<IMtsRefreshAllSchedule> => {
    const res = await apiClient.put<ApiResponse<IMtsRefreshAllSchedule>>('/mts-business/refresh-all/schedule', input);
    return res.data;
  },

  getRolling: async (): Promise<IMtsRollingStatus> => {
    const res = await apiClient.get<ApiResponse<IMtsRollingStatus>>('/mts-business/rolling');
    return res.data;
  },

  setRolling: async (input: Partial<IMtsRollingSettings> & { enabled: boolean }): Promise<IMtsRollingSettings> => {
    const res = await apiClient.put<ApiResponse<IMtsRollingSettings>>('/mts-business/rolling', input);
    return res.data;
  },
};
