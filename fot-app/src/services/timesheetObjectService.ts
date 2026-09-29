import { apiClient } from '../api/client';

/** Пункт списка выбора: value — 'office' или id объекта. */
export interface ITimesheetObjectOption {
  value: string;
  label: string;
}

/** Объект табелирования сотрудника (миграция 288). */
export interface ITimesheetObjectState {
  label: string | null;
  value: string | null;
  can_change: boolean;
  options: ITimesheetObjectOption[];
}

interface IStateResponse {
  success?: boolean;
  data: ITimesheetObjectState;
}

export const timesheetObjectService = {
  /** Свой объект (ЛК). */
  getMine: async (): Promise<ITimesheetObjectState> => {
    const res = await apiClient.get<IStateResponse>('/timesheet-object/me');
    return res.data;
  },

  updateMine: async (value: string): Promise<ITimesheetObjectState> => {
    const res = await apiClient.put<IStateResponse>('/timesheet-object/me', { value });
    return res.data;
  },

  /** Объект сотрудника — для того, кто ведёт его табель. */
  getForEmployee: async (employeeId: number): Promise<ITimesheetObjectState> => {
    const res = await apiClient.get<IStateResponse>(`/timesheet-object/employees/${employeeId}`);
    return res.data;
  },

  updateForEmployee: async (employeeId: number, value: string): Promise<ITimesheetObjectState> => {
    const res = await apiClient.put<IStateResponse>(`/timesheet-object/employees/${employeeId}`, { value });
    return res.data;
  },
};
