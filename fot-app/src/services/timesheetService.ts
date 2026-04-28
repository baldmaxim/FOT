import { apiClient, buildApiUrl, buildAuthHeaders } from '../api/client';
import type {
  IAssignedEmployeeSummary,
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
  half?: TimesheetExportHalf;
  from?: string; // YYYY-MM-DD (приоритетнее half)
  to?: string;
}

type TimesheetExportHalf = 'H1' | 'H2' | 'FULL';
type TimesheetExportGrouping = 'employees' | 'objects';
type TimesheetExportPresentation = 'hr' | 'manager';

interface TimesheetExportFilters extends TimesheetFilters {
  half?: TimesheetExportHalf;
  presentation?: TimesheetExportPresentation;
}

interface ApiResponse<T> {
  data?: T;
  message?: string;
  error?: string;
}

interface BulkTimesheetCorrectionResult {
  processed: number;
  employees: number;
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
  author_name: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
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

export interface ITimesheetRefreshResult {
  sync: {
    sigurTotal?: number;
    imported?: number;
    skipped?: number;
    errors_count?: number;
    matched?: number;
  } | null;
  conflicts: Array<{ employee_id: number; work_date: string; skud_minutes: number }>;
}

export const timesheetService = {
  async getAll(filters: TimesheetFilters): Promise<TimesheetResponse> {
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
    const res = await apiClient.get<ApiResponse<TimesheetResponse>>(`/timesheet?${params.toString()}`);
    if (!res.data) throw new Error(res.error || 'Ошибка загрузки табеля');
    return res.data;
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

  async refresh(payload: { start_date: string; end_date: string }): Promise<ITimesheetRefreshResult> {
    const res = await apiClient.post<ApiResponse<ITimesheetRefreshResult>>('/timesheet/refresh', payload);
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
    effective_date?: string;
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

  async updateTransfer(assignmentId: string, effectiveFrom: string): Promise<void> {
    const res = await apiClient.patch<ApiResponse<null>>(
      `/timesheet/team-management/transfers/${assignmentId}`,
      { effective_from: effectiveFrom },
    );
    if (res.error) throw new Error(res.error || 'Ошибка изменения даты перевода');
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
};
