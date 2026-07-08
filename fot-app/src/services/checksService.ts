import { apiClient } from '../api/client';

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export type CheckType = 'rkl' | 'patent';
export type CheckStatus = 'clean' | 'found' | 'invalid' | 'error' | 'not_applicable';

export interface NewdbConnectionSettings {
  baseUrl: string;
  hasToken: boolean;
  source: 'system_settings' | 'env' | 'unset';
}

export interface NewdbValidateResult {
  ok: boolean;
  baseUrl: string;
  hasToken: boolean;
  problems: string[];
}

export interface ContractorOrg {
  id: string;
  name: string;
  with_fio: number;
  total: number;
}

export interface BulkItemResult {
  passId: string;
  results?: CheckResult[];
  error?: string;
}

export interface BulkRunResult {
  items: BulkItemResult[];
  skipped: string[];
}

export const BULK_LIMIT = 15;

export interface CheckPassRow {
  id: string;
  pass_number: string;
  holder_name: string | null;
  citizenship: string | null;
  passport_series_number: string | null;
  patent_number: string | null;
  has_residence_permit: boolean | null;
  last_rkl_status: CheckStatus | null;
  last_rkl_at: string | null;
  last_rkl_summary: string | null;
  last_patent_status: CheckStatus | null;
  last_patent_at: string | null;
  last_patent_summary: string | null;
}

export interface CheckResult {
  id: string;
  check_type: CheckType;
  status: CheckStatus;
  request_sent: boolean;
  provider_status: string | null;
  result_summary: string | null;
  error_message: string | null;
  balance: number | null;
  created_at: string;
}

const BASE = '/admin/checks';

export const checksService = {
  async getConnectionSettings(): Promise<NewdbConnectionSettings> {
    const res = await apiClient.get<ApiResponse<NewdbConnectionSettings>>(`${BASE}/connection-settings`);
    return res.data;
  },

  async saveConnectionSettings(input: { baseUrl?: string | null; token?: string | null }): Promise<NewdbConnectionSettings> {
    const res = await apiClient.put<ApiResponse<NewdbConnectionSettings>>(`${BASE}/connection-settings`, input);
    return res.data;
  },

  async validateConnection(): Promise<NewdbValidateResult> {
    const res = await apiClient.post<ApiResponse<NewdbValidateResult>>(`${BASE}/connection-settings/validate`, {});
    return res.data;
  },

  async listOrgs(): Promise<ContractorOrg[]> {
    const res = await apiClient.get<ApiResponse<ContractorOrg[]>>(`${BASE}/orgs`);
    return res.data ?? [];
  },

  async listPasses(orgDepartmentId: string): Promise<CheckPassRow[]> {
    const res = await apiClient.get<ApiResponse<CheckPassRow[]>>(`${BASE}/passes?orgDepartmentId=${encodeURIComponent(orgDepartmentId)}`);
    return res.data ?? [];
  },

  async run(passId: string, types: CheckType[]): Promise<CheckResult[]> {
    const res = await apiClient.post<ApiResponse<CheckResult[]>>(`${BASE}/run`, { passId, types });
    return res.data ?? [];
  },

  async runBulk(passIds: string[], types: CheckType[]): Promise<BulkRunResult> {
    const res = await apiClient.post<ApiResponse<BulkRunResult>>(`${BASE}/run-bulk`, { passIds, types });
    return res.data;
  },

  async getResults(contractorPassId: string): Promise<CheckResult[]> {
    const res = await apiClient.get<ApiResponse<CheckResult[]>>(`${BASE}/results?contractorPassId=${encodeURIComponent(contractorPassId)}`);
    return res.data ?? [];
  },

  async getRaw(checkId: string): Promise<unknown> {
    const res = await apiClient.get<ApiResponse<unknown>>(`${BASE}/results/${checkId}/raw`);
    return res.data;
  },
};
