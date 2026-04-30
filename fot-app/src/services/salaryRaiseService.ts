import { apiClient } from '../api/client';

export type SalaryRaiseStatus = 'draft' | 'admin_review' | 'approved' | 'rejected' | 'cancelled';

export interface ISalaryRaiseEmployeeSnapshot {
  employee_id: number;
  full_name: string;
  position_name: string | null;
  department_name: string | null;
  work_object: string | null;
  current_salary: number | null;
  hire_date: string | null;
  supervisor_name: string | null;
  last_raise_date: string | null;
}

export interface ISalaryRaiseManagerSnapshot {
  user_id: string;
  employee_id: number | null;
  full_name: string | null;
  position_type: string | null;
  department_name: string | null;
}

export interface ISalaryRaiseRequest {
  id: number;
  employee_id: number;
  author_user_id: string;
  flow_version: number;
  status: SalaryRaiseStatus;
  employee_snapshot: ISalaryRaiseEmployeeSnapshot;
  manager_snapshot: ISalaryRaiseManagerSnapshot | null;
  current_salary_entered: number | null;
  requested_salary: number;
  raise_percentage: number;
  work_object_id: string | null;
  work_object_name: string | null;
  job_summary: string | null;
  achievements: string[];
  manager_justification: string | null;
  admin_review: {
    action: 'approve' | 'reject';
    comment: string | null;
  } | null;
  admin_reviewer_id: string | null;
  admin_reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  employee_name?: string | null;
}

export interface SalaryRaiseCandidate {
  employee_id: number;
  full_name: string;
  position_name: string | null;
  department_name: string | null;
}

export interface SalaryRaiseObjectOption {
  id: string;
  name: string;
}

export interface SalaryRaiseMetricSummary {
  key: string;
  label: string;
  count: number;
  highlight: string | null;
}

export interface SalaryRaiseMetricDetailItem {
  id: string;
  date: string;
  title: string;
  description: string;
}

export interface SalaryRaiseReviewContext {
  period: {
    start_date: string;
    end_date: string;
  };
  summary: SalaryRaiseMetricSummary[];
  details_by_metric: Record<string, SalaryRaiseMetricDetailItem[]>;
}

export interface SalaryRaiseDraftInput {
  employee_id: number;
  current_salary_entered: number;
  requested_salary: number;
  work_object_id: string;
  job_summary: string;
  achievements: string[];
  manager_justification: string;
}

export interface AdminReview {
  action: 'approve' | 'reject';
  comment?: string;
}

export const STATUS_LABELS: Record<SalaryRaiseStatus, string> = {
  draft: 'Черновик',
  admin_review: 'На рассмотрении администратора',
  approved: 'Одобрено',
  rejected: 'Отклонено',
  cancelled: 'Отменено',
};

export const STATUS_COLORS: Record<SalaryRaiseStatus, string> = {
  draft: '#6b7280',
  admin_review: '#f59e0b',
  approved: '#10b981',
  rejected: '#ef4444',
  cancelled: '#9ca3af',
};

interface ApiResponse<T> {
  data: T;
  message?: string;
}

export const salaryRaiseService = {
  create: async (data: SalaryRaiseDraftInput) => {
    const response = await apiClient.post<ApiResponse<ISalaryRaiseRequest>>('/salary-raise', data);
    return response.data;
  },

  update: async (id: number, data: SalaryRaiseDraftInput) => {
    const response = await apiClient.put<ApiResponse<ISalaryRaiseRequest>>(`/salary-raise/${id}`, data);
    return response.data;
  },

  getMy: async () => {
    const response = await apiClient.get<ApiResponse<ISalaryRaiseRequest[]>>('/salary-raise/my');
    return response.data;
  },

  getPending: async () => {
    const response = await apiClient.get<ApiResponse<ISalaryRaiseRequest[]>>('/salary-raise/pending');
    return response.data;
  },

  getAll: async (status?: SalaryRaiseStatus) => {
    const suffix = status ? `?status=${status}` : '';
    const response = await apiClient.get<ApiResponse<ISalaryRaiseRequest[]>>(`/salary-raise${suffix}`);
    return response.data;
  },

  getById: async (id: number) => {
    const response = await apiClient.get<ApiResponse<ISalaryRaiseRequest>>(`/salary-raise/${id}`);
    return response.data;
  },

  submit: async (id: number) => {
    const response = await apiClient.patch<ApiResponse<ISalaryRaiseRequest>>(`/salary-raise/${id}/submit`, {});
    return response.data;
  },

  cancel: async (id: number) => {
    const response = await apiClient.patch<ApiResponse<ISalaryRaiseRequest>>(`/salary-raise/${id}/cancel`, {});
    return response.data;
  },

  getCandidates: async (query: string) => {
    const suffix = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
    const response = await apiClient.get<ApiResponse<SalaryRaiseCandidate[]>>(`/salary-raise/candidates${suffix}`);
    return response.data;
  },

  getObjects: async () => {
    const response = await apiClient.get<ApiResponse<SalaryRaiseObjectOption[]>>('/salary-raise/objects');
    return response.data;
  },

  getReviewContext: async (id: number) => {
    const response = await apiClient.get<ApiResponse<SalaryRaiseReviewContext>>(`/salary-raise/${id}/review-context`);
    return response.data;
  },

  adminReview: async (id: number, review: AdminReview) => {
    const response = await apiClient.patch<ApiResponse<ISalaryRaiseRequest>>(`/salary-raise/${id}/admin-review`, review);
    return response.data;
  },
};
