import { apiClient } from '../api/client';

export interface IR2Status {
  enabled: boolean;
  bucket_name: string;
  has_account_id: boolean;
  has_access_key: boolean;
  has_secret_key: boolean;
}

export interface IR2TestResult {
  connected: boolean;
  error?: string;
}

interface ApiResponse<T> {
  data: T;
}

export const settingsService = {
  getR2Status: async (): Promise<IR2Status> => {
    const res = await apiClient.get<ApiResponse<IR2Status>>('/settings/r2/status');
    return res.data;
  },

  saveR2: async (data: {
    account_id?: string;
    access_key_id?: string;
    secret_access_key?: string;
    bucket_name?: string;
  }): Promise<{ enabled: boolean; bucket_name: string }> => {
    const res = await apiClient.put<ApiResponse<{ enabled: boolean; bucket_name: string }>>('/settings/r2', data);
    return res.data;
  },

  testR2: async (): Promise<IR2TestResult> => {
    const res = await apiClient.post<ApiResponse<IR2TestResult>>('/settings/r2/test', {});
    return res.data;
  },
};
