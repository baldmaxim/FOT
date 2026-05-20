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
  /** Расширенная диагностика (заполняется бэком при ошибке апстрима МТС). */
  mtsHttp?: number;
  mtsCode?: number | null;
  mtsDescription?: string | null;
  mtsMessage?: string;
  baseUrl?: string | null;
  source?: string;
  hasToken?: boolean;
}

export interface IMtsSubscriberGroup {
  subscriberGroupID: number;
  name: string | null;
  [k: string]: unknown;
}

export interface IMtsCustomField {
  customFieldID?: number;
  name?: string | null;
  type?: string | null;
  isRequired?: boolean | null;
  [k: string]: unknown;
}

export interface IMtsTrackSegment {
  trackID: number;
  subscriberID: number;
  startDate: string | null;
  finishDate: string | null;
  startAddress: string | null;
  finishAddress: string | null;
  startLat: number | null;
  startLon: number | null;
  finishLat: number | null;
  finishLon: number | null;
  distance: number | null;
  duration: number | null;
}

export interface IMtsGpsPoint {
  locationID: number;
  subscriberID: number;
  locationDate: string | null;
  latitude: number | null;
  longitude: number | null;
  angle: number | null;
  velocity: number | null;
  isValid: boolean | null;
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
  subscriberGroupIDs?: number[] | null;
  customTemplateItems?: unknown[] | null;
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

export interface IMtsTaskRow {
  id: number;
  mtsTaskId: number | null;
  subscriberId: number | null;
  startDate: string;
  deadline: string | null;
  createdBy: string | null;
  title: string | null;
  description: string | null;
  address: string | null;
  status: string | null;
  createdAt: string;
  syncedAt: string;
}

export interface IMtsTaskCreateInput {
  title: string;
  startDate: string;
  subscriberID?: number | null;
  deadline?: string | null;
  description?: string | null;
  address?: string | null;
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

  getTasks: async (): Promise<IMtsTaskRow[]> => {
    const res = await apiClient.get<ApiResponse<IMtsTaskRow[]>>('/mts/tasks');
    return res.data;
  },

  getTask: async (taskId: number): Promise<IMtsTaskRow | null> => {
    const res = await apiClient.get<ApiResponse<IMtsTaskRow | null>>(`/mts/tasks/${taskId}`);
    return res.data;
  },

  createTask: async (input: IMtsTaskCreateInput): Promise<IMtsTaskRow> => {
    const res = await apiClient.post<ApiResponse<IMtsTaskRow>>('/mts/tasks', input);
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

  // === Дополнительные бесплатные read-only ресурсы (GET → бэк → GET → МТС) ===
  getSubscriberGroups: async (): Promise<IMtsSubscriberGroup[]> => {
    const res = await apiClient.get<ApiResponse<IMtsSubscriberGroup[]>>('/mts/subscriber-groups');
    return res.data;
  },

  getCustomFields: async (): Promise<IMtsCustomField[]> => {
    const res = await apiClient.get<ApiResponse<IMtsCustomField[]>>('/mts/custom-fields');
    return res.data;
  },

  getRecentTracks: async (days: number): Promise<IMtsTrackSegment[]> => {
    const res = await apiClient.get<ApiResponse<IMtsTrackSegment[]>>(`/mts/recent-tracks?days=${days}`);
    return res.data;
  },

  getRecentLocations: async (days: number): Promise<IMtsLocation[]> => {
    const res = await apiClient.get<ApiResponse<IMtsLocation[]>>(`/mts/recent-locations?days=${days}`);
    return res.data;
  },

  getRecentGlobalLocations: async (days: number): Promise<IMtsGpsPoint[]> => {
    const res = await apiClient.get<ApiResponse<IMtsGpsPoint[]>>(`/mts/recent-global-locations?days=${days}`);
    return res.data;
  },
};
