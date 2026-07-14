import { apiClient } from '../api/client';

// Статистика МТС по отделу руководителя (вкладка «МТС» на странице «Обзор»).
// Отдельный эндпоинт, а не /mts-business/*: тот модуль закрыт ролями admin/mts_manager.
// В ответе нет номеров и нет денег — только агрегаты использования и ФИО.

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export type MtsUsageGroupKey = 'calls' | 'internet' | 'sms' | 'other';

export interface IMtsUsageGroup {
  key: MtsUsageGroupKey;
  count: number;
  /** Секунды — заполнены только у звонков. */
  seconds: number;
  /** Байты — заполнены только у интернета. */
  bytes: number;
  inCount: number;
  inSeconds: number;
  outCount: number;
  outSeconds: number;
}

export interface IMtsDeptEmployee {
  employeeId: number;
  fullName: string;
  tabNumber: string | null;
  /** Всегда 4 группы: calls, internet, sms, other. */
  groups: IMtsUsageGroup[];
}

export interface IDashboardMtsUsage {
  period: string;
  dateFrom: string;
  dateTo: string;
  departmentId: string;
  employeesWithSim: number;
  syncedAt: string | null;
  totals: IMtsUsageGroup[];
  employees: IMtsDeptEmployee[];
}

export const dashboardMtsService = {
  getDepartmentUsage: async (departmentId: string, month: string): Promise<IDashboardMtsUsage> => {
    const params = new URLSearchParams({ department_id: departmentId, month });
    const res = await apiClient.get<ApiResponse<IDashboardMtsUsage>>(`/dashboard/mts-usage?${params}`);
    return res.data;
  },
};
