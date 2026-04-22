import { apiClient } from '../api/client';

export type TimesheetApprovalStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'returned';
export type TimesheetApprovalEventAction = 'submitted' | 'approved' | 'rejected' | 'returned_to_rework';
export type TimesheetResolvedApprovalStatus = 'submitted' | 'approved' | 'rejected' | 'returned';

export interface ITimesheetApproval {
  id: number;
  department_id: string;
  start_date: string;
  end_date: string;
  status: TimesheetApprovalStatus;
  submitted_by: string | null;
  submitted_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_comment: string | null;
  created_at: string;
  updated_at: string;
}

export interface ITimesheetApprovalEvent {
  id: number;
  approval_id: number;
  department_id: string;
  start_date: string;
  end_date: string;
  action: TimesheetApprovalEventAction;
  from_status: TimesheetApprovalStatus | null;
  to_status: TimesheetResolvedApprovalStatus;
  actor_user_id: string;
  actor_full_name: string | null;
  actor_position_name: string | null;
  comment: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ITimesheetResponsible {
  department_id: string;
  user_id: string;
  role: 'primary' | 'backup';
  is_active: boolean;
  full_name: string | null;
  position_type: string | null;
  employee_id: number | null;
}

export interface ITimesheetResponsibleCandidate {
  user_id: string;
  full_name: string | null;
  position_type: string | null;
  employee_id: number | null;
}

export const APPROVAL_STATUS_LABELS: Record<TimesheetApprovalStatus, string> = {
  draft: 'Черновик',
  submitted: 'На проверке',
  approved: 'Утверждён',
  rejected: 'Отклонён',
  returned: 'На доработке',
};

interface ApiResponse<T> {
  data: T;
  message?: string;
}

export const timesheetApprovalService = {
  submit: async (department_id: string, start_date: string, end_date: string) => {
    const res = await apiClient.post<ApiResponse<ITimesheetApproval>>('/timesheet-approvals/submit', {
      department_id,
      start_date,
      end_date,
    });
    return res.data;
  },

  getStatus: async (department_id: string, start_date: string, end_date: string) => {
    const params = new URLSearchParams({ department_id, start_date, end_date });
    const res = await apiClient.get<ApiResponse<ITimesheetApproval | null>>(`/timesheet-approvals/status?${params.toString()}`);
    return res.data;
  },

  listDepartment: async (department_id: string, month: string) => {
    const params = new URLSearchParams({ department_id, month });
    const res = await apiClient.get<ApiResponse<ITimesheetApproval[]>>(`/timesheet-approvals/department?${params.toString()}`);
    return res.data;
  },

  getResponsibles: async (department_id: string) => {
    const res = await apiClient.get<ApiResponse<ITimesheetResponsible[]>>(`/timesheet-approvals/responsibles?department_id=${encodeURIComponent(department_id)}`);
    return res.data;
  },

  getResponsibleCandidates: async (department_id: string) => {
    const res = await apiClient.get<ApiResponse<ITimesheetResponsibleCandidate[]>>(`/timesheet-approvals/responsibles/candidates?department_id=${encodeURIComponent(department_id)}`);
    return res.data;
  },

  saveResponsibles: async (data: {
    department_id: string;
    primary_user_id: string | null;
    backup_user_id: string | null;
  }) => {
    const res = await apiClient.put<ApiResponse<ITimesheetResponsible[]>>('/timesheet-approvals/responsibles', data);
    return res.data;
  },

  getPending: async () => {
    const res = await apiClient.get<ApiResponse<ITimesheetApproval[]>>('/timesheet-approvals/pending');
    return res.data;
  },

  getByStatus: async (status: string) => {
    const res = await apiClient.get<ApiResponse<ITimesheetApproval[]>>(`/timesheet-approvals/list?status=${encodeURIComponent(status)}`);
    return res.data;
  },

  getHistory: async (id: number) => {
    const res = await apiClient.get<ApiResponse<ITimesheetApprovalEvent[]>>(`/timesheet-approvals/${id}/history`);
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

  returnToRework: async (id: number, comment?: string) => {
    const res = await apiClient.post<ApiResponse<ITimesheetApproval>>(`/timesheet-approvals/${id}/return-to-rework`, { comment });
    return res.data;
  },
};
