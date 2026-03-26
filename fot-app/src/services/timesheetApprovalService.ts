import { apiClient } from '../api/client';

export type TimesheetApprovalStatus = 'draft' | 'submitted' | 'approved' | 'rejected';

export interface ITimesheetApproval {
  id: number;
  organization_id: string;
  department_id: string;
  period: string;
  status: TimesheetApprovalStatus;
  submitted_by: string | null;
  submitted_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_comment: string | null;
  created_at: string;
  updated_at: string;
}

export const APPROVAL_STATUS_LABELS: Record<TimesheetApprovalStatus, string> = {
  draft: 'Черновик',
  submitted: 'На проверке',
  approved: 'Утверждён',
  rejected: 'Отклонён',
};

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export const timesheetApprovalService = {
  submit: async (department_id: string, period: string) => {
    const res = await apiClient.post<ApiResponse<ITimesheetApproval>>('/timesheet-approvals/submit', { department_id, period });
    return res.data;
  },

  getStatus: async (department_id: string, period: string) => {
    const res = await apiClient.get<ApiResponse<ITimesheetApproval | null>>(`/timesheet-approvals/status?department_id=${department_id}&period=${period}`);
    return res.data;
  },

  getPending: async () => {
    const res = await apiClient.get<ApiResponse<ITimesheetApproval[]>>('/timesheet-approvals/pending');
    return res.data;
  },

  approve: async (id: number, comment?: string) => {
    const res = await apiClient.post<ApiResponse<ITimesheetApproval>>(`/timesheet-approvals/${id}/approve`, { comment });
    return res.data;
  },

  reject: async (id: number, comment?: string) => {
    const res = await apiClient.post<ApiResponse<ITimesheetApproval>>(`/timesheet-approvals/${id}/reject`, { comment });
    return res.data;
  },
};
