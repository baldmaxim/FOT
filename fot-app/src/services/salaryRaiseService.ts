import { apiClient } from '../api/client';

export type SalaryRaiseStatus = 'draft' | 'supervisor_review' | 'hr_review' | 'finance_review' | 'approved' | 'rejected' | 'cancelled';
export type SalaryRaiseRequestType = 'performance' | 'market_adjustment' | 'promotion' | 'new_responsibilities' | 'retention' | 'other';

export interface ISalaryRaiseRequest {
  id: number;
  employee_id: number;
  author_user_id: string;
  status: SalaryRaiseStatus;
  employee_snapshot: {
    full_name: string;
    position_name: string | null;
    department_name: string | null;
    work_object: string | null;
    current_salary: number | null;
    salary_actual: number | null;
    hire_date: string | null;
    supervisor_name: string | null;
    last_raise_date: string | null;
  };
  request_type: SalaryRaiseRequestType;
  requested_salary: number;
  raise_percentage: number;
  desired_effective_date: string;
  reason_brief: string;
  achievements: IAchievement[];
  responsibility_changes: IResponsibilityChanges;
  self_assessment: ISelfAssessment;
  supervisor_review: ISupervisorReview | null;
  supervisor_reviewer_id: string | null;
  supervisor_reviewed_at: string | null;
  hr_review: IHrReview | null;
  hr_reviewer_id: string | null;
  hr_reviewed_at: string | null;
  finance_review: IFinanceReview | null;
  finance_reviewer_id: string | null;
  finance_reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  employee_name?: string | null;
  attachments?: ISalaryRaiseAttachment[];
}

export interface IAchievement {
  period: string;
  task: string;
  description: string;
  result: string;
  effect: string;
}

export interface IResponsibilityChanges {
  new_functions: boolean;
  new_functions_desc: string;
  team_growth: boolean;
  team_growth_desc: string;
  complexity_increase: boolean;
  complexity_increase_desc: string;
  cross_functional: boolean;
  cross_functional_desc: string;
}

export interface ISelfAssessment {
  strengths: string;
  development_areas: string;
  career_goals: string;
}

export interface ISupervisorReview {
  support: boolean;
  recommended_salary: number;
  argumentation: string;
  employee_year_rating: string;
  reliability_rating: string;
  loss_risk: string;
  replaceable: boolean;
  confirmed_new_duties: boolean;
  impact_deadlines: string;
  impact_quality: string;
  impact_safety: string;
  impact_contractors: string;
  systemic_issues: boolean;
  recommendation: string;
}

export interface IHrReview {
  rules_compliance: boolean;
  previous_review_date: string;
  grade_compliance: boolean;
  salary_range_position: string;
  comparison_with_peers: string;
  hr_restrictions: string;
  market_assessment: string;
  hr_recommendation: string;
}

export interface IFinanceReview {
  current_budget: number;
  monthly_fot_load: number;
  yearly_fot_load: number;
  coverage_source_exists: boolean;
  fits_department_limit: boolean;
  recommendation: string;
}

export interface ISalaryRaiseAttachment {
  id: number;
  salary_raise_id: number;
  achievement_index: number | null;
  file_name: string;
  file_size: number;
  mime_type: string;
  r2_key: string;
  uploaded_by: string;
  created_at: string;
}

export const REQUEST_TYPE_LABELS: Record<SalaryRaiseRequestType, string> = {
  performance: 'По результатам работы',
  market_adjustment: 'Рыночная корректировка',
  promotion: 'Повышение в должности',
  new_responsibilities: 'Новые обязанности',
  retention: 'Удержание сотрудника',
  other: 'Другое',
};

export const STATUS_LABELS: Record<SalaryRaiseStatus, string> = {
  draft: 'Черновик',
  supervisor_review: 'На рассмотрении руководителя',
  hr_review: 'На рассмотрении HR',
  finance_review: 'Финансовое согласование',
  approved: 'Одобрено',
  rejected: 'Отклонено',
  cancelled: 'Отменено',
};

export const STATUS_COLORS: Record<SalaryRaiseStatus, string> = {
  draft: '#6b7280',
  supervisor_review: '#f59e0b',
  hr_review: '#3b82f6',
  finance_review: '#8b5cf6',
  approved: '#10b981',
  rejected: '#ef4444',
  cancelled: '#9ca3af',
};

export const RATING_OPTIONS = ['низкий', 'средний', 'высокий'] as const;
export const IMPACT_OPTIONS = ['незначительное', 'умеренное', 'значительное'] as const;
export const RECOMMENDATION_OPTIONS = [
  { value: 'support', label: 'Поддержать' },
  { value: 'partial', label: 'Частично поддержать' },
  { value: 'reject', label: 'Не поддержать' },
] as const;

interface ApiResponse<T> {
  data: T;
  message?: string;
}

export const salaryRaiseService = {
  create: async (data: {
    request_type: SalaryRaiseRequestType;
    requested_salary: number;
    raise_percentage: number;
    desired_effective_date: string;
    reason_brief: string;
    achievements?: IAchievement[];
    responsibility_changes?: IResponsibilityChanges;
    self_assessment?: ISelfAssessment;
  }) => {
    const res = await apiClient.post<ApiResponse<ISalaryRaiseRequest>>('/salary-raise', data);
    return res.data;
  },

  update: async (id: number, data: Partial<{
    request_type: SalaryRaiseRequestType;
    requested_salary: number;
    raise_percentage: number;
    desired_effective_date: string;
    reason_brief: string;
    achievements: IAchievement[];
    responsibility_changes: IResponsibilityChanges;
    self_assessment: ISelfAssessment;
  }>) => {
    const res = await apiClient.put<ApiResponse<ISalaryRaiseRequest>>(`/salary-raise/${id}`, data);
    return res.data;
  },

  getMy: async () => {
    const res = await apiClient.get<ApiResponse<ISalaryRaiseRequest[]>>('/salary-raise/my');
    return res.data;
  },

  getPending: async () => {
    const res = await apiClient.get<ApiResponse<ISalaryRaiseRequest[]>>('/salary-raise/pending');
    return res.data;
  },

  getAll: async (status?: SalaryRaiseStatus) => {
    const params = status ? `?status=${status}` : '';
    const res = await apiClient.get<ApiResponse<ISalaryRaiseRequest[]>>(`/salary-raise${params}`);
    return res.data;
  },

  getById: async (id: number) => {
    const res = await apiClient.get<ApiResponse<ISalaryRaiseRequest>>(`/salary-raise/${id}`);
    return res.data;
  },

  submit: async (id: number) => {
    const res = await apiClient.patch<ApiResponse<ISalaryRaiseRequest>>(`/salary-raise/${id}/submit`, {});
    return res.data;
  },

  cancel: async (id: number) => {
    const res = await apiClient.patch<ApiResponse<ISalaryRaiseRequest>>(`/salary-raise/${id}/cancel`, {});
    return res.data;
  },

  supervisorReview: async (id: number, action: 'approve' | 'reject', review: ISupervisorReview) => {
    const res = await apiClient.patch<ApiResponse<ISalaryRaiseRequest>>(`/salary-raise/${id}/supervisor-review`, { action, review });
    return res.data;
  },

  hrReview: async (id: number, action: 'approve' | 'reject', review: IHrReview) => {
    const res = await apiClient.patch<ApiResponse<ISalaryRaiseRequest>>(`/salary-raise/${id}/hr-review`, { action, review });
    return res.data;
  },

  financeReview: async (id: number, action: 'approve' | 'reject', review: IFinanceReview) => {
    const res = await apiClient.patch<ApiResponse<ISalaryRaiseRequest>>(`/salary-raise/${id}/finance-review`, { action, review });
    return res.data;
  },

  getUploadUrl: async (id: number, fileName: string, contentType: string, achievementIndex?: number) => {
    const res = await apiClient.post<ApiResponse<{ upload_url: string; r2_key: string }>>(`/salary-raise/${id}/upload-url`, {
      file_name: fileName,
      content_type: contentType,
      achievement_index: achievementIndex,
    });
    return res.data;
  },

  confirmAttachment: async (id: number, data: {
    r2_key: string;
    file_name: string;
    file_size: number;
    mime_type: string;
    achievement_index?: number;
  }) => {
    const res = await apiClient.post<ApiResponse<ISalaryRaiseAttachment>>(`/salary-raise/${id}/attachments`, data);
    return res.data;
  },

  getAttachments: async (id: number) => {
    const res = await apiClient.get<ApiResponse<ISalaryRaiseAttachment[]>>(`/salary-raise/${id}/attachments`);
    return res.data;
  },

  deleteAttachment: async (requestId: number, attachmentId: number) => {
    await apiClient.delete(`/salary-raise/${requestId}/attachments/${attachmentId}`);
  },
};
