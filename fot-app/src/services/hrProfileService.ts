import { apiClient, buildApiUrl, buildAuthHeaders } from '../api/client';
import type {
  HrProfileInput,
  IHrCatalog,
  IHrDepartmentsResponse,
  IHrDocument,
  IHrDocumentsResponse,
  IHrDraftPayload,
  IHrDraftView,
  IHrDuplicateCandidate,
  IHrEmployeeSearchRow,
  IHrHistoryItem,
  IHrListParams,
  IHrListRow,
  IHrOcrConflict,
  IHrProfileView,
  IHrStagingRow,
} from '../types/hrProfile';

interface ApiResponse<T> {
  success: boolean;
  data: T;
  meta?: Record<string, unknown>;
  error?: string;
  code?: string;
}

const qs = (params: Record<string, string | number | boolean | undefined | null>): string => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
};

/** Скачивает защищённый файл (backend-stream с Bearer) в blob-URL. */
const fetchBlobUrl = async (endpoint: string): Promise<string> => {
  const res = await fetch(buildApiUrl(endpoint), { headers: buildAuthHeaders(), credentials: 'include' });
  if (!res.ok) {
    let message = 'Не удалось получить файл';
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch { /* not json */ }
    throw new Error(message);
  }
  return URL.createObjectURL(await res.blob());
};

export const hrProfileService = {
  async getCatalog(): Promise<IHrCatalog> {
    return (await apiClient.get<ApiResponse<IHrCatalog>>('/hr-profiles/catalog')).data;
  },

  async getDepartments(): Promise<IHrDepartmentsResponse> {
    return (await apiClient.get<ApiResponse<IHrDepartmentsResponse>>('/hr-profiles/departments')).data;
  },

  async list(params: IHrListParams): Promise<{ rows: IHrListRow[]; total: number }> {
    const res = await apiClient.get<ApiResponse<IHrListRow[]>>(`/hr-profiles${qs(params as Record<string, string | number | undefined>)}`);
    return { rows: res.data, total: Number(res.meta?.total ?? res.data.length) };
  },

  async searchEmployees(q: string): Promise<IHrEmployeeSearchRow[]> {
    return (await apiClient.get<ApiResponse<IHrEmployeeSearchRow[]>>(`/hr-profiles/employees/search${qs({ q })}`)).data;
  },

  async findDuplicates(params: { snils?: string | null; inn?: string | null; passport_number?: string | null; full_name?: string | null; birth_date?: string | null; exclude_employee_id?: number | null }): Promise<IHrDuplicateCandidate[]> {
    return (await apiClient.get<ApiResponse<IHrDuplicateCandidate[]>>(`/hr-profiles/duplicates${qs(params as Record<string, string | number | null | undefined>)}`)).data;
  },

  /** 404 с кодом HR_PROFILE_MISSING → null (профиль не заведён). */
  async get(employeeId: number): Promise<{ profile: IHrProfileView | null; canEdit: boolean; canCreate: boolean }> {
    try {
      const res = await apiClient.get<ApiResponse<IHrProfileView>>(`/hr-profiles/${employeeId}`);
      return { profile: res.data, canEdit: Boolean(res.meta?.can_edit), canCreate: Boolean(res.meta?.can_edit) };
    } catch (err) {
      const e = err as { status?: number; details?: { code?: string; data?: { can_create?: boolean } }; code?: string };
      if (e?.status === 404) return { profile: null, canEdit: false, canCreate: Boolean(e.details?.data?.can_create) };
      throw err;
    }
  },

  async getSensitive(employeeId: number): Promise<IHrProfileView> {
    return (await apiClient.get<ApiResponse<IHrProfileView>>(`/hr-profiles/${employeeId}/sensitive`)).data;
  },

  async create(employeeId: number, input: HrProfileInput): Promise<IHrProfileView> {
    return (await apiClient.post<ApiResponse<IHrProfileView>>(`/hr-profiles/${employeeId}`, input)).data;
  },

  async update(employeeId: number, input: HrProfileInput): Promise<{ profile: IHrProfileView; changedFields: string[]; zupReset: boolean }> {
    const res = await apiClient.put<ApiResponse<IHrProfileView>>(`/hr-profiles/${employeeId}`, input);
    const meta = (res.meta ?? {}) as { changedFields?: string[]; zupReset?: boolean };
    return { profile: res.data, changedFields: meta.changedFields ?? [], zupReset: Boolean(meta.zupReset) };
  },

  async history(employeeId: number): Promise<IHrHistoryItem[]> {
    return (await apiClient.get<ApiResponse<IHrHistoryItem[]>>(`/hr-profiles/${employeeId}/history`)).data;
  },

  async documents(employeeId: number): Promise<IHrDocumentsResponse> {
    return (await apiClient.get<ApiResponse<IHrDocumentsResponse>>(`/hr-profiles/${employeeId}/documents`)).data;
  },

  async uploadDocument(employeeId: number, type: string, file: File): Promise<IHrDocument> {
    const form = new FormData();
    form.append('file', file);
    form.append('type', type);
    return (await apiClient.post<ApiResponse<IHrDocument>>(`/hr-profiles/${employeeId}/documents`, form, { timeoutMs: 120_000 })).data;
  },

  async deleteDocument(documentId: number): Promise<void> {
    await apiClient.delete(`/hr-profiles/documents/${documentId}`);
  },

  async recognizeDocument(documentId: number): Promise<void> {
    await apiClient.post(`/hr-profiles/documents/${documentId}/recognize`);
  },

  documentBlobUrl(documentId: number, disposition: 'inline' | 'attachment'): Promise<string> {
    return fetchBlobUrl(`/hr-profiles/documents/${documentId}/content?disposition=${disposition}`);
  },

  async conflicts(employeeId: number): Promise<IHrOcrConflict[]> {
    return (await apiClient.get<ApiResponse<IHrOcrConflict[]>>(`/hr-profiles/${employeeId}/ocr-conflicts`)).data;
  },

  async applyConflict(id: number): Promise<void> {
    await apiClient.post(`/hr-profiles/ocr-conflicts/${id}/apply`);
  },

  async dismissConflict(id: number): Promise<void> {
    await apiClient.post(`/hr-profiles/ocr-conflicts/${id}/dismiss`);
  },

  async setZup(employeeId: number, isUploaded: boolean): Promise<void> {
    await apiClient.patch(`/hr-profiles/${employeeId}/zup`, { is_uploaded: isUploaded });
  },

  async setZupBulk(employeeIds: number[], isUploaded: boolean): Promise<number> {
    const res = await apiClient.post<ApiResponse<{ updated: number }>>('/hr-profiles/zup/bulk', { employee_ids: employeeIds, is_uploaded: isUploaded });
    return res.data.updated;
  },

  /** XLSX-выгрузка ЗУП: скачивание через fetch с Bearer (файл не кэшируется). */
  async exportZup(params: { ids?: number[]; notUploaded?: boolean; activeOnly?: boolean }): Promise<void> {
    const url = `/hr-profiles/export/zup${qs({ ids: params.ids?.join(','), notUploaded: params.notUploaded ? 1 : undefined, activeOnly: params.activeOnly === false ? 0 : undefined })}`;
    const res = await fetch(buildApiUrl(url), { headers: buildAuthHeaders(), credentials: 'include' });
    if (!res.ok) throw new Error('Не удалось сформировать выгрузку');
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') ?? '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/);
    const fileName = m ? decodeURIComponent(m[1]) : 'Выгрузка_ЗУП.xlsx';
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  },

  // ─── Черновики мастера ───
  async createDraft(payload: IHrDraftPayload): Promise<IHrDraftView> {
    return (await apiClient.post<ApiResponse<IHrDraftView>>('/hr-profiles/drafts', payload)).data;
  },
  async getDraft(draftId: string): Promise<IHrDraftView> {
    return (await apiClient.get<ApiResponse<IHrDraftView>>(`/hr-profiles/drafts/${draftId}`)).data;
  },
  /**
   * Свои незавершённые анкеты (состояния `draft` и `employee_created_pending_attach`).
   * Нужны мастеру при открытии: без них закрытие окна теряет память о созданном
   * сотруднике и следующая попытка заводит дубль.
   */
  async listMyDrafts(): Promise<IHrDraftView[]> {
    return (await apiClient.get<ApiResponse<IHrDraftView[]>>('/hr-profiles/drafts')).data;
  },
  async patchDraft(draftId: string, payload: IHrDraftPayload): Promise<IHrDraftView> {
    return (await apiClient.patch<ApiResponse<IHrDraftView>>(`/hr-profiles/drafts/${draftId}`, payload)).data;
  },
  async uploadDraftDocument(draftId: string, type: string, file: File, passportType?: 'russian' | 'foreign' | null): Promise<IHrDocument> {
    const form = new FormData();
    form.append('file', file);
    form.append('type', type);
    if (passportType) form.append('passport_type', passportType);
    return (await apiClient.post<ApiResponse<IHrDocument>>(`/hr-profiles/drafts/${draftId}/documents`, form, { timeoutMs: 120_000 })).data;
  },
  /** Сотрудник создан существующим POST /api/employees — фиксируем до прикрепления. */
  async markDraftEmployeeCreated(draftId: string, employeeId: number): Promise<void> {
    await apiClient.post(`/hr-profiles/drafts/${draftId}/mark-created`, { employee_id: employeeId });
  },
  async attachDraft(draftId: string, employeeId: number): Promise<{ employee_id: number; autoFilled: string[]; conflicts: string[] }> {
    return (await apiClient.post<ApiResponse<{ employee_id: number; autoFilled: string[]; conflicts: string[] }>>(`/hr-profiles/drafts/${draftId}/attach`, { employee_id: employeeId })).data;
  },

  // ─── Staging (админ) ───
  async staging(): Promise<IHrStagingRow[]> {
    return (await apiClient.get<ApiResponse<IHrStagingRow[]>>('/hr-profiles/staging')).data;
  },
  async stagingItem(passdeskId: string, unmask = false): Promise<{ passdesk_id: string; full_name: string; birth_date: string | null; profile: Record<string, unknown>; employee: Record<string, unknown> | null }> {
    return (await apiClient.get<ApiResponse<{ passdesk_id: string; full_name: string; birth_date: string | null; profile: Record<string, unknown>; employee: Record<string, unknown> | null }>>(`/hr-profiles/staging/${passdeskId}${qs({ unmask: unmask ? 1 : undefined })}`)).data;
  },
  async stagingLink(passdeskId: string, employeeId: number, mode: 'linked' | 'created' = 'linked'): Promise<void> {
    await apiClient.post(`/hr-profiles/staging/${passdeskId}/link`, { employee_id: employeeId, mode });
  },
};
