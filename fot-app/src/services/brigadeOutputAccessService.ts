import { apiClient } from '../api/client';

interface IApiResponse<T> {
  success?: boolean;
  data: T;
}

/** Галочки вкладки «Выработка»: «Выработка» (342) и «Ставить КТУ своим бригадам» (370). */
export interface IBrigadeOutputAccess {
  granted: boolean;
  supervisor_ktu: boolean;
  /** Бригады, где сотрудник сейчас начальник участка: по ним показывается вторая галочка. */
  supervised_brigades: number;
}

/** Вкладка «Выработка» в панели назначений (миграция 342, 370): ввод выработки бригад и КТУ своих бригад. */
export const brigadeOutputAccessService = {
  /** Ошибка сети/сервера пробрасывается — не подменяется «нет доступа». Старый бэкенд — без второй галочки. */
  async get(employeeId: number): Promise<IBrigadeOutputAccess> {
    const res = await apiClient.get<IApiResponse<Partial<IBrigadeOutputAccess>>>(
      `/admin/employees/${employeeId}/brigade-output-access`,
    );
    return {
      granted: res.data.granted === true,
      supervisor_ktu: res.data.supervisor_ktu === true,
      supervised_brigades: Number(res.data.supervised_brigades ?? 0),
    };
  },

  /** Только изменённые галочки: поля нет — сервер его не трогает. */
  async set(employeeId: number, patch: { granted?: boolean; supervisor_ktu?: boolean }): Promise<void> {
    await apiClient.put<IApiResponse<{ granted: boolean; supervisor_ktu: boolean }>>(
      `/admin/employees/${employeeId}/brigade-output-access`,
      patch,
    );
  },
};
