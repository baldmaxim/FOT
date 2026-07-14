import { apiClient } from '../api/client';

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export interface DataApiKey {
  id: string;
  name: string;
  description: string | null;
  key_prefix: string;
  rate_limit_per_minute: number;
  created_by: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface DataApiKeyTable {
  table_name: string;
  allowed_fields: string[];
}

export interface DataApiSchemaColumn {
  name: string;
  data_type: string;
  is_nullable: boolean;
}

export interface DataApiSchemaTable {
  name: string;
  columns: DataApiSchemaColumn[];
}

export interface DataApiRequestLog {
  id: number;
  key_id: string | null;
  table_name: string | null;
  ip: string | null;
  status_code: number;
  latency_ms: number | null;
  query_params: unknown;
  error_message: string | null;
  created_at: string;
}

export interface CreateKeyInput {
  name: string;
  description?: string | null;
  rate_limit_per_minute?: number;
  expires_at?: string | null;
}

export interface UpdateKeyInput {
  name?: string;
  description?: string | null;
  rate_limit_per_minute?: number;
  expires_at?: string | null;
}

export interface CreateKeyResult {
  id: string;
  prefix: string;
  plaintext_token: string;
}

const BASE = '/admin/data-api';

export const dataApiService = {
  async listKeys(): Promise<DataApiKey[]> {
    const res = await apiClient.get<ApiResponse<DataApiKey[]>>(`${BASE}/keys`);
    return res.data ?? [];
  },

  async createKey(input: CreateKeyInput): Promise<CreateKeyResult> {
    const res = await apiClient.post<ApiResponse<CreateKeyResult>>(`${BASE}/keys`, input);
    return res.data;
  },

  async updateKey(id: string, patch: UpdateKeyInput): Promise<void> {
    await apiClient.patch(`${BASE}/keys/${id}`, patch);
  },

  async revokeKey(id: string): Promise<void> {
    await apiClient.delete(`${BASE}/keys/${id}`);
  },

  /** Безвозвратное удаление (только отозванный/истёкший ключ) — вместе с логами. */
  async deleteKey(id: string): Promise<void> {
    await apiClient.delete(`${BASE}/keys/${id}/purge`);
  },

  async getKeyTables(id: string): Promise<DataApiKeyTable[]> {
    const res = await apiClient.get<ApiResponse<DataApiKeyTable[]>>(`${BASE}/keys/${id}/tables`);
    return res.data ?? [];
  },

  async updateKeyTables(id: string, tables: DataApiKeyTable[]): Promise<void> {
    await apiClient.put(`${BASE}/keys/${id}/tables`, { tables });
  },

  async getKeyLogs(id: string, limit = 100): Promise<DataApiRequestLog[]> {
    const res = await apiClient.get<ApiResponse<DataApiRequestLog[]>>(`${BASE}/keys/${id}/logs?limit=${limit}`);
    return res.data ?? [];
  },

  async getDbSchema(): Promise<DataApiSchemaTable[]> {
    const res = await apiClient.get<ApiResponse<DataApiSchemaTable[]>>(`${BASE}/db-schema`);
    return res.data ?? [];
  },
};
