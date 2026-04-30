import { apiClient } from '../api/client';
import type {
  IWorkSchedule,
  IResolvedSchedule,
  IEmployeeScheduleAssignment,
  IObjectScheduleAssignment,
} from '../types/schedule';

interface ApiResponse<T> {
  data?: T;
  message?: string;
  error?: string;
}

export interface IBulkBrigadeSchedulePayload {
  department_ids: string[];
  action: 'assign' | 'reset';
  schedule_id?: string;
  effective_date: string;
}

export interface IBulkBrigadeScheduleResult {
  departments_processed: number;
  employees_matched: number;
  employees_updated: number;
}

export const scheduleService = {
  /** Список шаблонов графиков */
  async list(): Promise<IWorkSchedule[]> {
    const res = await apiClient.get<ApiResponse<IWorkSchedule[]>>('/schedules');
    if (!res.data) throw new Error(res.error || 'Ошибка загрузки графиков');
    return res.data;
  },

  /** Создать шаблон */
  async create(data: Omit<IWorkSchedule, 'id' | 'is_default' | 'created_at' | 'updated_at'>): Promise<IWorkSchedule> {
    const res = await apiClient.post<ApiResponse<IWorkSchedule>>('/schedules', data);
    if (!res.data) throw new Error(res.error || 'Ошибка создания графика');
    return res.data;
  },

  /** Обновить шаблон */
  async update(id: string, data: Partial<IWorkSchedule>): Promise<IWorkSchedule> {
    const res = await apiClient.put<ApiResponse<IWorkSchedule>>(`/schedules/${id}`, data);
    if (!res.data) throw new Error(res.error || 'Ошибка обновления графика');
    return res.data;
  },

  /** Удалить шаблон */
  async remove(id: string): Promise<void> {
    const res = await apiClient.delete<ApiResponse<null>>(`/schedules/${id}`);
    if (res.error) throw new Error(res.error);
  },

  /** Resolve для одного сотрудника */
  async resolve(empId: number, date?: string): Promise<IResolvedSchedule> {
    const params = date ? `?date=${date}` : '';
    const res = await apiClient.get<ApiResponse<IResolvedSchedule>>(`/schedules/resolve/${empId}${params}`);
    if (!res.data) throw new Error(res.error || 'Ошибка определения графика');
    return res.data;
  },

  /** Активные персональные графики сотрудников */
  async listEmployeeAssignments(employeeIds: number[]): Promise<IEmployeeScheduleAssignment[]> {
    if (employeeIds.length === 0) return [];
    const params = new URLSearchParams();
    params.set('employee_ids', employeeIds.join(','));
    const res = await apiClient.get<ApiResponse<IEmployeeScheduleAssignment[]>>(`/schedules/employees?${params.toString()}`);
    if (!res.data) throw new Error(res.error || 'Ошибка загрузки графиков сотрудников');
    return res.data;
  },

  /** Все привязки графиков к объектам */
  async listObjectAssignments(): Promise<IObjectScheduleAssignment[]> {
    const res = await apiClient.get<ApiResponse<IObjectScheduleAssignment[]>>('/schedules/objects');
    if (!res.data) throw new Error(res.error || 'Ошибка загрузки графиков объектов');
    return res.data;
  },

  /** Назначить персональный график сотруднику */
  async assignEmployee(
    employeeId: number,
    data: { schedule_id: string; effective_from: string; effective_to?: string | null },
  ): Promise<IEmployeeScheduleAssignment> {
    const res = await apiClient.put<ApiResponse<IEmployeeScheduleAssignment>>(`/schedules/employee/${employeeId}`, data);
    if (!res.data) throw new Error(res.error || 'Ошибка назначения графика сотруднику');
    return res.data;
  },

  /** Назначить график объекту */
  async assignObject(
    objectId: string,
    data: { schedule_id: string; effective_from: string; effective_to?: string | null },
  ): Promise<IObjectScheduleAssignment> {
    const res = await apiClient.put<ApiResponse<IObjectScheduleAssignment>>(`/schedules/object/${objectId}`, data);
    if (!res.data) throw new Error(res.error || 'Ошибка назначения графика объекту');
    return res.data;
  },

  /** Снять персональный график сотрудника */
  async removeEmployeeAssignment(employeeId: number, effectiveTo?: string): Promise<void> {
    const query = effectiveTo ? `?effective_to=${encodeURIComponent(effectiveTo)}` : '';
    const res = await apiClient.delete<ApiResponse<null>>(`/schedules/employee/${employeeId}${query}`);
    if (res.error) throw new Error(res.error);
  },

  /** Снять график объекта */
  async removeObjectAssignment(objectId: string, effectiveTo?: string): Promise<void> {
    const query = effectiveTo ? `?effective_to=${encodeURIComponent(effectiveTo)}` : '';
    const res = await apiClient.delete<ApiResponse<null>>(`/schedules/object/${objectId}${query}`);
    if (res.error) throw new Error(res.error);
  },

  /** Массово назначить или снять персональный график сотрудникам выбранных бригад */
  async bulkApplyToBrigades(data: IBulkBrigadeSchedulePayload): Promise<IBulkBrigadeScheduleResult> {
    const res = await apiClient.post<ApiResponse<IBulkBrigadeScheduleResult>>('/schedules/brigades/bulk', data);
    if (!res.data) throw new Error(res.error || 'Ошибка массового назначения графика по бригадам');
    return res.data;
  },
};
