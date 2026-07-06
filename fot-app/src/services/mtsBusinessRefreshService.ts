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

export interface IMtsSchedulerStatusRow {
  id: string;
  label: string;
  lastRunAt: string | null;
  lastStatus: 'ok' | 'error' | null;
  lastMessage: string | null;
  lastResult: Record<string, unknown> | null;
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
};
