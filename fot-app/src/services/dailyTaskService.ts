import { apiClient } from '../api/client';

export interface IDailyTask {
  id: number;
  employee_id: number;
  task_date: string;
  content: string;
  created_at: string;
  updated_at: string;
}

interface ApiResponse<T> {
  data: T;
  success?: boolean;
}

export const dailyTaskService = {
  getMy: async (): Promise<IDailyTask[]> => {
    const res = await apiClient.get<ApiResponse<IDailyTask[]>>('/daily-tasks/my');
    return res.data;
  },

  getToday: async (): Promise<IDailyTask | null> => {
    const res = await apiClient.get<ApiResponse<IDailyTask | null>>('/daily-tasks/today');
    return res.data;
  },

  save: async (content: string): Promise<IDailyTask> => {
    const res = await apiClient.post<ApiResponse<IDailyTask>>('/daily-tasks', { content });
    return res.data;
  },
};
