import { apiClient } from '../api/client';

export interface IProductionCalendarEntry {
  id: number;
  year: number;
  month: number;
  norm_days: number;
  norm_hours: number;
  is_custom: boolean;
  updated_by: number | null;
  updated_at: string;
  holidays: string[];
  mandatory_holidays: string[];
  pre_holidays: string[];
}

export interface IProductionCalendarUpdate {
  norm_days: number;
  norm_hours: number;
  holidays?: string[];
  mandatory_holidays?: string[];
  pre_holidays?: string[];
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

const getByYear = async (year: number): Promise<IProductionCalendarEntry[]> => {
  const res = await apiClient.get<ApiResponse<IProductionCalendarEntry[]>>(`/production-calendar?year=${year}`);
  return res.data || [];
};

const update = async (year: number, month: number, data: IProductionCalendarUpdate): Promise<IProductionCalendarEntry> => {
  const res = await apiClient.put<ApiResponse<IProductionCalendarEntry>>(`/production-calendar/${year}/${month}`, data);
  return res.data;
};

export const productionCalendarService = { getByYear, update };
