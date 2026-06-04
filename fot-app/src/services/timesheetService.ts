import { apiClient, buildApiUrl, buildAuthHeaders } from '../api/client';
import type {
  IAssignedEmployeeSummary,
  IDepartmentSupervisor,
  ManagedDepartmentTimesheetSummary,
  TimesheetEntry,
  TimesheetObjectEntry,
  TimesheetResponse,
  TimesheetStatus,
  TimesheetTeamManagementCandidate,
  TimesheetTeamManagementConfig,
} from '../types';

interface TimesheetFilters {
  month: string; // YYYY-MM
  department_id?: string;
  employee_id?: number;
  // employee_ids: явный список сотрудников (HR-режим для персональной подачи руководителя).
  // При указании игнорируются dept/direct-reports фильтры.
  employee_ids?: number[];
  half?: TimesheetExportHalf;
  from?: string; // YYYY-MM-DD (приоритетнее half)
  to?: string;
  include_objects?: boolean;
  schedule_payload?: 'full' | 'compact';
}

type TimesheetExportHalf = 'H1' | 'H2' | 'FULL';
type TimesheetExportGrouping = 'employees' | 'objects';
type TimesheetExportPresentation = 'hr' | 'manager';

interface TimesheetExportFilters extends TimesheetFilters {
  half?: TimesheetExportHalf;
  presentation?: TimesheetExportPresentation;
  export_as_1c?: boolean;
}

interface ApiResponse<T> {
  data?: T;
  message?: string;
  error?: string;
}

export interface IWeekendMemoEntry {
  employee_id: number;
  full_name: string;
  work_dates: string[];
}

export interface IWeekendMemoPreview {
  entries: IWeekendMemoEntry[];
  weekend_dates: string[];
}

interface BulkTimesheetCorrectionResult {
  processed: number;
  employees: number;
  items?: Array<{ employee_id: number; work_date: string; adjustment_id: number }>;
}

function hydrateCompactSchedules(data: TimesheetResponse): TimesheetResponse {
  if (
    data.daily_schedules
    || !data.schedule_catalog
    || !data.daily_schedule_ids
  ) {
    return data;
  }

  const dailySchedules: NonNullable<TimesheetResponse['daily_schedules']> = {};
  for (const [employeeId, byDate] of Object.entries(data.daily_schedule_ids)) {
    dailySchedules[Number(employeeId)] = {};
    for (const [date, scheduleId] of Object.entries(byDate)) {
      const schedule = data.schedule_catalog[scheduleId];
      if (schedule) {
        dailySchedules[Number(employeeId)][date] = schedule;
      }
    }
  }

  return {
    ...data,
    daily_schedules: dailySchedules,
  };
}

export interface ITimesheetCorrectionRow {
  id: number;
  employee_id: number;
  employee_full_name: string | null;
  work_date: string;
  status: TimesheetStatus;
  hours_override: number | null;
  source_type: string;
  reason: string | null;
  approval_comment?: string | null;
  attachments_count?: number;
  author_name: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  approved_at?: string | null;
  approver_name?: string | null;
  can_edit: boolean;
  can_delete: boolean;
  approval_locked: boolean;
  month_out_of_range?: boolean;
}

export interface IDepartmentTransferRow {
  assignment_new_id: string;
  assignment_old_id: string;
  employee_id: number;
  employee_full_name: string;
  to_department_id: string;
  to_department_name: string;
  transfer_date: string;
}

export interface IDepartmentExclusionRow {
  employee_id: number;
  employee_full_name: string;
  exclusion_date: string | null;
  excluded_at: string | null;
}

export interface IDepartmentTransfersListing {
  transfers: IDepartmentTransferRow[];
  exclusions: IDepartmentExclusionRow[];
}

export interface IAdminTransferRow extends IDepartmentTransferRow {
  from_department_id: string;
  from_department_name: string;
  employee_position: string | null;
}

export interface IAdminExclusionRow extends IDepartmentExclusionRow {
  department_id: string | null;
  department_name: string;
  employee_position: string | null;
}

export interface IAdminTransfersListing {
  transfers: IAdminTransferRow[];
  exclusions: IAdminExclusionRow[];
}

export interface IAdminTransfersFilters {
  from?: string;
  to?: string;
  department_id?: string;
  employee_query?: string;
}

export interface ITimesheetRefreshResult {
  recalculated_summaries: number;
  reapproved: number;
  conflicts: Array<{ employee_id: number; work_date: string; skud_minutes: number }>;
}

export interface ITimesheetRefreshOptions {
  signal?: AbortSignal;
}

export interface ICorrectionEligibilityRestrictions {
  corrections_anomalies_only: boolean;
  corrections_cap_by_schedule_norm: boolean;
  corrections_allow_zero_short_attendance: boolean;
  corrections_disable_bulk: boolean;
  max_corrections_per_month: number | null;
}

export interface ICorrectionEligibilityForEmployee {
  anomaly_dates: string[];
  short_attendance_dates: string[];
  anomaly_used: number;
}

export interface ICorrectionEligibilityResponse {
  restrictions: ICorrectionEligibilityRestrictions;
  by_employee: Record<string, ICorrectionEligibilityForEmployee>;
}

export const timesheetService = {
  async getAll(filters: TimesheetFilters): Promise<TimesheetResponse> {
    const params = new URLSearchParams();
    params.append('month', filters.month);
    if (filters.department_id) params.append('department_id', filters.department_id);
    if (filters.employee_id) params.append('employee_id', String(filters.employee_id));
    if (filters.employee_ids && filters.employee_ids.length > 0) {
      params.append('employee_ids', filters.employee_ids.join(','));
    }
    if (filters.from && filters.to) {
      params.append('from', filters.from);
      params.append('to', filters.to);
    } else if (filters.half) {
      params.append('half', filters.half);
    }
    params.append('include_objects', filters.include_objects ? '1' : '0');
    params.append('schedule_payload', filters.schedule_payload ?? 'compact');
    const res = await apiClient.get<ApiResponse<TimesheetResponse>>(`/timesheet?${params.toString()}`);
    if (!res.data) throw new Error(res.error || 'Ошибка загрузки табеля');
    return hydrateCompactSchedules(res.data);
  },

  async getOverview(filters: {
    month: string;
    half?: TimesheetExportHalf;
    from?: string;
    to?: string;
  }): Promise<ManagedDepartmentTimesheetSummary[]> {
    const params = new URLSearchParams();
    params.append('month', filters.month);
    if (filters.from && filters.to) {
      params.append('from', filters.from);
      params.append('to', filters.to);
    } else if (filters.half) {
      params.append('half', filters.half);
    }
    const res = await apiClient.get<ApiResponse<ManagedDepartmentTimesheetSummary[]>>(`/timesheet/overview?${params.toString()}`);
    if (!res.data) throw new Error(res.error || 'Ошибка загрузки обзора табелей');
    return res.data;
  },

  async create(data: {
    employee_id: number;
    work_date: string;
    status: TimesheetStatus;
    hours_worked?: number | null;
    notes?: string | null;
    // Явный объект корректировки — присылается после ответа OBJECT_REQUIRED.
    object_id?: string | null;
  }): Promise<TimesheetEntry> {
    const res = await apiClient.post<ApiResponse<TimesheetEntry>>('/timesheet', data);
    if (!res.data) throw new Error(res.error || 'Ошибка создания записи');
    return res.data;
  },

  async update(
    id: number,
    data: Partial<Pick<TimesheetEntry, 'status' | 'hours_worked' | 'notes'>>,
  ): Promise<TimesheetEntry> {
    const res = await apiClient.put<ApiResponse<TimesheetEntry>>(`/timesheet/${id}`, data);
    if (!res.data) throw new Error(res.error || 'Ошибка обновления записи');
    return res.data;
  },

  async delete(id: number): Promise<void> {
    const res = await apiClient.request<ApiResponse<null>>(`/timesheet/${id}`, { method: 'DELETE' });
    if (res.error) throw new Error(res.error);
  },

  async listCorrections(filters: { start_date: string; end_date: string; department_id?: string }): Promise<ITimesheetCorrectionRow[]> {
    const params = new URLSearchParams();
    params.append('start_date', filters.start_date);
    params.append('end_date', filters.end_date);
    if (filters.department_id) params.append('department_id', filters.department_id);
    const res = await apiClient.get<ApiResponse<ITimesheetCorrectionRow[]>>(`/timesheet/corrections?${params.toString()}`);
    if (!res.data) throw new Error(res.error || 'Ошибка загрузки корректировок');
    return res.data;
  },

  async refresh(
    payload: { start_date: string; end_date: string },
    options?: ITimesheetRefreshOptions,
  ): Promise<ITimesheetRefreshResult> {
    const res = await apiClient.post<ApiResponse<ITimesheetRefreshResult>>(
      '/timesheet/refresh',
      payload,
      options?.signal ? { signal: options.signal } : undefined,
    );
    if (!res.data) throw new Error(res.error || 'Ошибка обновления табеля');
    return res.data;
  },

  async bulkCorrect(data: {
    items: Array<{
      employee_id: number;
      work_date: string;
    }>;
    status: TimesheetStatus;
    hours_worked?: number | null;
    notes?: string | null;
  }): Promise<BulkTimesheetCorrectionResult> {
    const res = await apiClient.post<ApiResponse<BulkTimesheetCorrectionResult>>('/timesheet/bulk', data);
    if (!res.data) throw new Error(res.error || 'Ошибка массового обновления табеля');
    return res.data;
  },

  async upsertObjectEntry(data: {
    employee_id: number;
    work_date: string;
    object_key: string;
    object_id?: string | null;
    object_name: string;
    hours_worked: number;
    notes?: string | null;
  }): Promise<TimesheetObjectEntry> {
    const res = await apiClient.put<ApiResponse<TimesheetObjectEntry>>('/timesheet/object-entry', data);
    if (!res.data) throw new Error(res.error || 'Ошибка сохранения строки объекта');
    return res.data;
  },

  async deleteObjectEntry(data: {
    employee_id: number;
    work_date: string;
    object_key: string;
  }): Promise<void> {
    const res = await apiClient.request<ApiResponse<null>>('/timesheet/object-entry', {
      method: 'DELETE',
      body: JSON.stringify(data),
    });
    if (res.error) throw new Error(res.error || 'Ошибка удаления строки объекта');
  },

  async getTeamManagementConfig(): Promise<TimesheetTeamManagementConfig> {
    const res = await apiClient.get<ApiResponse<TimesheetTeamManagementConfig>>('/timesheet/team-management-config');
    if (!res.data) throw new Error(res.error || 'Ошибка загрузки настроек управления составом табеля');
    return res.data;
  },

  async searchTeamEmployees(filters: {
    department_id: string;
    q: string;
  }): Promise<TimesheetTeamManagementCandidate[]> {
    const params = new URLSearchParams();
    params.append('department_id', filters.department_id);
    params.append('q', filters.q);
    const res = await apiClient.get<ApiResponse<TimesheetTeamManagementCandidate[]>>(`/timesheet/team-management/search-employees?${params.toString()}`);
    if (!res.data) throw new Error(res.error || 'Ошибка поиска сотрудников');
    return res.data;
  },

  async addEmployeeToDepartment(data: {
    employee_id: number;
    department_id: string;
    effective_from: string;
  }): Promise<void> {
    const res = await apiClient.post<ApiResponse<null>>('/timesheet/team-management/add-employee', data);
    if (res.error) throw new Error(res.error || 'Ошибка добавления сотрудника');
  },

  async excludeEmployeeFromDepartment(data: {
    employee_id: number;
    department_id: string;
    effective_date: string;
  }): Promise<void> {
    const res = await apiClient.post<ApiResponse<null>>('/timesheet/team-management/exclude-employee', data);
    if (res.error) throw new Error(res.error || 'Ошибка исключения сотрудника');
  },

  async listDepartmentTransfers(departmentId: string): Promise<IDepartmentTransfersListing> {
    const params = new URLSearchParams({ department_id: departmentId });
    const res = await apiClient.get<ApiResponse<IDepartmentTransfersListing>>(`/timesheet/team-management/transfers?${params.toString()}`);
    if (!res.data) throw new Error(res.error || 'Ошибка загрузки списка переводов');
    return res.data;
  },

  async listAllTransfersAndExclusions(filters: IAdminTransfersFilters): Promise<IAdminTransfersListing> {
    const params = new URLSearchParams();
    if (filters.from) params.append('from', filters.from);
    if (filters.to) params.append('to', filters.to);
    if (filters.department_id) params.append('department_id', filters.department_id);
    if (filters.employee_query) params.append('employee_query', filters.employee_query);
    const qs = params.toString();
    const url = qs ? `/timesheet/admin/transfers?${qs}` : '/timesheet/admin/transfers';
    const res = await apiClient.get<ApiResponse<IAdminTransfersListing>>(url);
    if (!res.data) throw new Error(res.error || 'Ошибка загрузки списка переводов');
    return res.data;
  },

  async updateTransfer(
    assignmentId: string,
    patch: {
      effective_from?: string;
      to_department_id?: string;
      from_department_id?: string;
      assignment_old_id?: string;
    },
  ): Promise<void> {
    const body: Record<string, string> = {};
    if (patch.effective_from) body.effective_from = patch.effective_from;
    if (patch.to_department_id) body.to_department_id = patch.to_department_id;
    if (patch.from_department_id) body.from_department_id = patch.from_department_id;
    if (patch.assignment_old_id) body.assignment_old_id = patch.assignment_old_id;
    const res = await apiClient.patch<ApiResponse<null>>(
      `/timesheet/team-management/transfers/${assignmentId}`,
      body,
    );
    if (res.error) throw new Error(res.error || 'Ошибка изменения перевода');
  },

  async deleteTransfer(assignmentId: string): Promise<void> {
    const res = await apiClient.request<ApiResponse<null>>(
      `/timesheet/team-management/transfers/${assignmentId}`,
      { method: 'DELETE' },
    );
    if (res.error) throw new Error(res.error || 'Ошибка отмены перевода');
  },

  async updateExclusion(employeeId: number, effectiveDate: string): Promise<void> {
    const res = await apiClient.patch<ApiResponse<null>>(
      `/timesheet/team-management/exclusions/${employeeId}`,
      { effective_date: effectiveDate },
    );
    if (res.error) throw new Error(res.error || 'Ошибка изменения даты исключения');
  },

  async deleteExclusion(employeeId: number): Promise<void> {
    const res = await apiClient.request<ApiResponse<null>>(
      `/timesheet/team-management/exclusions/${employeeId}`,
      { method: 'DELETE' },
    );
    if (res.error) throw new Error(res.error || 'Ошибка отмены исключения');
  },

  async exportMass(filters: {
    month: string;
    department_ids: string[];
    half?: TimesheetExportHalf;
    from?: string;
    to?: string;
    group_by?: TimesheetExportGrouping;
    presentation?: TimesheetExportPresentation;
    export_as_1c?: boolean;
  }): Promise<Blob> {
    const response = await fetch(
      buildApiUrl('/timesheet/export-mass'),
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...buildAuthHeaders(),
        },
        body: JSON.stringify(filters),
      }
    );
    if (!response.ok) throw new Error('Ошибка массового экспорта');
    return response.blob();
  },

  async exportMassUnified(filters: {
    month: string;
    department_ids: string[];
    half?: TimesheetExportHalf;
    from?: string;
    to?: string;
  }): Promise<Blob> {
    const response = await fetch(
      buildApiUrl('/timesheet/export-mass-unified'),
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...buildAuthHeaders(),
        },
        body: JSON.stringify(filters),
      }
    );
    if (!response.ok) throw new Error('Ошибка единого экспорта для 1С');
    return response.blob();
  },

  async listObjects(): Promise<Array<{ id: string; name: string; alt_name: string | null }>> {
    const res = await apiClient.get<{
      success: boolean;
      data: Array<{ id: string; name: string; alt_name: string | null }>;
    }>('/timesheet/objects');
    if (!res.success || !Array.isArray(res.data)) {
      throw new Error('Ошибка загрузки объектов');
    }
    return res.data;
  },

  async exportObjectsUnified(filters: {
    month: string;
    object_ids: string[];
    half?: TimesheetExportHalf;
    from?: string;
    to?: string;
    department_ids?: string[];
  }): Promise<Blob> {
    const response = await fetch(
      buildApiUrl('/timesheet/export-objects-unified'),
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...buildAuthHeaders(),
        },
        body: JSON.stringify(filters),
      }
    );
    if (!response.ok) throw new Error('Ошибка экспорта табелей по объектам');
    return response.blob();
  },

  async exportAssigned(filters: {
    month: string;
    half?: TimesheetExportHalf;
    from?: string;
    to?: string;
    group_by?: TimesheetExportGrouping;
    presentation?: TimesheetExportPresentation;
    export_as_1c?: boolean;
    employee_ids?: number[];
  }): Promise<Blob> {
    const response = await fetch(
      buildApiUrl('/timesheet/export-assigned'),
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...buildAuthHeaders(),
        },
        body: JSON.stringify(filters),
      }
    );
    if (!response.ok) throw new Error('Ошибка экспорта назначенных');
    return response.blob();
  },

  async listAssignedEmployees(): Promise<IAssignedEmployeeSummary[]> {
    const res = await apiClient.get<ApiResponse<IAssignedEmployeeSummary[]>>('/timesheet/assigned-employees');
    if (!res.data) throw new Error(res.error || 'Ошибка загрузки назначенных сотрудников');
    return res.data;
  },

  async getDepartmentSupervisor(departmentId: string): Promise<IDepartmentSupervisor> {
    const res = await apiClient.get<ApiResponse<IDepartmentSupervisor>>(
      `/timesheet/department-supervisor?department_id=${encodeURIComponent(departmentId)}`,
    );
    if (!res.data) throw new Error(res.error || 'Ошибка загрузки начальника участка');
    return res.data;
  },

  /**
   * Превью: кто и за какие даты попадёт в шаблон служебной записки.
   * Источник тот же, что и у generateWeekendMemo — корректировки status='work' на выходные.
   */
  async getWeekendMemoPreview(params: {
    department_id: string;
    start_date: string;
    end_date: string;
  }): Promise<IWeekendMemoPreview> {
    const qs = new URLSearchParams({
      department_id: params.department_id,
      start_date: params.start_date,
      end_date: params.end_date,
    });
    const res = await apiClient.get<{ entries: IWeekendMemoEntry[]; weekend_dates: string[]; success?: boolean }>(
      `/timesheet/weekend-memo/preview?${qs.toString()}`,
    );
    return {
      entries: res.entries ?? [],
      weekend_dates: res.weekend_dates ?? [],
    };
  },

  /**
   * Сгенерировать .xlsx-шаблон служебной записки о работе в выходные.
   * Бэк сам соберёт сотрудников и даты по корректировкам status='work' на выходные.
   */
  async generateWeekendMemo(payload: {
    department_id: string;
    start_date: string;
    end_date: string;
    reason: string;
  }): Promise<Blob> {
    const response = await fetch(buildApiUrl('/timesheet/weekend-memo/generate'), {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...buildAuthHeaders(),
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Ошибка формирования служебной записки' }));
      throw new Error(err.error || 'Ошибка формирования служебной записки');
    }
    return response.blob();
  },

  async emailAssigned(filters: {
    month: string;
    half?: string;
    from?: string;
    to?: string;
    group_by?: string;
    presentation?: string;
    export_as_1c?: boolean;
    employee_ids?: number[];
  }): Promise<{ sent: number; failed: number; errors: string[]; skipped: number }> {
    const res = await apiClient.post<ApiResponse<{ sent: number; failed: number; errors: string[]; skipped: number }>>(
      '/timesheet/email-assigned',
      filters,
    );
    if (!res.data) throw new Error(res.error || 'Ошибка отправки email');
    return res.data;
  },

  async export(filters: TimesheetExportFilters): Promise<Blob> {
    const params = new URLSearchParams();
    params.append('month', filters.month);
    if (filters.department_id) params.append('department_id', filters.department_id);
    if (filters.employee_id) params.append('employee_id', String(filters.employee_id));
    if (filters.from && filters.to) {
      params.append('from', filters.from);
      params.append('to', filters.to);
    } else if (filters.half) {
      params.append('half', filters.half);
    }
    if (filters.presentation) params.append('presentation', filters.presentation);
    if (filters.export_as_1c) params.append('export_as_1c', 'true');

    const response = await fetch(
      buildApiUrl(`/timesheet/export?${params.toString()}`),
      {
        credentials: 'include',
        headers: buildAuthHeaders(),
      }
    );

    if (!response.ok) throw new Error('Ошибка экспорта');
    return response.blob();
  },

  /**
   * Доступность корректировок для ролей с включёнными «Ограничениями корректировок».
   * Для остальных ролей возвращает пустой `by_employee` — фронт может проверить флаги в `restrictions`
   * и не дёргать эндпоинт повторно.
   */
  async getCorrectionEligibility(params: {
    employee_ids: number[];
    start: string;
    end: string;
  }): Promise<ICorrectionEligibilityResponse> {
    const query = new URLSearchParams();
    query.append('employee_ids', params.employee_ids.join(','));
    query.append('start', params.start);
    query.append('end', params.end);
    const res = await apiClient.get<ApiResponse<ICorrectionEligibilityResponse>>(
      `/timesheet/correction-eligibility?${query.toString()}`,
    );
    if (!res.data) throw new Error(res.error || 'Не удалось получить доступность корректировок');
    return res.data;
  },
};
