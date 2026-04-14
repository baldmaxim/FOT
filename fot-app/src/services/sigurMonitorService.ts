import { apiClient } from '../api/client';

interface IPaginatedResponse<T> {
  data: T[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
}

export type SigurHealthCheckFilter = 'all' | 'success' | 'failure' | 'silence';

export interface ISigurHealthCheck {
  id: number;
  checked_at: string;
  source: 'presence_polling' | 'monitor_probe' | 'silence_detector';
  status: 'success' | 'failure' | 'silence';
  connection_type: 'internal' | 'external' | null;
  response_ms: number | null;
  events_last_window: number | null;
  baseline_events: number | null;
  consecutive_failures: number;
  error_message: string | null;
  meta: Record<string, unknown>;
}

export const sigurMonitorService = {
  async getChecks(params?: {
    limit?: number;
    offset?: number;
    status?: SigurHealthCheckFilter;
  }): Promise<IPaginatedResponse<ISigurHealthCheck>> {
    const query = new URLSearchParams();
    if (params?.limit) query.append('limit', String(params.limit));
    if (params?.offset) query.append('offset', String(params.offset));
    if (params?.status) query.append('status', params.status);
    return apiClient.get<IPaginatedResponse<ISigurHealthCheck>>(`/sigur/monitor/checks?${query.toString()}`);
  },
};
