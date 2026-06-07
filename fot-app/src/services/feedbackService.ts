import { apiClient } from '../api/client';

export type FeedbackKind = 'suggestion' | 'complaint';

interface ApiResponse<T> {
  data: T;
  success?: boolean;
}

export interface IFeedbackMessage {
  id: number;
  content: string;
  created_at: string;
  author: string;
  department_name: string | null;
  is_anonymous: boolean;
}

export interface IDepartmentStat {
  department_id: string | null;
  department_name: string;
  total: number;
  filled: number;
}

export interface IFeedbackTaskRow {
  id: number;
  content: string;
  task_date: string;
  updated_at: string;
  full_name: string | null;
  department_name: string | null;
}

export interface IFeedbackFilters {
  department?: string;
  q?: string;
  from?: string;
  to?: string;
}

const buildQuery = (params: Record<string, string | undefined>): string => {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) usp.set(k, v);
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
};

export const feedbackService = {
  submit: async (payload: { kind: FeedbackKind; content: string; is_anonymous: boolean }): Promise<void> => {
    await apiClient.post('/feedback', payload);
  },

  listMessages: async (kind: FeedbackKind, filters: IFeedbackFilters = {}): Promise<IFeedbackMessage[]> => {
    const res = await apiClient.get<ApiResponse<IFeedbackMessage[]>>(
      `/feedback/messages${buildQuery({ kind, ...filters })}`,
    );
    return res.data;
  },

  listTasks: async (filters: IFeedbackFilters = {}): Promise<{ rows: IFeedbackTaskRow[]; stats: IDepartmentStat[] }> => {
    const res = await apiClient.get<ApiResponse<{ rows: IFeedbackTaskRow[]; stats: IDepartmentStat[] }>>(
      `/feedback/tasks${buildQuery({ ...filters })}`,
    );
    return res.data;
  },
};
