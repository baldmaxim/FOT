import { apiClient } from '../api/client';

export type HiringStage = 'new' | 'in_progress' | 'interview' | 'offer' | 'closed' | 'cancelled' | 'rework';
export type CandidateStatus = 'new' | 'screening' | 'interview' | 'offer' | 'accepted' | 'reserve' | 'reject';
export type CandidateVerdict = 'invite' | 'reject';
export type Gender = 'any' | 'male' | 'female';

export interface IHiringAssignee {
  employee_id: number;
  full_name: string | null;
  is_primary: boolean;
}

export interface IHiringRequest {
  id: number;
  author_user_id: string;
  author_employee_id: number | null;
  department_id: string | null;
  stage: HiringStage;
  is_urgent: boolean;
  rework_reason: string | null;
  start_work_date: string | null;
  deadline: string | null;
  customer_name: string | null;
  headcount: number;
  position_title: string;
  duties: string | null;
  experience: string | null;
  requirements: string | null;
  software: string | null;
  gender: Gender | null;
  salary_level: string | null;
  hh_vacancy_url: string | null;
  created_at: string;
  reactivated_at: string | null;
  applicant_finalized_at: string | null;
  closed_at: string | null;
  days_in_work: number;
  candidate_count: number;
  approved_count: number;
  assignees: IHiringAssignee[];
}

export interface IHiringCandidate {
  id: number;
  request_id: number;
  full_name: string;
  hh_resume_url: string | null;
  phone: string | null;
  salary_expectation: string | null;
  status: CandidateStatus;
  interview_at: string | null;
  seeker_feedback: string | null;
  applicant_feedback: string | null;
  applicant_approved: boolean;
  applicant_verdict: CandidateVerdict | null;
  verdict_at: string | null;
}

export interface IHiringFile {
  id: number;
  file_name: string;
  file_size: number | null;
  mime_type: string | null;
  candidate_id: number | null;
  created_at: string;
}

export interface IHiringEvent {
  id: number;
  kind: string;
  body: string | null;
  link_url: string | null;
  from_stage: string | null;
  to_stage: string | null;
  created_at: string;
  author_name: string | null;
}

export interface IHiringRequestDetail extends IHiringRequest {
  candidates: IHiringCandidate[];
  files: IHiringFile[];
  events: IHiringEvent[];
  can_manage: boolean;
}

export interface IHiringCaps { can_manage: boolean; is_recruiter: boolean; can_create: boolean }

export interface IRecruiter {
  employee_id: number;
  full_name: string | null;
  position_name: string | null;
  department_name: string | null;
}

export interface IHiringAnalyticsRow {
  employee_id: number;
  full_name: string | null;
  total: number;
  closed: number;
  avg_headcount: number | null;
  interviews: number;
  avg_close_days: number | null;
  closed_in_time: number;
  closed_with_deadline: number;
  overdue: number;
}

interface ListResponse { data: IHiringRequest[]; meta: IHiringCaps }

export const hiringRequestService = {
  list: async (): Promise<ListResponse> => {
    const res = await apiClient.get<ListResponse>('/hiring-requests');
    return { data: res.data ?? [], meta: res.meta ?? { can_manage: false, is_recruiter: false, can_create: false } };
  },
  getById: async (id: number) => {
    const res = await apiClient.get<{ data: IHiringRequestDetail }>(`/hiring-requests/${id}`);
    return res.data;
  },
  create: async (body: Partial<IHiringRequest>) => {
    const res = await apiClient.post<{ data: { id: number } }>('/hiring-requests', body);
    return res.data;
  },
  update: async (id: number, body: Partial<IHiringRequest>) =>
    apiClient.patch(`/hiring-requests/${id}`, body),
  changeStage: async (id: number, stage: HiringStage) =>
    apiClient.patch(`/hiring-requests/${id}/stage`, { stage }),
  reject: async (id: number, reason: string) =>
    apiClient.post(`/hiring-requests/${id}/reject`, { reason }),
  resubmit: async (id: number) => apiClient.post(`/hiring-requests/${id}/resubmit`, {}),
  setUrgent: async (id: number, urgent: boolean) =>
    apiClient.patch(`/hiring-requests/${id}/urgent`, { urgent }),
  finalize: async (id: number, confirmPartial = false) =>
    apiClient.post(`/hiring-requests/${id}/finalize-selection`, { confirm_partial: confirmPartial }),
  unfinalize: async (id: number) => apiClient.post(`/hiring-requests/${id}/unfinalize`, {}),

  // ответственные
  addAssignee: async (id: number, employeeId: number, isPrimary = false) =>
    apiClient.post(`/hiring-requests/${id}/assignees`, { employee_id: employeeId, is_primary: isPrimary }),
  setPrimary: async (id: number, employeeId: number) =>
    apiClient.patch(`/hiring-requests/${id}/assignees/${employeeId}/primary`, {}),
  removeAssignee: async (id: number, employeeId: number) =>
    apiClient.delete(`/hiring-requests/${id}/assignees/${employeeId}`),

  // пул рекрутеров
  listRecruiters: async (): Promise<IRecruiter[]> => {
    const res = await apiClient.get<{ data: IRecruiter[] }>('/hiring-requests/recruiters');
    return res.data ?? [];
  },
  addRecruiter: async (employeeId: number) =>
    apiClient.post('/hiring-requests/recruiters', { employee_id: employeeId }),
  removeRecruiter: async (employeeId: number) => {
    const res = await apiClient.delete<{ data: { active_requests: { id: number; position_title: string }[] } }>(`/hiring-requests/recruiters/${employeeId}`);
    return res.data;
  },

  // кандидаты
  addCandidate: async (id: number, body: Partial<IHiringCandidate>) =>
    apiClient.post(`/hiring-requests/${id}/candidates`, body),
  updateCandidate: async (id: number, cid: number, body: Partial<IHiringCandidate>) =>
    apiClient.patch(`/hiring-requests/${id}/candidates/${cid}`, body),
  approveCandidate: async (id: number, cid: number, approved: boolean) =>
    apiClient.patch(`/hiring-requests/${id}/candidates/${cid}/approve`, { approved }),
  setCandidateVerdict: async (id: number, cid: number, verdict: CandidateVerdict, comment?: string) =>
    apiClient.patch(`/hiring-requests/${id}/candidates/${cid}/verdict`, { verdict, comment }),
  deleteCandidate: async (id: number, cid: number) =>
    apiClient.delete(`/hiring-requests/${id}/candidates/${cid}`),

  // комментарии/ссылки/файлы
  addComment: async (id: number, body: string) =>
    apiClient.post(`/hiring-requests/${id}/comment`, { body }),
  addLink: async (id: number, linkUrl: string, body?: string) =>
    apiClient.post(`/hiring-requests/${id}/link`, { link_url: linkUrl, body }),
  uploadFile: async (id: number, file: File, candidateId?: number) => {
    const form = new FormData();
    form.append('file', file);
    if (candidateId) form.append('candidate_id', String(candidateId));
    return apiClient.post(`/hiring-requests/${id}/files`, form);
  },
  getFileDownloadUrl: async (id: number, fileId: number, disposition: 'inline' | 'attachment' = 'attachment') => {
    const res = await apiClient.get<{ data: { url: string } }>(`/hiring-requests/${id}/files/${fileId}/download?disposition=${disposition}`);
    return res.data.url;
  },
  deleteFile: async (id: number, fileId: number) =>
    apiClient.delete(`/hiring-requests/${id}/files/${fileId}`),

  // аналитика
  analytics: async (period: 'week' | 'month'): Promise<IHiringAnalyticsRow[]> => {
    const res = await apiClient.get<{ data: IHiringAnalyticsRow[] }>(`/hiring-requests/analytics?period=${period}`);
    return res.data ?? [];
  },
};

// этапы (порядок воронки) и метаданные
export const HIRING_STAGES: { key: HiringStage; label: string; color: string; idx: number }[] = [
  { key: 'new', label: 'Новая', color: 'var(--primary)', idx: 1 },
  { key: 'in_progress', label: 'В работе', color: 'var(--sky, #0ea5e9)', idx: 2 },
  { key: 'interview', label: 'Собеседования', color: 'var(--purple)', idx: 3 },
  { key: 'offer', label: 'Оффер', color: 'var(--warning)', idx: 4 },
  { key: 'closed', label: 'Закрыта', color: 'var(--success)', idx: 5 },
];
export const FUNNEL_KEYS: HiringStage[] = ['new', 'in_progress', 'interview', 'offer', 'closed'];

export const CANDIDATE_STATUS_META: Record<CandidateStatus, { label: string; color: string }> = {
  new: { label: 'Новый', color: 'var(--text-tertiary)' },
  screening: { label: 'На связи', color: 'var(--primary)' },
  interview: { label: 'Интервью', color: 'var(--purple)' },
  offer: { label: 'Оффер', color: 'var(--warning)' },
  accepted: { label: 'Принят', color: 'var(--success)' },
  reserve: { label: 'Резерв', color: 'var(--sky, #0ea5e9)' },
  reject: { label: 'Отказ', color: 'var(--error)' },
};

export function stageMeta(stage: HiringStage) {
  if (stage === 'rework') return { label: 'На доработке', color: 'var(--error)', idx: 0 };
  if (stage === 'cancelled') return { label: 'Отменена', color: 'var(--text-tertiary)', idx: 0 };
  return HIRING_STAGES.find(s => s.key === stage) ?? HIRING_STAGES[0];
}
