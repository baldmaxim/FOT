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
}

export interface ISubmissionDetailRow {
  id: string;
  pass_number: string;
  holder_name: string | null;
  card_uid: string | null;
  pass_status: ContractorPassStatus;
  approval_status: ContractorPassApprovalStatus;
  is_active: boolean;
  access_point_names: string[] | null;
  object_label: string;
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

export interface IPoolCell {
  pass_number: string;
  status: 'free' | 'occupied';
  /** id свободной строки (для назначения); null для занятых. */
  id: string | null;
}

export interface IPoolMatrixResult {
  cells: IPoolCell[];
  totals: { free: number; occupied: number };
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
  holder_name: string | null;
  expires_at: string | null;
  access_point_names: string[] | null;
  submission_id: string | null;
  updated_at: string;
  object_label: string;
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

export interface IPassHistory {
  holders: IHolderHistoryRow[];
  decisions: ISubmissionDecisionRow[];
}

export interface IDecideItem {
  pass_id: string;
  decision: 'approved' | 'rejected';
  reason?: string;
  access_point_names?: string[];
}

export interface IDecideResult {
  status: string;
  applied: number;
  rejected: number;
  failed: number;
  errors: string[];
  warnings: string[];
}

export interface IPoolIssueInput {
  from: number;
  to?: number;
  cards: Array<{ uid: string; sequence: number }>;
}

export interface IPoolIssueResult {
  created: string[];
  failed: Array<{ pass_number: string; error: string }>;
  warnings: string[];
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
  async getPendingSubmissions(): Promise<IPendingSubmission[]> {
    const r = await apiClient.get<ApiResponse<IPendingSubmission[]>>('/admin/contractor/submissions/pending');
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
  async approveSubmission(id: string): Promise<{ status: string; applied: number; failed: number; errors: string[] }> {
    const r = await apiClient.post<ApiResponse<{ status: string; applied: number; failed: number; errors: string[] }>>(
      `/admin/contractor/submissions/${id}/approve`,
    );
    return r.data;
  },
  async rejectSubmission(id: string, comment?: string): Promise<void> {
    await apiClient.post(`/admin/contractor/submissions/${id}/reject`, { comment });
  },
  async decideSubmissionItems(id: string, decisions: IDecideItem[]): Promise<IDecideResult> {
    const r = await apiClient.post<ApiResponse<IDecideResult>>(
      `/admin/contractor/submissions/${id}/decide`,
      { decisions },
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
    return r.data ?? { cells: [], totals: { free: 0, occupied: 0 } };
  },
  async getPoolNextNumber(): Promise<number> {
    const r = await apiClient.get<ApiResponse<{ next: number }>>('/admin/contractor/pool/next-number');
    return r.data?.next ?? 1;
  },
  async addToPool(input: IPoolIssueInput): Promise<IPoolIssueResult> {
    const r = await apiClient.post<ApiResponse<IPoolIssueResult>>('/admin/contractor/pool/issue', input);
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
  async getPassHistoryAdmin(passId: string): Promise<IPassHistory> {
    const r = await apiClient.get<ApiResponse<IPassHistory>>(`/admin/contractor/passes/${passId}/history`);
    return r.data ?? { holders: [], decisions: [] };
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
