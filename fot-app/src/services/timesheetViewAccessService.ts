import { apiClient } from '../api/client';

/** Сотрудник, чей табель открыт смотрящему только на чтение («Просмотр табеля», миграция 309). */
export interface ITimesheetViewAssignment {
  employee_id: number;
  full_name: string;
  employment_status: string | null;
}

interface ApiResponse<T> {
  success?: boolean;
  data: T;
}

export const timesheetViewAccessService = {
  /** Кого смотрит сотрудник. Ошибка сети/сервера пробрасывается — не подменяется пустым списком. */
  async list(viewerEmployeeId: number): Promise<ITimesheetViewAssignment[]> {
    const res = await apiClient.get<ApiResponse<ITimesheetViewAssignment[]>>(
      `/admin/employees/${viewerEmployeeId}/timesheet-view-employees`,
    );
    return res.data ?? [];
  },

  /** Полная замена списка. */
  async replace(viewerEmployeeId: number, employeeIds: number[]): Promise<void> {
    await apiClient.put<ApiResponse<ITimesheetViewAssignment[]>>(
      `/admin/employees/${viewerEmployeeId}/timesheet-view-employees`,
      { employee_ids: employeeIds },
    );
  },
};
