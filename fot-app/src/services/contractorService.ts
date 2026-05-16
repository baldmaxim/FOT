import { apiClient } from '../api/client';

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
}

export interface IPassRow {
  id: string;
  pass_number: string;
  status: 'issued' | 'assigned' | 'applied' | 'revoked';
  sigur_employee_id: number | null;
  card_uid: string | null;
  assigned_roster_id: string | null;
  assigned_full_name: string | null;
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
  adds: string;
  removes: string;
  assigns: string;
}

export interface ISubmissionDetailRow {
  id: string;
  full_name: string;
  state: string;
  sigur_employee_id: number | null;
  pass_number: string | null;
  pass_status: string | null;
}

export interface IContractorUser {
  id: string;
  full_name: string | null;
  org_department_id: string | null;
  org_name: string | null;
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
  async assignPass(passId: string, rosterId: string): Promise<void> {
    await apiClient.post(`/contractor/passes/${passId}/assign`, { roster_id: rosterId });
  },
  async submit(): Promise<void> {
    await apiClient.post('/contractor/submit');
  },
  async getSubmissions(): Promise<ISubmissionRow[]> {
    const r = await apiClient.get<ApiResponse<ISubmissionRow[]>>('/contractor/submissions');
    return r.data ?? [];
  },
};

/** Админ-фасад подрядчиков. */
export const contractorAdminService = {
  async listOrgs(): Promise<IContractorOrg[]> {
    const r = await apiClient.get<ApiResponse<IContractorOrg[]>>('/admin/contractor/orgs');
    return r.data ?? [];
  },
  async issuePassBatch(input: {
    org_department_id: string;
    count?: number;
    from?: number;
    to?: number;
    card_uids?: string[];
    skud_object_id?: string | null;
  }): Promise<{ requested: number; created: string[]; failed: Array<{ pass_number: string; error: string }> }> {
    const r = await apiClient.post<ApiResponse<{
      requested: number;
      created: string[];
      failed: Array<{ pass_number: string; error: string }>;
    }>>('/admin/contractor/passes/issue', input);
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
};
