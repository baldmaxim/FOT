import { apiClient } from '../api/client';
import type { StaffTab } from '../types/auth';

interface IApiResponse<T> {
  success?: boolean;
  data: T;
}

/** Вкладки «Проживание» и «Удержания» в панели назначений (миграция 351): правка вкладки кадров по всей организации. */
export const staffTabAccessService = {
  /** Ошибка сети/сервера пробрасывается — не подменяется «нет доступа». */
  async get(tab: StaffTab, employeeId: number): Promise<boolean> {
    const res = await apiClient.get<IApiResponse<{ granted: boolean }>>(`/admin/employees/${employeeId}/${tab}-access`);
    return res.data.granted === true;
  },

  async set(tab: StaffTab, employeeId: number, granted: boolean): Promise<void> {
    await apiClient.put<IApiResponse<{ granted: boolean }>>(`/admin/employees/${employeeId}/${tab}-access`, { granted });
  },
};
