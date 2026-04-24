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

export interface IApprovalAttachment {
  document_id: number;
  file_name: string;
  file_size: number;
  mime_type: string;
  r2_key: string;
  uploaded_by: string;
  uploaded_by_name: string | null;
  created_at: string;
}

export interface IApprovalReviewItem extends ITimesheetApproval {
  department_name: string | null;
  submitted_by_name: string | null;
  reviewed_by_name: string | null;
  attachments_count: number;
  weekend_work_dates: string[];
  problem_flags: {
    weekend_work_without_attachment: boolean;
    any_correction: boolean;
    correction_exceeds_skud: boolean;
    absent_days: boolean;
  };
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

  listAttachments: async (params: { approval_id?: number; department_id?: string; start_date?: string; end_date?: string }) => {
    const qs = new URLSearchParams();
    if (params.approval_id) qs.set('approval_id', String(params.approval_id));
    if (params.department_id) qs.set('department_id', params.department_id);
    if (params.start_date) qs.set('start_date', params.start_date);
    if (params.end_date) qs.set('end_date', params.end_date);
    const res = await apiClient.get<ApiResponse<IApprovalAttachment[]>>(`/timesheet-approvals/attachments?${qs.toString()}`);
    return res.data;
  },

  uploadAttachment: async (params: {
    department_id: string;
    start_date: string;
    end_date: string;
    file: File;
  }): Promise<IApprovalAttachment> => {
    const { file } = params;
    const urlRes = await apiClient.post<ApiResponse<{
      upload_url: string;
      upload_headers: Record<string, string>;
      r2_key: string;
      approval_id: number;
    }>>('/timesheet-approvals/attachments/upload-url', {
      department_id: params.department_id,
      start_date: params.start_date,
      end_date: params.end_date,
      file_name: file.name,
      content_type: file.type || 'application/octet-stream',
    });
    const uploadResp = await fetch(urlRes.data.upload_url, {
      method: 'PUT',
      body: file,
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        ...urlRes.data.upload_headers,
      },
    });
    if (!uploadResp.ok) throw new Error(`Ошибка загрузки файла (${uploadResp.status})`);
    const confirmRes = await apiClient.post<ApiResponse<IApprovalAttachment>>(
      '/timesheet-approvals/attachments/confirm',
      {
        approval_id: urlRes.data.approval_id,
        r2_key: urlRes.data.r2_key,
        file_name: file.name,
        file_size: file.size,
        mime_type: file.type || 'application/octet-stream',
      },
    );
    return confirmRes.data;
  },

  deleteAttachment: async (documentId: number) => {
    await apiClient.delete(`/timesheet-approvals/attachments/${documentId}`);
  },

  getReviewList: async (status: TimesheetApprovalStatus = 'submitted') => {
    const res = await apiClient.get<ApiResponse<IApprovalReviewItem[]>>(`/timesheet-approvals/review-list?status=${encodeURIComponent(status)}`);
    return res.data;
  },
};
