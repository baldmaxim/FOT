import type { IResolvedSchedule } from './schedule';

// Timesheet types
export type TimesheetStatus = 'work' | 'absent' | 'vacation' | 'sick' | 'dayoff' | 'remote' | 'unpaid' | 'manual' | 'educational_leave';

export interface TimesheetEntry {
  id: number | null;
  employee_id: number;
  work_date: string;
  status: TimesheetStatus;
  hours_worked: number | null;
  display_hours_worked?: number | null;
  base_hours_worked?: number | null;
  travel_minutes_credited?: number;
  travel_hours_credited?: number;
  travel_delay_minutes?: number;
  travel_segments_count?: number;
  travel_problematic_segments?: number;
  is_correction: boolean;
  notes?: string | null;
  approval_status?: 'auto_approved' | 'pending' | 'approved' | 'rejected' | null;
  first_entry?: string | null;
  last_exit?: string | null;
  break_minutes?: number | null;
  corrected_by?: number | null;
  corrected_at?: string | null;
  corrected_by_name?: string | null;
  approved_at?: string | null;
  approved_by_name?: string | null;
  created_at?: string;
  updated_at?: string;
  object_detail_mode?: 'none' | 'available' | 'legacy_blocked';
  object_detail_message?: string | null;
  object_detail_count?: number;
  presence_covers_shift?: boolean;
  // true, если за день у сотрудника в БД есть object-adjustments (source_type='manual_object').
  // Такие корректировки нельзя удалить через DELETE /api/timesheet/:id — фронт по этому флагу
  // прячет кнопку «Снять корректировку» в day-modal режима «По сотрудникам».
  has_object_adjustments?: boolean;
}

export interface TimesheetObjectEntry {
  adjustment_id: number | null;
  employee_id: number;
  work_date: string;
  object_key: string;
  object_id: string | null;
  object_name: string;
  hours_worked: number;
  display_hours_worked: number;
  base_hours_worked: number;
  is_correction: boolean;
  approval_status?: 'auto_approved' | 'pending' | 'approved' | 'rejected' | null;
  notes?: string | null;
  // true — «эхо» day-level корректировки, размазанной на объект (модалка дня его прячет, #8).
  from_day_level?: boolean;
  // Автор/время объектной корректировки (#9).
  corrected_by_name?: string | null;
  corrected_at?: string | null;
}

export interface TimesheetTeamManagementConfig {
  enabled: boolean;
  can_manage: boolean;
  scope: 'self' | 'department' | 'all' | null;
}

export interface TimesheetTeamManagementCandidate {
  id: number;
  full_name: string;
  org_department_id: string | null;
  department_name: string | null;
  excluded_from_timesheet?: boolean;
}

export type ManagedDepartmentApprovalStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'returned';

export interface ManagedDepartmentTimesheetSummary {
  department_id: string;
  department_name: string;
  employee_count: number;
  norm_hours: number;
  actual_hours: number;
  deviations: { late: number; absent: number; sick: number };
  approval_status: ManagedDepartmentApprovalStatus | null;
  approvals: Array<{
    id: number;
    start_date: string;
    end_date: string;
    status: ManagedDepartmentApprovalStatus;
  }>;
  is_primary: boolean;
}

export interface TimesheetStats {
  employeeCount: number;
  workingDays: number;
  normHours: number;
  actualHours: number;
  deviations: { late: number; absent: number; sick: number };
}

export interface IEmployeeStats {
  employee_id: number;
  norm_hours: number;
  fact_hours: number;
  deviation_hours: number;
}

export type TimesheetEmployeeSource = 'department' | 'direct_report' | 'self';

export interface TimesheetEmployee {
  id: number;
  full_name: string;
  position_id: string | null;
  position_name: string | null;
  org_department_id: string | null;
  /** Имя отдела/бригады сотрудника — для деления строк по отделу в фильтре табеля. */
  department_name?: string | null;
  employment_status: 'active' | 'fired';
  /** Дата (включительно), с которой сотрудник скрыт по «Исключить» — после неё дни рендерятся как inactive. */
  excluded_from_timesheet_date?: string | null;
  /** Дата (включительно), с которой сотрудник переведён в другой отдел — после неё дни рендерятся как inactive с бейджем «Переведён». */
  transferred_out_date?: string | null;
  /** Источник появления в табеле: membership выбранного отдела, прямой подчинённый, либо сам руководитель. */
  source?: TimesheetEmployeeSource;
}

export interface IProductionCalendarMonth {
  year: number;
  month: number;
  norm_days: number;
  norm_hours: number;
  holidays: string[];
  mandatory_holidays: string[];
  pre_holidays: string[];
}

export interface ITimesheetDepartmentApprovalSummary {
  id: number;
  start_date: string;
  end_date: string;
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'returned';
}

export interface TimesheetResponse {
  employees: TimesheetEmployee[];
  entries: TimesheetEntry[];
  object_entries: TimesheetObjectEntry[];
  stats: TimesheetStats;
  employee_stats?: IEmployeeStats[];
  schedules?: Record<number, IResolvedSchedule>;
  daily_schedules?: Record<number, Record<string, IResolvedSchedule>>;
  schedule_catalog?: Record<string, IResolvedSchedule>;
  daily_schedule_ids?: Record<number, Record<string, string>>;
  calendar?: IProductionCalendarMonth | null;
  approvals?: ITimesheetDepartmentApprovalSummary[];
  approval_locked_dates?: string[];
}

export interface IAssignedEmployeeDepartment {
  id: string;
  name: string;
}

export interface IAssignedEmployeeSummary {
  id: number;
  full_name: string;
  department_count: number;
  direct_employee_count: number;
  email: string | null;
  departments?: IAssignedEmployeeDepartment[];
}
