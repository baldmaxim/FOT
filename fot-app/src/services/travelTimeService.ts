import { apiClient } from '../api/client';
import type {
  IAccessPointMapView,
  ITravelConfig,
  ITravelObject,
  ITravelObjectMap,
  ITravelObjectMapPoint,
  ITravelRoute,
  ITravelSegment,
  TravelSegmentStatus,
} from '../types';

interface ApiResponse<T> {
  data?: T;
  message?: string;
  error?: string;
}

const TRAVEL_SEGMENTS_CACHE_TTL_MS = 60_000;

const travelSegmentsCache = new Map<string, {
  data: ITravelSegment[];
  expiresAt: number;
}>();

const travelSegmentsInFlight = new Map<string, Promise<ITravelSegment[]>>();

const buildTravelSegmentsCacheKey = (filters: {
  month: string;
  department_id?: string;
  employee_id?: number;
  status?: TravelSegmentStatus | 'problem' | 'all';
}): string => (
  [
    filters.month,
    filters.department_id || 'all-departments',
    typeof filters.employee_id === 'number' ? String(filters.employee_id) : 'all-employees',
    filters.status || 'all-statuses',
  ].join('|')
);

const invalidateTravelSegmentsCache = (): void => {
  travelSegmentsCache.clear();
  travelSegmentsInFlight.clear();
};

export const travelTimeService = {
  async getConfig(): Promise<ITravelConfig> {
    const res = await apiClient.get<ApiResponse<ITravelConfig>>('/skud/travel-config');
    return res.data || { limit_minutes: null };
  },

  async saveConfig(data: { limit_minutes: number }): Promise<ITravelConfig> {
    const res = await apiClient.put<ApiResponse<ITravelConfig>>('/skud/travel-config', data);
    if (!res.data) throw new Error(res.error || 'Ошибка сохранения лимита передвижения');
    invalidateTravelSegmentsCache();
    return res.data;
  },

  async getObjects(): Promise<ITravelObject[]> {
    const res = await apiClient.get<ApiResponse<ITravelObject[]>>('/skud/travel-objects');
    return res.data || [];
  },

  async createObject(name: string): Promise<ITravelObject> {
    const res = await apiClient.post<ApiResponse<ITravelObject>>('/skud/travel-objects', { name });
    if (!res.data) throw new Error(res.error || 'Ошибка создания объекта');
    return res.data;
  },

  async updateObject(id: string, data: { name: string; access_points: string[] }): Promise<ITravelObject> {
    const res = await apiClient.put<ApiResponse<ITravelObject>>(`/skud/travel-objects/${id}`, data);
    if (!res.data) throw new Error(res.error || 'Ошибка сохранения объекта');
    return res.data;
  },

  async deleteObject(id: string): Promise<void> {
    await apiClient.delete<ApiResponse<null>>(`/skud/travel-objects/${id}`);
  },

  async getObjectMap(id: string): Promise<ITravelObjectMap> {
    const res = await apiClient.get<ApiResponse<ITravelObjectMap>>(`/skud/travel-objects/${id}/map`);
    if (!res.data) throw new Error(res.error || 'Ошибка загрузки карты объекта');
    return res.data;
  },

  async getObjectMapUploadUrl(id: string, data: {
    file_name: string;
    content_type: string;
    file_size: number;
  }): Promise<{ upload_url: string; storage_path: string }> {
    const res = await apiClient.post<ApiResponse<{ upload_url: string; storage_path: string }>>(
      `/skud/travel-objects/${id}/map/upload-url`,
      data,
    );
    if (!res.data) throw new Error(res.error || 'Ошибка подготовки загрузки карты');
    return res.data;
  },

  async uploadObjectMapFile(uploadUrl: string, file: File): Promise<void> {
    const formData = new FormData();
    formData.append('cacheControl', '3600');
    formData.append('', file);

    const response = await fetch(uploadUrl, {
      method: 'PUT',
      body: formData,
      headers: {
        'x-upsert': 'true',
      },
    });

    if (!response.ok) {
      throw new Error('Не удалось загрузить файл карты в Supabase Storage');
    }
  },

  async confirmObjectMapUpload(id: string, data: {
    storage_path: string;
    file_name: string;
    content_type: string;
    file_size: number;
  }): Promise<ITravelObjectMap> {
    const res = await apiClient.post<ApiResponse<ITravelObjectMap>>(`/skud/travel-objects/${id}/map/confirm`, data);
    if (!res.data) throw new Error(res.error || 'Ошибка подтверждения карты объекта');
    return res.data;
  },

  async saveObjectMapPoints(id: string, points: ITravelObjectMapPoint[]): Promise<ITravelObjectMap> {
    const res = await apiClient.put<ApiResponse<ITravelObjectMap>>(`/skud/travel-objects/${id}/map-points`, { points });
    if (!res.data) throw new Error(res.error || 'Ошибка сохранения маркеров карты');
    return res.data;
  },

  async deleteObjectMap(id: string): Promise<void> {
    await apiClient.delete<ApiResponse<null>>(`/skud/travel-objects/${id}/map`);
  },

  async getAccessPointMap(accessPointName: string): Promise<IAccessPointMapView | null> {
    const params = new URLSearchParams({ access_point_name: accessPointName });
    const res = await apiClient.get<ApiResponse<IAccessPointMapView | null>>(`/skud/access-point-map?${params.toString()}`);
    return res.data ?? null;
  },

  async getRoutes(): Promise<ITravelRoute[]> {
    const res = await apiClient.get<ApiResponse<ITravelRoute[]>>('/skud/travel-routes');
    return res.data || [];
  },

  async createRoute(data: { from_object_id: string; to_object_id: string; travel_minutes: number }): Promise<ITravelRoute> {
    const res = await apiClient.post<ApiResponse<ITravelRoute>>('/skud/travel-routes', data);
    if (!res.data) throw new Error(res.error || 'Ошибка создания маршрута');
    return res.data;
  },

  async updateRoute(id: string, data: { from_object_id: string; to_object_id: string; travel_minutes: number }): Promise<ITravelRoute> {
    const res = await apiClient.put<ApiResponse<ITravelRoute>>(`/skud/travel-routes/${id}`, data);
    if (!res.data) throw new Error(res.error || 'Ошибка сохранения маршрута');
    return res.data;
  },

  async deleteRoute(id: string): Promise<void> {
    await apiClient.delete<ApiResponse<null>>(`/skud/travel-routes/${id}`);
  },

  async getSegments(filters: {
    month: string;
    department_id?: string;
    employee_id?: number;
    status?: TravelSegmentStatus | 'problem' | 'all';
  }): Promise<ITravelSegment[]> {
    const cacheKey = buildTravelSegmentsCacheKey(filters);
    const cached = travelSegmentsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    const inFlight = travelSegmentsInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const params = new URLSearchParams();
    params.append('month', filters.month);
    if (filters.department_id) params.append('department_id', filters.department_id);
    if (typeof filters.employee_id === 'number') params.append('employee_id', String(filters.employee_id));
    if (filters.status && filters.status !== 'all') params.append('status', filters.status);

    const loadPromise = apiClient
      .get<ApiResponse<ITravelSegment[]>>(`/skud/travel-segments?${params.toString()}`)
      .then(res => {
        const data = res.data || [];
        travelSegmentsCache.set(cacheKey, {
          data,
          expiresAt: Date.now() + TRAVEL_SEGMENTS_CACHE_TTL_MS,
        });
        return data;
      })
      .finally(() => {
        travelSegmentsInFlight.delete(cacheKey);
      });

    travelSegmentsInFlight.set(cacheKey, loadPromise);
    return loadPromise;
  },

  async rebuildSegments(filters: { month: string; department_id?: string; employee_id?: number }): Promise<{ segmentCount: number; employeeCount: number }> {
    const res = await apiClient.post<ApiResponse<{ segmentCount: number; employeeCount: number }>>('/skud/travel-segments/rebuild', filters);
    if (!res.data) throw new Error(res.error || 'Ошибка пересчёта передвижений');
    invalidateTravelSegmentsCache();
    return res.data;
  },

  async getDaySegments(employeeId: number, workDate: string): Promise<ITravelSegment[]> {
    const params = new URLSearchParams({
      employee_id: String(employeeId),
      work_date: workDate,
    });
    const res = await apiClient.get<ApiResponse<ITravelSegment[]>>(
      `/skud/travel-segments/day?${params.toString()}`,
    );
    return res.data || [];
  },

  async approveSegment(segmentId: string, comment?: string): Promise<ITravelSegment> {
    const res = await apiClient.post<ApiResponse<ITravelSegment>>(
      `/skud/travel-segments/${segmentId}/approve`,
      comment ? { comment } : {},
    );
    if (!res.data) throw new Error(res.error || 'Ошибка подтверждения сегмента');
    invalidateTravelSegmentsCache();
    return res.data;
  },

  async rejectSegment(segmentId: string, comment?: string): Promise<ITravelSegment> {
    const res = await apiClient.post<ApiResponse<ITravelSegment>>(
      `/skud/travel-segments/${segmentId}/reject`,
      comment ? { comment } : {},
    );
    if (!res.data) throw new Error(res.error || 'Ошибка отклонения сегмента');
    invalidateTravelSegmentsCache();
    return res.data;
  },
};
