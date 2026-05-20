import { apiClient } from '../api/client';

export interface IMtsConnectionSettings {
  baseUrl: string;
  hasToken: boolean;
  source: 'system_settings' | 'env' | 'unset';
}

export interface IMtsTestResult {
  ok: boolean;
  count: number;
  error?: string;
}

export interface IMtsSubscriber {
  subscriberID: number;
  name: string | null;
  phone: string | null;
  isOnline: boolean | null;
  canTrack: boolean | null;
  isLocateEnabled: boolean | null;
  longitude: number | null;
  latitude: number | null;
}

export interface IMtsLocation {
  subscriberID: number;
  locationDate: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  address: string | null;
  state: string | null;
  source: string | null;
}

export interface IMtsHistoryPoint {
  recordedAt: string;
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  address: string | null;
  state: string | null;
  source: string | null;
}

export interface IMtsMappingRow {
  subscriberId: number;
  employeeId: number | null;
  phone: string | null;
  displayName: string | null;
  employeeFullName: string | null;
  employeeTabNumber: string | null;
  linkedAt: string | null;
}

export interface IMtsMappingSuggestion {
  subscriberId: number;
  subscriberName: string | null;
  employeeId: number;
  employeeFullName: string;
}

interface ApiResponse<T> {
  data: T;
}

export const mtsService = {
  getConnectionSettings: async (): Promise<IMtsConnectionSettings> => {
    const res = await apiClient.get<ApiResponse<IMtsConnectionSettings>>('/mts/connection-settings');
    return res.data;
  },

  saveConnectionSettings: async (data: {
    baseUrl?: string;
    token?: string;
  }): Promise<IMtsConnectionSettings> => {
    const res = await apiClient.put<ApiResponse<IMtsConnectionSettings>>('/mts/connection-settings', data);
    return res.data;
  },

  testConnection: async (): Promise<IMtsTestResult> => {
    const res = await apiClient.post<ApiResponse<IMtsTestResult>>('/mts/connection-settings/test', {});
    return res.data;
  },

  getSubscribers: async (): Promise<IMtsSubscriber[]> => {
    const res = await apiClient.get<ApiResponse<IMtsSubscriber[]>>('/mts/subscribers');
    return res.data;
  },

  getLastLocations: async (): Promise<IMtsLocation[]> => {
    const res = await apiClient.get<ApiResponse<IMtsLocation[]>>('/mts/last-locations');
    return res.data;
  },

  getMappings: async (): Promise<IMtsMappingRow[]> => {
    const res = await apiClient.get<ApiResponse<IMtsMappingRow[]>>('/mts/mappings');
    return res.data;
  },

  getMappingSuggestions: async (): Promise<IMtsMappingSuggestion[]> => {
    const res = await apiClient.get<ApiResponse<IMtsMappingSuggestion[]>>('/mts/mappings/suggestions');
    return res.data;
  },

  setMapping: async (data: {
    subscriberId: number;
    employeeId: number | null;
    phone?: string | null;
    displayName?: string | null;
  }): Promise<IMtsMappingRow[]> => {
    const res = await apiClient.put<ApiResponse<IMtsMappingRow[]>>('/mts/mappings', data);
    return res.data;
  },

  getHistory: async (
    subscriberId: number,
    dateFrom: string,
    dateTo: string,
  ): Promise<IMtsHistoryPoint[]> => {
    const qs = new URLSearchParams({
      subscriberId: String(subscriberId),
      dateFrom,
      dateTo,
    });
    const res = await apiClient.get<ApiResponse<IMtsHistoryPoint[]>>(`/mts/history?${qs.toString()}`);
    return res.data;
  },

  /** ПЛАТНЫЙ ручной запрос актуальной позиции. confirmed=true обязателен (бэк проверяет). */
  requestLocation: async (subscriberId: number): Promise<{ ok: boolean }> => {
    const res = await apiClient.post<ApiResponse<{ ok: boolean }>>('/mts/request-location', {
      subscriberId,
      confirmed: true,
    });
    return res.data;
  },
};
