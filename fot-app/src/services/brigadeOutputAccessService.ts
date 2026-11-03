import { apiClient } from '../api/client';

interface IApiResponse<T> {
  success?: boolean;
  data: T;
}

/** Вкладка «Выработка» в панели назначений (миграция 342): ввод выработки бригад и «Зарплата по объектам». */
export const brigadeOutputAccessService = {
  /** Ошибка сети/сервера пробрасывается — не подменяется «нет доступа». */
  async get(employeeId: number): Promise<boolean> {
    const res = await apiClient.get<IApiResponse<{ granted: boolean }>>(
      `/admin/employees/${employeeId}/brigade-output-access`,
    );
    return res.data.granted === true;
  },

  async set(employeeId: number, granted: boolean): Promise<void> {
    await apiClient.put<IApiResponse<{ granted: boolean }>>(
      `/admin/employees/${employeeId}/brigade-output-access`,
      { granted },
    );
  },
};
