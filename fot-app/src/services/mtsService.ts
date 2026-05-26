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

export interface IGeoPoint {
  lat: number;
  lng: number;
}

export interface IMtsEmployeeLinkedRow {
  subscriberId: number;
  employeeId: number | null;
  employeeFullName: string | null;
  employeeTabNumber: string | null;
  phone: string | null;
  displayName: string | null;
  lastRecordedAt: string | null;
}

export interface IMtsTrackPoint {
  recordedAt: string;
  lat: number;
  lng: number;
  accuracy: number | null;
  source: string | null;
}

export interface IMtsGeofence {
  id: string;
  name: string;
  geometry: IGeoPoint[];
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  employeeIds: number[];
  skudObjectIds: string[];
}

export interface ISkudObjectLite {
  id: string;
  name: string;
}

export interface IMtsSummary {
  subscribersTotal: number;
  linkedTotal: number;
  onlineNow: number;
  violationsLast24h: number;
}

export interface IMtsRawSubscriberDebug {
  topLevelKeys: string[];
  redacted: Record<string, unknown>;
  valueTypes: Record<string, string>;
  fetchedAt: string;
}

export interface IMtsGeofenceViolation {
  id: string;
  geofenceId: string;
  geofenceName: string | null;
  employeeId: number;
  employeeFullName: string | null;
  startedAt: string;
  endedAt: string | null;
  lastNotifiedAt: string | null;
  notifyCount: number;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  source: string | null;
}

interface ApiResponse<T> {
  data: T;
  meta?: { total?: number; page?: number; pageSize?: number };
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

  /** То же что getSubscribers, но возвращает meta (upstreamTotal, hasFullAccess, filteredOut). */
  getSubscribersWithMeta: async (): Promise<{ data: IMtsSubscriber[]; meta: { upstreamTotal?: number; filteredOut?: number; hasFullAccess?: boolean; mappingsInScope?: number; mappingsWithEmployee?: number } }> => {
    const res = await apiClient.get<ApiResponse<IMtsSubscriber[]>>('/mts/subscribers');
    return { data: res.data, meta: (res.meta as never) ?? {} };
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

  // === Сотрудники с MTS-привязкой и треки для карты ===
  getEmployeesLinked: async (params: { page?: number; pageSize?: number; search?: string } = {}): Promise<{ data: IMtsEmployeeLinkedRow[]; total: number }> => {
    const qs = new URLSearchParams();
    if (params.page) qs.set('page', String(params.page));
    if (params.pageSize) qs.set('pageSize', String(params.pageSize));
    if (params.search) qs.set('search', params.search);
    const url = qs.toString() ? `/mts/employees-linked?${qs.toString()}` : '/mts/employees-linked';
    const res = await apiClient.get<ApiResponse<IMtsEmployeeLinkedRow[]>>(url);
    return { data: res.data, total: res.meta?.total ?? res.data.length };
  },

  getTrackPoints: async (subscriberId: number, dateFrom: string, dateTo: string): Promise<IMtsTrackPoint[]> => {
    const qs = new URLSearchParams({ subscriberId: String(subscriberId), dateFrom, dateTo });
    const res = await apiClient.get<ApiResponse<IMtsTrackPoint[]>>(`/mts/track-points?${qs.toString()}`);
    return res.data;
  },

  autoLinkMappings: async (): Promise<{ applied: number; suggestions: IMtsMappingSuggestion[] }> => {
    const res = await apiClient.post<ApiResponse<{ applied: number; suggestions: IMtsMappingSuggestion[] }>>(
      '/mts/mappings/auto-link',
      {},
    );
    return res.data;
  },

  // === Геозоны ===
  listGeofences: async (): Promise<IMtsGeofence[]> => {
    const res = await apiClient.get<ApiResponse<IMtsGeofence[]>>('/mts/geofences');
    return res.data;
  },

  createGeofence: async (input: { name: string; geometry: IGeoPoint[] }): Promise<IMtsGeofence> => {
    const res = await apiClient.post<ApiResponse<IMtsGeofence>>('/mts/geofences', input);
    return res.data;
  },

  updateGeofence: async (id: string, input: { name?: string; geometry?: IGeoPoint[]; isActive?: boolean }): Promise<IMtsGeofence> => {
    const res = await apiClient.put<ApiResponse<IMtsGeofence>>(`/mts/geofences/${id}`, input);
    return res.data;
  },

  deleteGeofence: async (id: string): Promise<void> => {
    await apiClient.delete(`/mts/geofences/${id}`);
  },

  setGeofenceAssignments: async (id: string, employeeIds: number[]): Promise<IMtsGeofence> => {
    const res = await apiClient.put<ApiResponse<IMtsGeofence>>(`/mts/geofences/${id}/assignments`, { employeeIds });
    return res.data;
  },

  setGeofenceObjects: async (id: string, skudObjectIds: string[]): Promise<IMtsGeofence> => {
    const res = await apiClient.put<ApiResponse<IMtsGeofence>>(`/mts/geofences/${id}/objects`, { skudObjectIds });
    return res.data;
  },

  getSkudObjectsLite: async (): Promise<ISkudObjectLite[]> => {
    const res = await apiClient.get<ApiResponse<ISkudObjectLite[]>>('/mts/skud-objects-lite');
    return res.data;
  },

  getObjectGeofences: async (objectId: string): Promise<IMtsGeofence[]> => {
    const res = await apiClient.get<ApiResponse<IMtsGeofence[]>>(`/mts/objects/${objectId}/geofences`);
    return res.data;
  },

  getSummary: async (): Promise<IMtsSummary> => {
    const res = await apiClient.get<ApiResponse<IMtsSummary>>('/mts/summary');
    return res.data;
  },

  getRawSubscriberDebug: async (): Promise<IMtsRawSubscriberDebug | null> => {
    const res = await apiClient.get<ApiResponse<IMtsRawSubscriberDebug | null>>('/mts/_debug/raw-subscriber');
    return res.data;
  },

  listGeofenceViolations: async (params: { employeeId?: number; from?: string; to?: string; page?: number; pageSize?: number } = {}): Promise<{ data: IMtsGeofenceViolation[]; total: number }> => {
    const qs = new URLSearchParams();
    if (params.employeeId) qs.set('employeeId', String(params.employeeId));
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    if (params.page) qs.set('page', String(params.page));
    if (params.pageSize) qs.set('pageSize', String(params.pageSize));
    const url = qs.toString() ? `/mts/violations?${qs.toString()}` : '/mts/violations';
    const res = await apiClient.get<ApiResponse<IMtsGeofenceViolation[]>>(url);
    return { data: res.data, total: res.meta?.total ?? res.data.length };
  },
};
