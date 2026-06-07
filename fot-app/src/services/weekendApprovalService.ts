import { apiClient } from '../api/client';

/** Сотрудник-кандидат для назначения ответственного за выходные (whitelist + роль). */
export interface IWeekendEligibleEmployee {
  employee_id: number;
  full_name: string | null;
  position_name: string | null;
  department_id: string | null;
  department_name: string | null;
  role_code: string | null;
  /** Текущий ответственный (employee_id) — явно по сотруднику или по его отделу. null — свободен. */
  responsible_employee_id: number | null;
}

export interface IWeekendResponsibleData {
  department_ids: string[];
  employee_ids: number[];
  /** Карты «таргет → ответственный (employee_id)» по всем активным назначениям. */
  assignments: {
    departments: Record<string, number>;
    employees: Record<string, number>;
  };
}

export interface IWeekendSetConflict {
  kind: 'department' | 'employee';
  id: string | number;
  ownerEmployeeId: number;
}

interface ApiResponse<T> {
  success?: boolean;
  data: T;
}

export const weekendApprovalService = {
  /** Назначения конкретного ответственного + карта всех назначений. */
  async getByResponsible(responsibleEmployeeId: number): Promise<IWeekendResponsibleData> {
    const res = await apiClient.get<ApiResponse<IWeekendResponsibleData>>(
      `/admin/weekend-approvals/${responsibleEmployeeId}`,
    );
    return res.data ?? { department_ids: [], employee_ids: [], assignments: { departments: {}, employees: {} } };
  },

  /** Полная замена активных таргетов ответственного. Возвращает конфликты (занятые другим). */
  async setByResponsible(
    responsibleEmployeeId: number,
    input: { departmentIds: string[]; employeeIds: number[] },
  ): Promise<{ conflicts: IWeekendSetConflict[] }> {
    const res = await apiClient.put<ApiResponse<{ conflicts: IWeekendSetConflict[] }>>(
      `/admin/weekend-approvals/${responsibleEmployeeId}`,
      { department_ids: input.departmentIds, employee_ids: input.employeeIds },
    );
    return res.data ?? { conflicts: [] };
  },

  /** Кандидаты-сотрудники (whitelist-отделы, подходящие роли). unassigned=true → «Свободные». */
  async listEligible(onlyUnassigned = false): Promise<IWeekendEligibleEmployee[]> {
    const res = await apiClient.get<ApiResponse<IWeekendEligibleEmployee[]>>(
      `/admin/weekend-approvals/eligible${onlyUnassigned ? '?unassigned=1' : ''}`,
    );
    return res.data ?? [];
  },
};
