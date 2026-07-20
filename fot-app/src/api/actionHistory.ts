import { apiClient } from './client';

export interface IActionLogEntry {
  id: string;
  user_id: string | null;
  user_name: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
}

export interface IActionLogsResponse {
  success: boolean;
  data: IActionLogEntry[];
  total: number;
  page: number;
  limit: number;
}

export interface IActionLogsParams {
  action?: string;
  user_id?: string;
  q?: string;
  date_from?: string;
  date_to?: string;
  page?: number;
  limit?: number;
}

export const actionHistoryApi = {
  async getLogs(params: IActionLogsParams = {}): Promise<IActionLogsResponse> {
    const query = new URLSearchParams();
    if (params.action) query.set('action', params.action);
    if (params.user_id) query.set('user_id', params.user_id);
    if (params.q) query.set('q', params.q);
    if (params.date_from) query.set('date_from', params.date_from);
    if (params.date_to) query.set('date_to', params.date_to);
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    return apiClient.get<IActionLogsResponse>(`/audit/logs${qs ? `?${qs}` : ''}`);
  },
};
