import { apiClient } from '../api/client';

/** Персональный доступ к разделу «Зарплата» (миграция 288). null — «Нет доступа». */
export type PayrollAccessLevel = 'view' | 'edit' | null;

interface ApiResponse<T> {
  success?: boolean;
  data: T;
}

const normalizeLevel = (value: unknown): PayrollAccessLevel => (
  value === 'view' || value === 'edit' ? value : null
);

export const payrollAccessService = {
  /** Текущий уровень сотрудника. Ошибка сети/сервера пробрасывается — не подменяется «Нет доступа». */
  async get(employeeId: number): Promise<PayrollAccessLevel> {
    const res = await apiClient.get<ApiResponse<{ level: unknown }>>(
      `/admin/employees/${employeeId}/payroll-access`,
    );
    return normalizeLevel(res.data?.level);
  },

  /** Выдать, сменить или снять (null) доступ. */
  async set(employeeId: number, level: PayrollAccessLevel): Promise<void> {
    await apiClient.put<ApiResponse<{ level: unknown }>>(
      `/admin/employees/${employeeId}/payroll-access`,
      { level },
    );
  },
};
