import { apiClient } from '../api/client';

export type LeaveRequestType = 'vacation' | 'sick_leave' | 'remote' | 'certificate' | 'time_correction' | 'unpaid' | 'work' | 'educational_leave' | 'sick_worked' | 'dismissal';
export type LeaveRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export type LeaveRequestCancelSource = 'employee' | 'manager' | 'admin';

/** Типы «отпусков»: причина отмены обязательна, отмена согласованного доступна руководителю. */
export const VACATION_REQUEST_TYPES: LeaveRequestType[] = ['vacation', 'unpaid', 'educational_leave'];
export const isVacationRequestType = (type: LeaveRequestType): boolean =>
  VACATION_REQUEST_TYPES.includes(type);

/** Лимит причины отмены — тот же, что на бэкенде (leave-requests.controller.ts). */
export const CANCEL_REASON_MAX_LENGTH = 500;

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
  /** numeric в БД → бэкенд отдаёт строкой ("10.00"); число приходит только из оптимистичных правок. */
  correction_hours: number | string | null;
  /** Объект (skud_objects.id), к которому привязана корректировка табеля. NULL для не-корректировок. */
  correction_object_id?: string | null;
  correction_object_name?: string | null;
  /** Дискретно выбранные дни (work/remote/certificate/unpaid). NULL для непрерывных периодов. */
  selected_dates: string[] | null;
  created_at: string;
  updated_at: string;
  employee_name?: string | null;
  department_name?: string | null;
  position_name?: string | null;
  /** true, если сотрудник пришёл через employee_direct_reports и вне subtree отделов руководителя. */
  is_direct_subordinate?: boolean;
  attachments?: ILeaveRequestAttachment[];
  reviewer?: { id: string; full_name: string | null } | null;
  /** Отметка «Отдел кадров ознакомлен» (только отпуска). NULL/отсутствует — не отмечено. */
  hr_acknowledged_at?: string | null;
  hr_acknowledged_by?: string | null;
  /** След отмены: кто/когда/почему. NULL у легаси-отмен до миграции 230. */
  cancelled_by?: string | null;
  cancelled_at?: string | null;
  cancel_reason?: string | null;
  /** Инициатор отмены: сотрудник (самоотмена) / согласовавший руководитель / администратор. */
  cancel_source?: LeaveRequestCancelSource | null;
  canceller?: { id: string; full_name: string | null } | null;
  /**
   * Для time_correction/work заявок — текущий approval_status связанной
   * attendance_adjustment. 'pending' = ждёт согласования на странице /approvals.
   */
  correction_approval_status?: 'auto_approved' | 'pending' | 'approved' | 'rejected' | null;
}

/** Единый формат часов корректировки: и строка из БД, и число из оптимистичной правки → «9.00». */
export const formatCorrectionHours = (value: number | string): string => Number(value).toFixed(2);

/** Допустимые часы корректировки: 0–24 с шагом 0.5 (та же проверка на бэкенде). */
export const isValidCorrectionHours = (value: number): boolean =>
  Number.isFinite(value) && value >= 0 && value <= 24 && Number.isInteger(value * 2);

export const CORRECTION_STATUS_LABELS: Record<string, string> = {
  work: 'Рабочий день',
  vacation: 'Отпуск',
  remote: 'Удалённо',
  unpaid: 'Без сохранения',
  absent: 'Прогул',
  sick: 'Больничный',
  educational_leave: 'Учебный отпуск',
  sick_worked: 'Работа на больничном',
};

export const REQUEST_TYPE_LABELS: Record<string, string> = {
  vacation: 'Отпуск',
  sick_leave: 'Больничный',
  remote: 'Удалёнка',
  certificate: 'Справка',
  time_correction: 'Корректировка табеля',
  unpaid: 'За свой счёт',
  work: 'Работа в выходной/праздник',
  educational_leave: 'Учебный отпуск',
  sick_worked: 'Работа на больничном',
  dismissal: 'Заявление на увольнение',
};

export const STATUS_LABELS: Record<LeaveRequestStatus, string> = {
  pending: 'На рассмотрении',
  approved: 'Согласовано',
  rejected: 'Отклонено',
  cancelled: 'Отменено',
};

/** Действия в leave_request_history (миграция 240) — подписи для таймлайна в карточке. */
export type LeaveRequestHistoryAction =
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'revoked'
  | 'hours_changed'
  | 'type_changed';

export interface ILeaveRequestHistoryEntry {
  id: number;
  action: LeaveRequestHistoryAction;
  actor_id: string | null;
  actor_name: string | null;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  comment: string | null;
  created_at: string;
}

export const HISTORY_ACTION_LABELS: Record<LeaveRequestHistoryAction, string> = {
  approved: 'Согласовано',
  rejected: 'Не согласовано',
  cancelled: 'Отменено сотрудником',
  revoked: 'Согласование отменено',
  hours_changed: 'Часы изменены',
  type_changed: 'Категория изменена',
};

const CANCEL_LABELS: Record<LeaveRequestCancelSource, string> = {
  employee: 'Отменено сотрудником',
  manager: 'Отменено руководителем',
  admin: 'Отменено администратором',
};

export interface ILeaveRequestDecision {
  /** Подпись статуса с учётом инициатора отмены. */
  label: string;
  /** ФИО принявшего решение (согласовал / отменил), уже строкой. */
  actor: string | null;
  /** Момент решения (ISO). */
  at: string | null;
  /** Комментарий согласующего или причина отмены. */
  comment: string | null;
}

/**
 * Единый источник подписи решения по заявлению для всех карточек: статус + кто/когда/почему.
 * Для отмен различает инициатора (cancel_source); легаси-отмены без следа → просто «Отменено».
 */
export const getRequestDecision = (r: ILeaveRequest): ILeaveRequestDecision => {
  if (r.status === 'cancelled') {
    return {
      label: r.cancel_source ? CANCEL_LABELS[r.cancel_source] : STATUS_LABELS.cancelled,
      actor: r.canceller?.full_name ?? null,
      at: r.cancelled_at ?? null,
      comment: r.cancel_reason ?? null,
    };
  }
  if (r.status === 'approved' || r.status === 'rejected') {
    return {
      label: r.status === 'approved' ? STATUS_LABELS.approved : 'Не согласовано',
      actor: r.reviewer?.full_name ?? null,
      at: r.reviewed_at ?? null,
      comment: r.review_comment ?? null,
    };
  }
  return { label: STATUS_LABELS.pending, actor: null, at: null, comment: null };
};

export interface ISelectableObject {
  object_id: string;
  object_name: string;
}

/**
 * Итог массового решения: сумма всех категорий равна числу уникальных отправленных
 * id, поэтому по сводке видно, что именно не прошло.
 */
export interface ILeaveRequestBulkResult {
  processed_count: number;
  processed_ids: number[];
  skipped_not_pending: number;
  skipped_no_access: number;
  skipped_locked: number;
  locked_ids: number[];
  skipped_failed: number;
  failed_ids: number[];
}

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
    correction_object_id?: string;
    attachments?: number[];
    selected_dates?: string[];
  }) => {
    const res = await apiClient.post<ApiResponse<ILeaveRequest>>('/leave-requests', data);
    return res.data;
  },

  getMyObjects: async (): Promise<ISelectableObject[]> => {
    const res = await apiClient.get<ApiResponse<ISelectableObject[]>>('/leave-requests/my-objects');
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

  /** История изменений заявления (автор или согласующий). Запрос ленивый — только при раскрытии блока. */
  getHistory: async (id: number): Promise<ILeaveRequestHistoryEntry[]> => {
    const res = await apiClient.get<ApiResponse<ILeaveRequestHistoryEntry[]>>(`/leave-requests/${id}/history`);
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

  // Отпуска всех сотрудников кроме рабочих (вкладка «Отпуска», admin/hr).
  getVacations: async (status?: LeaveRequestStatus) => {
    const params = status ? `?status=${status}` : '';
    const res = await apiClient.get<ApiResponse<ILeaveRequest[]>>(`/leave-requests/vacations${params}`);
    return res.data;
  },

  // Отметка «Отдел кадров ознакомлен» по заявлению на отпуск (admin/hr).
  acknowledgeHr: async (id: number) => {
    const res = await apiClient.patch<ApiResponse<ILeaveRequest>>(`/leave-requests/${id}/hr-acknowledge`, {});
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

  // Массовое согласование выбранных заявлений. Бэк проверяет доступ по каждому id
  // и молча пропускает недоступные — итог приходит сводкой.
  bulkApprove: async (ids: number[], comment?: string): Promise<ILeaveRequestBulkResult> => {
    const res = await apiClient.post<ApiResponse<ILeaveRequestBulkResult>>(
      '/leave-requests/bulk-approve',
      comment ? { ids, comment } : { ids },
    );
    return res.data;
  },

  // Массовое отклонение выбранных заявлений (комментарий общий на весь пакет).
  bulkReject: async (ids: number[], comment?: string): Promise<ILeaveRequestBulkResult> => {
    const res = await apiClient.post<ApiResponse<ILeaveRequestBulkResult>>(
      '/leave-requests/bulk-reject',
      comment ? { ids, comment } : { ids },
    );
    return res.data;
  },

  // Самоотмена автором. Для отпусков причина обязательна (проверяется и на бэкенде).
  cancel: async (id: number, reason?: string) => {
    const res = await apiClient.patch<ApiResponse<ILeaveRequest>>(`/leave-requests/${id}/cancel`, { reason });
    return res.data;
  },

  // Смена категории заявления отделом кадров (вкладка «Отпуска», admin/hr).
  // expectedRequestType — категория на момент открытия редактора: сервер сверяет её
  // под локом и отвечает 409, если её уже сменил другой HR (защита от stale-UI).
  updateRequestType: async (
    id: number,
    requestType: LeaveRequestType,
    expectedRequestType: LeaveRequestType,
  ) => {
    const res = await apiClient.patch<ApiResponse<ILeaveRequest>>(
      `/leave-requests/${id}/request-type`,
      { request_type: requestType, expected_request_type: expectedRequestType },
    );
    return res.data;
  },

  // Правка часов корректировки табеля согласующим до одобрения (admin/hr/руководитель отдела).
  updateCorrectionHours: async (id: number, hours: number) => {
    const res = await apiClient.patch<ApiResponse<ILeaveRequest>>(
      `/leave-requests/${id}/correction-hours`,
      { hours },
    );
    return res.data;
  },

  // Управленческая отмена согласования (admin или согласовавший руководитель), любой тип.
  revokeApproval: async (id: number, reason?: string) => {
    const res = await apiClient.patch<ApiResponse<ILeaveRequest>>(`/leave-requests/${id}/revoke-approval`, { reason });
    return res.data;
  },

  getPendingCount: async (): Promise<{ count: number }> => {
    const res = await apiClient.get<ApiResponse<{ count: number }>>('/leave-requests/pending-count');
    return res.data;
  },
};
