import { apiClient, buildApiUrl, buildAuthHeaders } from '../api/client';

interface ApiResponse<T> {
  data: T;
  message?: string;
}

export interface IContractorOrg {
  id: string;
  name: string;
  sigur_department_id: number | null;
}

/** Организация подрядчика + счётчик сотрудников в реестре ОТиТБ (прошедших инструктаж). */
export interface IInductionOrg extends IContractorOrg {
  inducted_count: number;
}

/** Запись реестра ОТиТБ (сотрудник, прошедший вводный инструктаж). */
export interface IInductedPerson {
  id: string;
  full_name: string;
  inducted_on: string;
}

/** Запись реестра ОТиТБ + организация (для плоского списка «показать всех»). */
export interface IInductedPersonFull extends IInductedPerson {
  org_department_id: string;
  org_name: string;
}

export interface IRosterRow {
  id: string;
  full_name: string;
  sigur_employee_id: number | null;
  state: 'active' | 'pending_add' | 'pending_remove' | 'removed';
  assigned_pass_id: string | null;
  assigned_pass_number: string | null;
  submission_id: string | null;
  removal_requested_at: string | null;
}

export type ContractorPassStatus =
  | 'in_pool'
  | 'assigned'
  | 'submitted'
  | 'applied'
  | 'blocked'
  | 'revoked';

export type ContractorPassApprovalStatus = 'not_submitted' | 'pending' | 'approved' | 'rejected';

export interface IPassRow {
  id: string;
  pass_number: string;
  status: ContractorPassStatus;
  approval_status: ContractorPassApprovalStatus;
  is_active: boolean;
  sigur_employee_id: number | null;
  card_uid: string | null;
  holder_name: string | null;
  expires_at: string | null;
  submission_id: string | null;
  access_point_names: string[] | null;
  object_label: string;
  passport_series_number: string | null;
  passport_issue_date: string | null;
  birth_date: string | null;
  citizenship: string | null;
  patent_number: string | null;
  patent_issue_date: string | null;
  patent_blank_number: string | null;
  has_residence_permit: boolean;
  residence_permit_number: string | null;
}

/** Персональные документы держателя пропуска (паспорт/патент/ВНЖ). */
export interface IPassDocuments {
  passport_series_number: string | null;
  passport_issue_date: string | null;
  birth_date: string | null;
  citizenship: string | null;
  patent_number: string | null;
  patent_issue_date: string | null;
  patent_blank_number: string | null;
  /** ВНЖ отменяет требование патента (для патентных гражданств). */
  has_residence_permit: boolean;
  residence_permit_number: string | null;
}

export interface ISubmissionRow {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'partially_applied';
  submitted_at: string;
  reviewed_at: string | null;
  comment: string | null;
  apply_error: string | null;
}

export interface IPendingSubmission {
  id: string;
  org_department_id: string;
  org_name: string;
  status: 'pending' | 'partially_applied';
  submitted_at: string;
  apply_error: string | null;
  passes: string;
  applied: string;
  pending: string;
}

/** Совпадение номера документа с другим держателем внутри организации. */
export interface IPassDocDuplicate {
  holder_name: string | null;
  pass_number: string;
}

export interface ISubmissionDetailRow {
  id: string;
  pass_number: string;
  holder_name: string | null;
  card_uid: string | null;
  pass_status: ContractorPassStatus;
  approval_status: ContractorPassApprovalStatus;
  is_active: boolean;
  /** Пройден ли вводный инструктаж (ОТиТБ). Без него пропуск нельзя открыть. */
  induction_passed: boolean;
  access_point_names: string[] | null;
  object_label: string;
  passport_series_number: string | null;
  passport_issue_date: string | null;
  birth_date: string | null;
  citizenship: string | null;
  patent_number: string | null;
  patent_issue_date: string | null;
  patent_blank_number: string | null;
  /** ВНЖ отменяет требование патента (для патентных гражданств). */
  has_residence_permit: boolean;
  residence_permit_number: string | null;
  documents_complete: boolean;
  /** Другие держатели той же орг с таким же номером патента. */
  dup_patent: IPassDocDuplicate[];
  /** Другие держатели той же орг с таким же номером паспорта. */
  dup_passport: IPassDocDuplicate[];
}

export interface IPoolItem {
  id: string;
  pass_number: string;
  card_uid: string | null;
  sigur_employee_id: number | null;
  created_at: string;
}

export interface IPoolListPage {
  items: IPoolItem[];
  total: number;
}

export interface IPoolRange {
  from: string;
  to: string;
  status: 'free' | 'occupied';
  count: number;
}

export interface IPoolRangesResult {
  ranges: IPoolRange[];
  totals: { free: number; occupied: number };
}

export type PoolCellStatus = 'free' | 'occupied' | 'provisioning' | 'failed';

export interface IPoolCell {
  pass_number: string;
  status: PoolCellStatus;
  /** id свободной строки (для назначения и удаления free); null для остальных. */
  id: string | null;
  /** id занятой строки (assigned/submitted/applied/blocked) — для удаления занятого; иначе null. */
  occupied_id: string | null;
  /** id строки provisioning/provisioning_failed (для повтора выпуска/удаления); иначе null. */
  failed_id: string | null;
  /** текст ошибки выпуска (tooltip); иначе null. */
  error: string | null;
}

export interface IPoolMatrixTotals {
  free: number;
  occupied: number;
  provisioning: number;
  failed: number;
}

export interface IPoolMatrixResult {
  cells: IPoolCell[];
  totals: IPoolMatrixTotals;
}

export interface ISigurDepartmentNode {
  id: number;
  name: string;
  parent_id: number | null;
}

export interface IPoolSettings {
  sigur_department_id: number | null;
  name: string | null;
}

export interface ISentPassRow {
  id: string;
  pass_number: string;
  status: ContractorPassStatus;
  approval_status: ContractorPassApprovalStatus;
  is_active: boolean;
  sigur_employee_id: number | null;
  card_uid: string | null;
  holder_name: string | null;
  org_department_id: string;
  org_name: string;
  submission_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface IMonitorPassRow {
  id: string;
  pass_number: string;
  status: ContractorPassStatus;
  approval_status: ContractorPassApprovalStatus;
  is_active: boolean;
  sigur_employee_id: number | null;
  card_uid: string | null;
  w26: string | null;
  holder_name: string | null;
  org_name?: string | null;
  expires_at: string | null;
  access_point_names: string[] | null;
  submission_id: string | null;
  updated_at: string;
  object_label: string;
  passport_series_number: string | null;
  passport_issue_date: string | null;
  birth_date: string | null;
  citizenship: string | null;
  patent_number: string | null;
  patent_issue_date: string | null;
  patent_blank_number: string | null;
  has_residence_permit: boolean;
  residence_permit_number: string | null;
}

export interface IContractorPassStat {
  org_department_id: string;
  org_name: string;
  /** Выдано новых номерных пропусков (все, кроме отозванных). */
  issued_new: number;
  /** Активные новые номерные пропуска. */
  active_new: number;
  /** Старые «белые» пропуска — сотрудники в папке подрядчика без нового номерного пропуска. */
  old_total: number;
  /** Из них реально использовались (проходы по СКУД за последние 2 недели). */
  old_used: number;
}

export interface IHolderHistoryRow {
  id: string;
  holder_name: string;
  valid_from: string;
  valid_until: string | null;
  changed_by_name: string | null;
  submission_id: string | null;
  approved_at: string | null;
  approved_by_name: string | null;
}

export interface ISubmissionDecisionRow {
  id: string;
  submission_id: string;
  decision: 'approved' | 'rejected';
  decided_at: string;
  reason: string | null;
  access_point_names: string[] | null;
  decided_by_name: string | null;
}

export interface IAccessPointEventRow {
  id: string;
  created_at: string;
  changed_by_name: string | null;
  details: {
    added_names?: string[];
    total_names?: string[];
    source?: string;
  } | null;
}

export interface IPassHistory {
  holders: IHolderHistoryRow[];
  decisions: ISubmissionDecisionRow[];
  accessPointEvents?: IAccessPointEventRow[];
}

export interface IDecideItem {
  pass_id: string;
  decision: 'approved' | 'rejected';
  reason?: string;
  access_point_names?: string[];
  /** Срок действия конкретного пропуска (режим «не для всех»). */
  expires_at?: string;
}

/** Дубль-однофамилец только что активированного (подрядный пропуск или штатный сотрудник). */
export interface IDuplicateRow {
  source: 'contractor_pass' | 'employee';
  sigur_employee_id: number;
  employee_id: number | null;
  pass_id: string | null;
  full_name: string;
  place_name: string | null;
  pass_number: string | null;
  card_uid: string | null;
  access_point_names: string[] | null;
}

export interface IDecideResult {
  status: string;
  applied: number;
  rejected: number;
  failed: number;
  errors: string[];
  warnings: string[];
  /** Батч активации для последующей блокировки дублей (null — дублей нет). */
  batch_id: string | null;
  duplicates: IDuplicateRow[];
}

export type IBlockDuplicateAction = 'returned_to_pool' | 'deleted' | 'dismissed';

export interface IBlockDuplicateResult {
  action: IBlockDuplicateAction;
  dry_run?: boolean;
}

export interface IPoolIssueInput {
  from: number;
  to?: number;
  /** hex_uid — полный CSN карты с ридера; reader — весь payload ридера (для анализа коллизий). */
  cards: Array<{ uid: string; sequence: number; hex_uid?: string; reader?: Record<string, unknown> }>;
}

/** Универсальная проверка карты перед добавлением: где она уже засветилась (БД пула + Sigur). */
export interface IPoolCardConflict {
  card_uid: string;
  w26: string | null;
  db: Array<{ pass_number: string; status: string; card_hex_uid: string | null }>;
  sigur: null | {
    card_id: number | null;
    value: string | null;
    bound_employee_id: number | null;
    bound_employee_name: string | null;
    is_pool_placeholder: boolean;
  };
  has_conflict: boolean;
  sigur_error?: string;
}

export type PoolFailStage = 'input' | 'range' | 'duplicate' | 'duplicate_card' | 'card' | 'sigur';

export interface IPoolFail {
  pass_number: string;
  error: string;
  stage: PoolFailStage;
}

export interface IPoolIssueResult {
  created: string[];
  failed: IPoolFail[];
  warnings: string[];
  reserved: string[];
  missing: string[];
}

export interface IPoolRetryResult {
  retried: number;
  created: string[];
  failed: IPoolFail[];
}

export interface IPoolCancelResult {
  cancelled: string[];
  failed: Array<{ pass_number: string; error: string }>;
}

export type PoolAnomalyReason = 'no_profile' | 'duplicate_card';

export interface IPoolAnomaly {
  id: string;
  pass_number: string;
  card_uid: string | null;
  sigur_employee_id: number | null;
  reason: PoolAnomalyReason;
  /** Другой(ие) номер(а) с той же картой (для duplicate_card); иначе null. */
  dup_with: string | null;
}

export interface IPoolDeleteResult {
  deleted: string[];
  failed: Array<{ pass_id: string; pass_number: string | null; error: string }>;
}

export interface IPoolAssignResult {
  assigned: string[];
  failed: Array<{ pass_id: string; error: string }>;
}

export interface IFreePass {
  id: string;
  pass_number: string;
}

export interface IFailedSyncPass {
  id: string;
  pass_number: string;
  sigur_sync_error: string | null;
  sigur_sync_attempts: number;
  sigur_sync_updated_at: string | null;
}

export interface IRemovalRequest {
  roster_id: string;
  org_department_id: string;
  org_name: string;
  full_name: string;
  sigur_employee_id: number | null;
  removal_requested_at: string | null;
  employee_id: number | null;
  employment_status: string | null;
}

export interface IContractorUser {
  id: string;
  full_name: string | null;
  org_department_id: string | null;
  org_name: string | null;
}

export interface ISkudObjectOption {
  id: string;
  name: string;
}

export interface IObjectAccessPoint {
  object_id: string;
  object_name: string;
  access_point_name: string;
}

export interface ISigurAccessPointOption {
  id: number;
  name: string;
}

export interface IIssuePassBatchInput {
  org_department_id: string;
  from: number;
  to?: number;
  object_ids: string[];
  access_point_names: string[];
  expires_at?: string;
  cards: Array<{ uid: string; sequence: number }>;
  notify?: boolean;
}

export interface IIssuePassBatchResult {
  created: string[];
  failed: Array<{ pass_number: string; error: string }>;
  warnings: string[];
}

export interface IContractorDocument {
  id: string;
  org_department_id: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  r2_key: string;
  uploaded_by: string | null;
  created_at: string;
}

/** Контрактор-фасад (роль «Подрядчик»). */
export const contractorService = {
  async getMyOrg(): Promise<{ id: string; name: string } | null> {
    const r = await apiClient.get<ApiResponse<{ id: string; name: string } | null>>('/contractor/me/org');
    return r.data ?? null;
  },
  async getRoster(): Promise<IRosterRow[]> {
    const r = await apiClient.get<ApiResponse<IRosterRow[]>>('/contractor/roster');
    return r.data ?? [];
  },
  async addPerson(fullName: string): Promise<void> {
    await apiClient.post('/contractor/roster/person', { full_name: fullName });
  },
  async markRemoval(id: string): Promise<void> {
    await apiClient.post(`/contractor/roster/${id}/remove`);
  },
  async unmark(id: string): Promise<void> {
    await apiClient.post(`/contractor/roster/${id}/unmark`);
  },
  async getPasses(): Promise<IPassRow[]> {
    const r = await apiClient.get<ApiResponse<IPassRow[]>>('/contractor/passes');
    return r.data ?? [];
  },
  /** Сотрудники организации, прошедшие вводный инструктаж (реестр ОТиТБ) — для выбора ФИО. */
  async getInductedPersons(): Promise<Array<{ id: string; full_name: string }>> {
    const r = await apiClient.get<ApiResponse<Array<{ id: string; full_name: string }>>>(
      '/contractor/inducted-persons',
    );
    return r.data ?? [];
  },
  async setPassHolder(passId: string, fullName: string | null): Promise<void> {
    await apiClient.post(`/contractor/passes/${passId}/holder`, { full_name: fullName });
  },
  async changeHolder(passId: string, newHolderName: string, validFrom: string): Promise<{ submission_id: string }> {
    const r = await apiClient.post<ApiResponse<{ submission_id: string }>>(
      `/contractor/passes/${passId}/change-holder`,
      { new_holder_name: newHolderName, valid_from: validFrom },
    );
    return r.data;
  },
  async getPassHistory(passId: string): Promise<IPassHistory> {
    const r = await apiClient.get<ApiResponse<IPassHistory>>(`/contractor/passes/${passId}/history`);
    return r.data ?? { holders: [], decisions: [] };
  },
  async savePassDocuments(passId: string, docs: IPassDocuments): Promise<void> {
    await apiClient.post(`/contractor/passes/${passId}/documents`, docs);
  },
  async submit(): Promise<void> {
    await apiClient.post('/contractor/submit');
  },
  async getSubmissions(): Promise<ISubmissionRow[]> {
    const r = await apiClient.get<ApiResponse<ISubmissionRow[]>>('/contractor/submissions');
    return r.data ?? [];
  },

  // Документы организации
  async listDocuments(): Promise<IContractorDocument[]> {
    const r = await apiClient.get<ApiResponse<IContractorDocument[]>>('/contractor/documents');
    return r.data ?? [];
  },
  async uploadDocument(file: File): Promise<IContractorDocument> {
    const form = new FormData();
    form.append('file', file);
    const response = await fetch(buildApiUrl('/contractor/documents'), {
      method: 'POST',
      credentials: 'include',
      headers: buildAuthHeaders(),
      body: form,
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error((json && json.error) || 'Не удалось загрузить файл');
    }
    return json.data as IContractorDocument;
  },
  async deleteDocument(id: string): Promise<void> {
    await apiClient.delete(`/contractor/documents/${id}`);
  },
  async getDocumentDownloadUrl(id: string): Promise<{ url: string; file_name: string }> {
    const r = await apiClient.get<ApiResponse<{ url: string; file_name: string }>>(
      `/contractor/documents/${id}/download`,
    );
    return r.data;
  },
};

/** Админ-фасад подрядчиков. */
export const contractorAdminService = {
  async listOrgs(): Promise<IContractorOrg[]> {
    const r = await apiClient.get<ApiResponse<IContractorOrg[]>>('/admin/contractor/orgs');
    return r.data ?? [];
  },
  // Реестр ОТиТБ: прошедшие вводный инструктаж сотрудники подрядчиков.
  async getInductionOrgs(): Promise<IInductionOrg[]> {
    const r = await apiClient.get<ApiResponse<IInductionOrg[]>>('/admin/contractor/induction/orgs');
    return r.data ?? [];
  },
  async listInducted(orgId: string): Promise<IInductedPerson[]> {
    const r = await apiClient.get<ApiResponse<IInductedPerson[]>>(
      `/admin/contractor/induction?org_department_id=${encodeURIComponent(orgId)}`,
    );
    return r.data ?? [];
  },
  /** Плоский список всех прошедших инструктаж по всем подрядным организациям. */
  async listAllInducted(): Promise<IInductedPersonFull[]> {
    const r = await apiClient.get<ApiResponse<IInductedPersonFull[]>>('/admin/contractor/induction/all');
    return r.data ?? [];
  },
  async addInducted(orgId: string, fullName: string, inductedOn?: string): Promise<IInductedPerson> {
    const r = await apiClient.post<ApiResponse<IInductedPerson>>('/admin/contractor/induction', {
      org_department_id: orgId,
      full_name: fullName,
      inducted_on: inductedOn,
    });
    return r.data;
  },
  async removeInducted(id: string): Promise<void> {
    await apiClient.delete(`/admin/contractor/induction/${id}`);
  },
  async listIssueObjects(): Promise<ISkudObjectOption[]> {
    const r = await apiClient.get<ApiResponse<ISkudObjectOption[]>>('/admin/contractor/objects');
    return r.data ?? [];
  },
  async listObjectAccessPoints(objectIds: string[]): Promise<IObjectAccessPoint[]> {
    if (objectIds.length === 0) return [];
    const r = await apiClient.get<ApiResponse<IObjectAccessPoint[]>>(
      `/admin/contractor/objects/access-points?object_ids=${encodeURIComponent(objectIds.join(','))}`,
    );
    return r.data ?? [];
  },
  async getNextPassNumber(orgId: string): Promise<number> {
    const r = await apiClient.get<ApiResponse<{ next: number }>>(
      `/admin/contractor/orgs/${orgId}/next-pass`,
    );
    return r.data?.next ?? 1;
  },
  async issuePassBatch(input: IIssuePassBatchInput): Promise<IIssuePassBatchResult> {
    const r = await apiClient.post<ApiResponse<IIssuePassBatchResult>>(
      '/admin/contractor/passes/issue',
      input,
    );
    return r.data;
  },
  async listContractorUsers(): Promise<IContractorUser[]> {
    const r = await apiClient.get<ApiResponse<IContractorUser[]>>('/admin/contractor/users');
    return r.data ?? [];
  },
  async getUserOrg(userId: string): Promise<string | null> {
    const r = await apiClient.get<ApiResponse<{ org_department_id: string | null }>>(
      `/admin/contractor/users/${userId}/org`,
    );
    return r.data?.org_department_id ?? null;
  },
  async setUserOrg(userId: string, orgDepartmentId: string | null): Promise<void> {
    await apiClient.put(`/admin/contractor/users/${userId}/org`, { org_department_id: orgDepartmentId });
  },
  async getPendingSubmissions(q?: string): Promise<IPendingSubmission[]> {
    const qs = q && q.trim() ? `?q=${encodeURIComponent(q.trim())}` : '';
    const r = await apiClient.get<ApiResponse<IPendingSubmission[]>>(
      `/admin/contractor/submissions/pending${qs}`,
    );
    return r.data ?? [];
  },
  async getPendingSubmissionsCount(): Promise<{ count: number }> {
    const r = await apiClient.get<ApiResponse<{ count: number }>>('/admin/contractor/submissions/pending/count');
    return r.data ?? { count: 0 };
  },
  async exportSubmission(id: string): Promise<Blob> {
    const response = await fetch(
      buildApiUrl(`/admin/contractor/submissions/${id}/export`),
      { credentials: 'include', headers: buildAuthHeaders() },
    );
    if (!response.ok) throw new Error('Не удалось скачать файл');
    return response.blob();
  },
  async listSigurAccessPoints(): Promise<ISigurAccessPointOption[]> {
    const r = await apiClient.get<ApiResponse<ISigurAccessPointOption[]>>(
      '/admin/contractor/sigur-access-points',
    );
    return r.data ?? [];
  },
  async getSubmissionDetail(id: string): Promise<ISubmissionDetailRow[]> {
    const r = await apiClient.get<ApiResponse<ISubmissionDetailRow[]>>(`/admin/contractor/submissions/${id}`);
    return r.data ?? [];
  },
  /** Отметить/снять вводный инструктаж держателя пропуска (ОТиТБ). */
  async setPassInduction(passId: string, passed: boolean): Promise<{ induction_passed: boolean }> {
    const r = await apiClient.patch<ApiResponse<{ induction_passed: boolean }>>(
      `/admin/contractor/submissions/passes/${passId}/induction`,
      { passed },
    );
    return r.data;
  },
  async approveSubmission(id: string): Promise<{ status: string; applied: number; failed: number; errors: string[] }> {
    const r = await apiClient.post<ApiResponse<{ status: string; applied: number; failed: number; errors: string[] }>>(
      `/admin/contractor/submissions/${id}/approve`,
    );
    return r.data;
  },
  async rejectSubmission(id: string, comment?: string): Promise<void> {
    await apiClient.post(`/admin/contractor/submissions/${id}/reject`, { comment });
  },
  async rejectSubmissionPasses(
    id: string,
    passIds: string[],
    comment?: string,
  ): Promise<{ returned: number; status: string; warnings: string[] }> {
    const r = await apiClient.post<ApiResponse<{ returned: number; status: string; warnings: string[] }>>(
      `/admin/contractor/submissions/${id}/reject-passes`,
      { pass_ids: passIds, comment },
    );
    return r.data;
  },
  async decideSubmissionItems(
    id: string,
    decisions: IDecideItem[],
    expiresAt?: string,
  ): Promise<IDecideResult> {
    // Массовая привязка в Sigur (карты/точки) на десятки сотрудников дольше дефолтных 30с —
    // даём 120с, иначе фронт обрывал запрос таймаутом до показа модалки однофамильцев.
    const r = await apiClient.post<ApiResponse<IDecideResult>>(
      `/admin/contractor/submissions/${id}/decide`,
      { decisions, expires_at: expiresAt },
      { timeoutMs: 120_000 },
    );
    return r.data;
  },
  async blockDuplicate(batchId: string, sigurEmployeeId: number): Promise<IBlockDuplicateResult> {
    const r = await apiClient.post<ApiResponse<IBlockDuplicateResult>>(
      '/admin/contractor/duplicates/block',
      { batch_id: batchId, sigur_employee_id: sigurEmployeeId },
    );
    return r.data;
  },

  // Общий пул
  async getPoolSettings(): Promise<IPoolSettings> {
    const r = await apiClient.get<ApiResponse<IPoolSettings>>('/admin/contractor/pool/settings');
    return r.data ?? { sigur_department_id: null, name: null };
  },
  async setPoolSettings(sigurDepartmentId: number | null): Promise<void> {
    await apiClient.put('/admin/contractor/pool/settings', { sigur_department_id: sigurDepartmentId });
  },
  async listSigurDepartments(): Promise<ISigurDepartmentNode[]> {
    const r = await apiClient.get<ApiResponse<ISigurDepartmentNode[]>>('/admin/contractor/sigur-departments');
    return r.data ?? [];
  },
  async listPool(params?: { search?: string; limit?: number; offset?: number }): Promise<IPoolListPage> {
    const qp = new URLSearchParams();
    if (params?.search) qp.set('search', params.search);
    if (params?.limit != null) qp.set('limit', String(params.limit));
    if (params?.offset != null) qp.set('offset', String(params.offset));
    const qs = qp.toString() ? `?${qp.toString()}` : '';
    const r = await apiClient.get<ApiResponse<IPoolListPage>>(`/admin/contractor/pool${qs}`);
    return r.data ?? { items: [], total: 0 };
  },
  async getPoolRanges(): Promise<IPoolRangesResult> {
    const r = await apiClient.get<ApiResponse<IPoolRangesResult>>('/admin/contractor/pool/ranges');
    return r.data ?? { ranges: [], totals: { free: 0, occupied: 0 } };
  },
  async getPoolMatrix(): Promise<IPoolMatrixResult> {
    const r = await apiClient.get<ApiResponse<IPoolMatrixResult>>('/admin/contractor/pool/matrix');
    return r.data ?? { cells: [], totals: { free: 0, occupied: 0, provisioning: 0, failed: 0 } };
  },
  async getPoolNextNumber(): Promise<number> {
    const r = await apiClient.get<ApiResponse<{ next: number }>>('/admin/contractor/pool/next-number');
    return r.data?.next ?? 1;
  },
  async addToPool(input: IPoolIssueInput): Promise<IPoolIssueResult> {
    const r = await apiClient.post<ApiResponse<IPoolIssueResult>>(
      '/admin/contractor/pool/issue',
      input,
      { timeoutMs: 120_000 },
    );
    return r.data;
  },
  /** Проверить считанную карту ДО добавления: где уже засветилась (БД пула + Sigur). */
  async checkPoolCard(uid: string, excludePassNumber?: string): Promise<IPoolCardConflict> {
    // Проверка ходит в Sigur (карта → привязка → владелец) — обычно ~2–3с. Ограничиваем
    // 15с, чтобы при недоступном endpoint/Sigur бейдж быстро ушёл в «нет проверки».
    const r = await apiClient.post<ApiResponse<IPoolCardConflict>>(
      '/admin/contractor/pool/check-card',
      { uid, exclude_pass_number: excludePassNumber },
      { timeoutMs: 15_000 },
    );
    return r.data;
  },
  /** Повторить выпуск «застрявших» строк пула; без passNumbers — все застрявшие. */
  async retryProvisioning(passNumbers?: string[]): Promise<IPoolRetryResult> {
    const r = await apiClient.post<ApiResponse<IPoolRetryResult>>(
      '/admin/contractor/pool/retry-provisioning',
      { pass_numbers: passNumbers },
      { timeoutMs: 120_000 },
    );
    return r.data;
  },
  /** Отменить «застрявший» выпуск по номерам: удалить строки + почистить Sigur-профиль. */
  async cancelProvisioning(passNumbers: string[]): Promise<IPoolCancelResult> {
    const r = await apiClient.post<ApiResponse<IPoolCancelResult>>(
      '/admin/contractor/pool/cancel-provisioning',
      { pass_numbers: passNumbers },
      { timeoutMs: 120_000 },
    );
    return r.data;
  },
  /** Битые строки пула (no_profile / duplicate_card) для панели проблемных пропусков. */
  async getPoolAnomalies(): Promise<IPoolAnomaly[]> {
    const r = await apiClient.get<ApiResponse<IPoolAnomaly[]>>('/admin/contractor/pool/anomalies');
    return r.data ?? [];
  },
  /** Форсированно удалить пропуска из пула по id строк (+ профиль в Sigur). */
  async deletePoolPasses(passIds: string[]): Promise<IPoolDeleteResult> {
    const r = await apiClient.post<ApiResponse<IPoolDeleteResult>>(
      '/admin/contractor/pool/delete',
      { pass_ids: passIds },
      { timeoutMs: 120_000 },
    );
    return r.data;
  },
  async assignPool(passIds: string[], orgDepartmentId: string): Promise<IPoolAssignResult> {
    const r = await apiClient.post<ApiResponse<IPoolAssignResult>>('/admin/contractor/pool/assign', {
      pass_ids: passIds,
      org_department_id: orgDepartmentId,
    });
    return r.data;
  },
  async getFreePasses(): Promise<IFreePass[]> {
    const r = await apiClient.get<ApiResponse<IFreePass[]>>('/admin/contractor/pool/free');
    return r.data ?? [];
  },
  async assignPoolCount(count: number, orgDepartmentId: string): Promise<IPoolAssignResult> {
    const r = await apiClient.post<ApiResponse<IPoolAssignResult>>('/admin/contractor/pool/assign-count', {
      count,
      org_department_id: orgDepartmentId,
    });
    return r.data;
  },

  // Заявки на удаление сотрудников
  async listRemovals(): Promise<IRemovalRequest[]> {
    const r = await apiClient.get<ApiResponse<IRemovalRequest[]>>('/admin/contractor/removals');
    return r.data ?? [];
  },
  async getRemovalsCount(): Promise<{ count: number }> {
    const r = await apiClient.get<ApiResponse<{ count: number }>>('/admin/contractor/removals/count');
    return r.data ?? { count: 0 };
  },
  async approveRemoval(rosterId: string): Promise<void> {
    await apiClient.post(`/admin/contractor/removals/${rosterId}/approve`);
  },

  async revokePass(passId: string): Promise<{ pass_id: string; pass_number: string; status: 'returned_to_pool' }> {
    const r = await apiClient.post<ApiResponse<{ pass_id: string; pass_number: string; status: 'returned_to_pool' }>>(
      `/admin/contractor/passes/${passId}/revoke`,
    );
    return r.data;
  },

  // Документы организации (админ-просмотр)
  async listOrgDocuments(orgId: string): Promise<IContractorDocument[]> {
    const r = await apiClient.get<ApiResponse<IContractorDocument[]>>(
      `/admin/contractor/orgs/${orgId}/documents`,
    );
    return r.data ?? [];
  },
  async getOrgDocumentDownloadUrl(id: string): Promise<{ url: string; file_name: string }> {
    const r = await apiClient.get<ApiResponse<{ url: string; file_name: string }>>(
      `/admin/contractor/documents/${id}/download`,
    );
    return r.data;
  },

  // Отправленные / мониторинг / история
  async listSentPasses(orgDepartmentId?: string): Promise<ISentPassRow[]> {
    const qs = orgDepartmentId ? `?org_department_id=${encodeURIComponent(orgDepartmentId)}` : '';
    const r = await apiClient.get<ApiResponse<ISentPassRow[]>>(`/admin/contractor/passes/sent${qs}`);
    return r.data ?? [];
  },
  async listMonitor(orgDepartmentId: string): Promise<IMonitorPassRow[]> {
    const r = await apiClient.get<ApiResponse<IMonitorPassRow[]>>(
      `/admin/contractor/passes/monitor?org_department_id=${encodeURIComponent(orgDepartmentId)}`,
    );
    return r.data ?? [];
  },
  async searchMonitor(q: string): Promise<IMonitorPassRow[]> {
    const r = await apiClient.get<ApiResponse<IMonitorPassRow[]>>(
      `/admin/contractor/passes/monitor?q=${encodeURIComponent(q)}`,
    );
    return r.data ?? [];
  },
  async getPassHistoryAdmin(passId: string): Promise<IPassHistory> {
    const r = await apiClient.get<ApiResponse<IPassHistory>>(`/admin/contractor/passes/${passId}/history`);
    return r.data ?? { holders: [], decisions: [] };
  },
  /** Освободить пропуск: обнулить ФИО/документы/выдачу + заблокировать профиль в Sigur. */
  async clearPassHolder(passId: string): Promise<void> {
    await apiClient.post(`/admin/contractor/passes/${passId}/clear-holder`, {});
  },

  // Статистика пропусков (новые номерные vs старые белые)
  async getPassStats(): Promise<IContractorPassStat[]> {
    const r = await apiClient.get<ApiResponse<IContractorPassStat[]>>('/admin/contractor/passes/stats');
    return r.data ?? [];
  },
  async exportPassStats(orgDepartmentId?: string): Promise<Blob> {
    const qs = orgDepartmentId ? `?org_department_id=${encodeURIComponent(orgDepartmentId)}` : '';
    const response = await fetch(
      buildApiUrl(`/admin/contractor/passes/stats/export${qs}`),
      { credentials: 'include', headers: buildAuthHeaders() },
    );
    if (!response.ok) throw new Error('Не удалось скачать файл');
    return response.blob();
  },

  // Застрявшие отзывы (досинхронизация с Sigur)
  async listSyncFailed(): Promise<IFailedSyncPass[]> {
    const r = await apiClient.get<ApiResponse<IFailedSyncPass[]>>('/admin/contractor/passes/sync-failed');
    return r.data ?? [];
  },
  async retrySync(passId: string): Promise<void> {
    await apiClient.post(`/admin/contractor/passes/${passId}/retry-sync`);
  },
};
