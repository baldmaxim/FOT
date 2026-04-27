import { apiClient } from '../api/client';

export type LeaveRequestType = 'vacation' | 'sick_leave' | 'remote' | 'dayoff' | 'certificate' | 'time_correction';
export type LeaveRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface ILeaveRequest {
  id: number;
  employee_id: number;
  request_type: LeaveRequestType;
  status: LeaveRequestStatus;
  start_date: string;
  end_date: string;
  reason: string | null;
  reviewer_id: string | null;
  reviewed_at: string | null;
  review_comment: string | null;
  correction_date: string | null;
  correction_status: string | null;
  correction_hours: number | null;
  created_at: string;
  updated_at: string;
  employee_name?: string | null;
  reviewer?: { id: string; full_name: string | null } | null;
}

export const REQUEST_TYPE_LABELS: Record<string, string> = {
  vacation: 'Отпуск',
  sick_leave: 'Больничный',
  remote: 'Удалёнка',
  dayoff: 'Отгул',
  business_trip: 'Командировка',
  certificate: 'Справка',
  time_correction: 'Корректировка табеля',
};

export const STATUS_LABELS: Record<LeaveRequestStatus, string> = {
  pending: 'На рассмотрении',
  approved: 'Одобрено',
  rejected: 'Отклонено',
  cancelled: 'Отменено',
};

interface ApiResponse<T> {
  data: T;
  message?: string;
}

export const leaveRequestService = {
  create: async (data: {
    request_type: LeaveRequestType;
    start_date: string;
    end_date: string;
    reason?: string;
    correction_date?: string;
    correction_status?: string;
    correction_hours?: number;
    attachments?: number[];
  }) => {
    const res = await apiClient.post<ApiResponse<ILeaveRequest>>('/leave-requests', data);
    return res.data;
  },

  getMy: async () => {
    const res = await apiClient.get<ApiResponse<ILeaveRequest[]>>('/leave-requests/my');
    return res.data;
  },

  getById: async (id: number) => {
    const res = await apiClient.get<ApiResponse<ILeaveRequest>>(`/leave-requests/${id}`);
    return res.data;
  },

  getDepartment: async () => {
    const res = await apiClient.get<ApiResponse<ILeaveRequest[]>>('/leave-requests/department');
    return res.data;
  },

  getAll: async (status?: LeaveRequestStatus) => {
    const params = status ? `?status=${status}` : '';
    const res = await apiClient.get<ApiResponse<ILeaveRequest[]>>(`/leave-requests${params}`);
    return res.data;
  },

  approve: async (id: number, comment?: string) => {
    const res = await apiClient.patch<ApiResponse<ILeaveRequest>>(`/leave-requests/${id}/approve`, { comment });
    return res.data;
  },

  reject: async (id: number, comment?: string) => {
    const res = await apiClient.patch<ApiResponse<ILeaveRequest>>(`/leave-requests/${id}/reject`, { comment });
    return res.data;
  },

  cancel: async (id: number) => {
    const res = await apiClient.patch<ApiResponse<ILeaveRequest>>(`/leave-requests/${id}/cancel`, {});
    return res.data;
  },
};
