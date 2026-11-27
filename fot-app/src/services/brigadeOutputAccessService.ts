import { apiClient } from '../api/client';

interface IApiResponse<T> {
  success?: boolean;
  data: T;
}

/**
 * Галочки вкладки «Выработка»: «Выработка» (342), «Ставить КТУ своим бригадам» (370) и «Видеть зарплату своих
 * сотрудников в табеле» (382).
 */
export interface IBrigadeOutputAccess {
  granted: boolean;
  supervisor_ktu: boolean;
  /** Бригады, где сотрудник сейчас начальник участка: по ним показывается вторая галочка. */
  supervised_brigades: number;
  team_salary: boolean;
  /** Отделы, где сотрудник руководитель (ручные full-привязки): по ним третья галочка и подпись под ней. */
  managed_departments: string[];
}

export interface IBrigadeOutputAccessPatch {
  granted?: boolean;
  supervisor_ktu?: boolean;
  team_salary?: boolean;
}

/**
 * Вкладка «Выработка» в панели назначений (миграции 342, 370, 382): ввод выработки бригад, КТУ своих бригад и зарплата
 * своих сотрудников в табеле.
 */
export const brigadeOutputAccessService = {
  /** Ошибка сети/сервера пробрасывается — не подменяется «нет доступа». Старый бэкенд — без второй и третьей галочки. */
  async get(employeeId: number): Promise<IBrigadeOutputAccess> {
    const res = await apiClient.get<IApiResponse<Partial<IBrigadeOutputAccess>>>(
      `/admin/employees/${employeeId}/brigade-output-access`,
    );
    return {
      granted: res.data.granted === true,
      supervisor_ktu: res.data.supervisor_ktu === true,
      supervised_brigades: Number(res.data.supervised_brigades ?? 0),
      team_salary: res.data.team_salary === true,
      managed_departments: Array.isArray(res.data.managed_departments) ? res.data.managed_departments : [],
    };
  },

  /** Только изменённые галочки: поля нет — сервер его не трогает. */
  async set(employeeId: number, patch: IBrigadeOutputAccessPatch): Promise<void> {
    await apiClient.put<IApiResponse<{ granted: boolean; supervisor_ktu: boolean; team_salary: boolean }>>(
      `/admin/employees/${employeeId}/brigade-output-access`,
      patch,
    );
  },
};
