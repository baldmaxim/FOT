import { apiClient } from '../api/client';

export type TimesheetApprovalStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'returned';
export type TimesheetApprovalEventAction = 'submitted' | 'approved' | 'rejected' | 'returned_to_rework';
export type TimesheetResolvedApprovalStatus = 'submitted' | 'approved' | 'rejected' | 'returned';

export interface ITimesheetApproval {
  id: number;
  department_id: string | null;
  manager_employee_id: number | null;
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
  department_id: string | null;
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
  manager_employee_name: string | null;
  submitted_by_name: string | null;
  reviewed_by_name: string | null;
  /** Родительский «участок» — общий parent отделов всех подач группы. NULL если общий участок не определён. */
  parent_department_id: string | null;
  parent_department_name: string | null;
  /** Ключ группировки в UI: `parent:<id>` для общего участка, `manager:<id>` если у personal-подачи нет общего участка. */
  group_key: string;
  weekend_work_dates: string[];
  pending_weekend_dates: string[];
  approved_weekend_dates: string[];
  large_correction_dates: string[];
  problem_flags: {
    any_correction: boolean;
    correction_exceeds_skud: boolean;
    absent_days: boolean;
  };
}

export type ManagerRoleCode = 'manager' | 'manager_obj' | 'site_supervisor' | (string & {});

export interface ITimesheetDashboardTotals {
  departments_total: number;
  departments_submitted: number;
  departments_approved: number;
  departments_returned: number;
  departments_not_submitted: number;
  managers_personal_total: number;
  managers_personal_submitted: number;
  managers_personal_approved: number;
}

export interface ITimesheetDashboardNotSubmittedDept {
  department_id: string;
  department_name: string;
  parent_path: string;
  responsible_user_id: string | null;
  responsible_name: string | null;
}

export interface ITimesheetDashboardNotSubmittedManager {
  employee_id: number;
  full_name: string;
  department_id: string | null;
  department_path: string;
}

/** Запись карты руководителей: привязка либо отделами, либо назначенными сотрудниками. */
export interface ITimesheetDashboardManager {
  user_id: string;
  full_name: string;
  role_code: ManagerRoleCode;
  /** Отделы в текущем скоупе (если есть привязка к отделам). */
  departments: Array<{ id: string; name: string }>;
  /** Назначенные сотрудники (заполняется, когда отделов нет). */
  assigned_employees: Array<{ id: number; full_name: string }>;
}

/** Отдел, которому никто не назначен ответственным (некому подавать табель). */
export interface ITimesheetDashboardUnassignedDept {
  department_id: string;
  department_name: string;
  parent_path: string;
}

export type DepartmentSubmissionStatus = 'approved' | 'submitted' | 'returned' | 'not_submitted';

/** Статус подачи табеля на отдел — для карты «температуры». */
export interface ITimesheetDashboardDeptStatus {
  department_id: string;
  name: string;
  parent_path: string;
  status: DepartmentSubmissionStatus;
}

/** Отдел полного доступного скоупа — источник для дерева-пикера фильтра. */
export interface ITimesheetDashboardScopeDept {
  department_id: string;
  parent_id: string | null;
  name: string;
  parent_path: string;
  /** false для корневых каталогов (уровень 1–2) — показываются в дереве, но не считаются. */
  countable: boolean;
}

export interface ITimesheetDashboard {
  period: { start_date: string; end_date: string };
  scope_departments: ITimesheetDashboardScopeDept[];
  approvals: {
    totals: ITimesheetDashboardTotals;
    not_submitted_departments: ITimesheetDashboardNotSubmittedDept[];
    not_submitted_managers: ITimesheetDashboardNotSubmittedManager[];
    unassigned_departments: ITimesheetDashboardUnassignedDept[];
    department_status_map: ITimesheetDashboardDeptStatus[];
  };
  managers: {
    list: ITimesheetDashboardManager[];
  };
}

export type TimesheetSubmissionMode = 'department' | 'personal';

interface ISubmissionTarget {
  mode: TimesheetSubmissionMode;
  department_id?: string | null;
}

function buildSubmissionBody(target: ISubmissionTarget, range: { start_date: string; end_date: string }) {
  if (target.mode === 'personal') {
    return { personal: true, start_date: range.start_date, end_date: range.end_date };
  }
  return { department_id: target.department_id ?? null, start_date: range.start_date, end_date: range.end_date };
}

export const timesheetApprovalService = {
  submit: async (target: ISubmissionTarget, start_date: string, end_date: string) => {
    const res = await apiClient.post<ApiResponse<ITimesheetApproval>>(
      '/timesheet-approvals/submit',
      buildSubmissionBody(target, { start_date, end_date }),
    );
    return res.data;
  },

  recall: async (target: ISubmissionTarget, start_date: string, end_date: string) => {
    const res = await apiClient.post<ApiResponse<ITimesheetApproval>>(
      '/timesheet-approvals/recall',
      buildSubmissionBody(target, { start_date, end_date }),
    );
    return res.data;
  },

  getStatus: async (target: ISubmissionTarget, start_date: string, end_date: string) => {
    const params = new URLSearchParams({ start_date, end_date });
    if (target.mode === 'personal') {
      params.set('personal', 'true');
    } else if (target.department_id) {
      params.set('department_id', target.department_id);
    }
    const res = await apiClient.get<ApiResponse<ITimesheetApproval | null>>(`/timesheet-approvals/status?${params.toString()}`);
    return res.data;
  },

  listDepartment: async (department_id: string, month: string) => {
    const params = new URLSearchParams({ department_id, month, scope: 'department' });
    const res = await apiClient.get<ApiResponse<ITimesheetApproval[]>>(`/timesheet-approvals/department?${params.toString()}`);
    return res.data;
  },

  listPersonal: async (month: string) => {
    const params = new URLSearchParams({ month, scope: 'personal' });
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

  listAttachments: async (params: {
    approval_id?: number;
    target?: ISubmissionTarget;
    start_date?: string;
    end_date?: string;
  }) => {
    const qs = new URLSearchParams();
    if (params.approval_id) qs.set('approval_id', String(params.approval_id));
    if (params.target?.mode === 'personal') {
      qs.set('personal', 'true');
    } else if (params.target?.department_id) {
      qs.set('department_id', params.target.department_id);
    }
    if (params.start_date) qs.set('start_date', params.start_date);
    if (params.end_date) qs.set('end_date', params.end_date);
    const res = await apiClient.get<ApiResponse<IApprovalAttachment[]>>(`/timesheet-approvals/attachments?${qs.toString()}`);
    return res.data;
  },

  uploadAttachment: async (params: {
    target: ISubmissionTarget;
    start_date: string;
    end_date: string;
    file: File;
  }): Promise<IApprovalAttachment> => {
    // Серверная multipart-загрузка (как POST /api/documents/upload в Заявлениях):
    // файл идёт в R2 через бэкенд — без браузерного PUT и CORS-проблем.
    const form = new FormData();
    form.append('file', params.file);
    if (params.target.mode === 'personal') {
      form.append('personal', 'true');
    } else if (params.target.department_id) {
      form.append('department_id', params.target.department_id);
    }
    form.append('start_date', params.start_date);
    form.append('end_date', params.end_date);
    const res = await apiClient.post<ApiResponse<IApprovalAttachment>>(
      '/timesheet-approvals/attachments',
      form,
    );
    return res.data;
  },

  deleteAttachment: async (documentId: number) => {
    await apiClient.delete(`/timesheet-approvals/attachments/${documentId}`);
  },

  getAttachmentDownloadUrl: async (documentId: number) => {
    const res = await apiClient.get<ApiResponse<{ download_url: string; file_name: string }>>(
      `/timesheet-approvals/attachments/${documentId}/download`,
    );
    return res.data;
  },

  getReviewList: async (
    status: TimesheetApprovalStatus = 'submitted',
    start_date?: string,
    end_date?: string,
  ) => {
    const qs = new URLSearchParams({ status });
    if (start_date) qs.set('start_date', start_date);
    if (end_date) qs.set('end_date', end_date);
    const res = await apiClient.get<ApiResponse<IApprovalReviewItem[]>>(`/timesheet-approvals/review-list?${qs.toString()}`);
    return res.data;
  },

  getSubmittedEmployees: async (id: number) => {
    const res = await apiClient.get<ApiResponse<{ employees: Array<{ employee_id: number; full_name: string }> }>>(
      `/timesheet-approvals/${id}/employees`,
    );
    return res.data;
  },

  getDashboard: async (start_date: string, end_date: string, departmentIds?: string[]) => {
    const qs = new URLSearchParams({ start_date, end_date });
    // Фильтр отделов: undefined → без фильтра; [] → «снять все» (явно пустой → нулевой дашборд).
    if (departmentIds !== undefined) qs.set('department_ids', departmentIds.join(','));
    const res = await apiClient.get<ApiResponse<ITimesheetDashboard>>(
      `/timesheet-approvals/dashboard?${qs.toString()}`,
    );
    return res.data;
  },
};
