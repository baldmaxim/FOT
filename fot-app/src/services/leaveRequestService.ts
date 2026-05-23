import { apiClient } from '../api/client';

export type LeaveRequestType = 'vacation' | 'sick_leave' | 'remote' | 'certificate' | 'time_correction' | 'unpaid' | 'work';
export type LeaveRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface ILeaveRequestAttachment {
  id: number;
  file_name: string;
  mime_type: string | null;
  file_size: number | null;
}

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
  department_name?: string | null;
  position_name?: string | null;
  /** true, если сотрудник пришёл через employee_direct_reports и вне subtree отделов руководителя. */
  is_direct_subordinate?: boolean;
  attachments?: ILeaveRequestAttachment[];
  reviewer?: { id: string; full_name: string | null } | null;
  /**
   * Для time_correction заявок в статусе approved — текущий approval_status
   * связанной attendance_adjustment. 'pending' = ждёт дополнительного
   * согласования администратором на странице /approvals (выходной в whitelist-отделе).
   */
  correction_approval_status?: 'auto_approved' | 'pending' | 'approved' | 'rejected' | null;
}

export const CORRECTION_STATUS_LABELS: Record<string, string> = {
  work: 'Рабочий день',
  vacation: 'Отпуск',
  remote: 'Удалённо',
  unpaid: 'Без сохранения',
  absent: 'Прогул',
  sick: 'Больничный',
  educational_leave: 'Учебный отпуск',
};

export const REQUEST_TYPE_LABELS: Record<string, string> = {
  vacation: 'Отпуск',
  sick_leave: 'Больничный',
  remote: 'Удалёнка',
  certificate: 'Справка',
  time_correction: 'Корректировка табеля',
  unpaid: 'За свой счёт',
  work: 'Работа',
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

  getPendingCount: async (): Promise<{ count: number }> => {
    const res = await apiClient.get<ApiResponse<{ count: number }>>('/leave-requests/pending-count');
    return res.data;
  },
};
