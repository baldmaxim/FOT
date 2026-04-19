import { apiClient } from '../api/client';

export type OfficialMemoStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface IOfficialMemo {
  id: number;
  employee_id: number;
  title: string;
  body: string;
  status: OfficialMemoStatus;
  reviewer_id: string | null;
  reviewed_at: string | null;
  review_comment: string | null;
  created_at: string;
  updated_at: string;
  employee_name?: string | null;
}

interface ApiResponse<T> {
  data: T;
  message?: string;
}

export const MEMO_STATUS_LABELS: Record<OfficialMemoStatus, string> = {
  pending: 'В ожидании',
  approved: 'Одобрена',
  rejected: 'Отклонена',
  cancelled: 'Отменена',
};

export const officialMemoService = {
  create: async (payload: { title: string; body: string }) => {
    const res = await apiClient.post<ApiResponse<IOfficialMemo>>('/official-memos', payload);
    return res.data;
  },

  listMy: async () => {
    const res = await apiClient.get<ApiResponse<IOfficialMemo[]>>('/official-memos/my');
    return res.data;
  },

  listAll: async (status?: OfficialMemoStatus) => {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    const res = await apiClient.get<ApiResponse<IOfficialMemo[]>>(`/official-memos${qs}`);
    return res.data;
  },

  approve: async (id: number, comment?: string) => {
    const res = await apiClient.patch<ApiResponse<IOfficialMemo>>(`/official-memos/${id}/approve`, { comment });
    return res.data;
  },

  reject: async (id: number, comment?: string) => {
    const res = await apiClient.patch<ApiResponse<IOfficialMemo>>(`/official-memos/${id}/reject`, { comment });
    return res.data;
  },

  cancel: async (id: number) => {
    const res = await apiClient.patch<ApiResponse<IOfficialMemo>>(`/official-memos/${id}/cancel`);
    return res.data;
  },
};
