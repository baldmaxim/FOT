import { apiClient } from '../api/client';
import type { ITravelObject, ITravelRoute, ITravelSegment, TravelSegmentStatus } from '../types';

interface ApiResponse<T> {
  data?: T;
  message?: string;
  error?: string;
}

export const travelTimeService = {
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
    const params = new URLSearchParams();
    params.append('month', filters.month);
    if (filters.department_id) params.append('department_id', filters.department_id);
    if (typeof filters.employee_id === 'number') params.append('employee_id', String(filters.employee_id));
    if (filters.status && filters.status !== 'all') params.append('status', filters.status);

    const res = await apiClient.get<ApiResponse<ITravelSegment[]>>(`/skud/travel-segments?${params.toString()}`);
    return res.data || [];
  },

  async rebuildSegments(filters: { month: string; department_id?: string; employee_id?: number }): Promise<{ segmentCount: number; employeeCount: number }> {
    const res = await apiClient.post<ApiResponse<{ segmentCount: number; employeeCount: number }>>('/skud/travel-segments/rebuild', filters);
    if (!res.data) throw new Error(res.error || 'Ошибка пересчёта передвижений');
    return res.data;
  },
};
