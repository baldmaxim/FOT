import type { IResolvedSchedule } from './schedule';

// Timesheet types
export type TimesheetStatus = 'work' | 'absent' | 'vacation' | 'sick' | 'dayoff' | 'remote' | 'unpaid' | 'manual' | 'educational_leave' | 'sick_worked' | 'study_day';

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
  // Причина непокрытия смены (при presence_covers_shift=false): 'long_break' — span покрыл
  // смену, но перерывы превысили квоту обеда; 'short_span' — span меньше смены (опоздал/ушёл
  // рано/открытый вход), в т.ч. при одновременно превышенных перерывах.
  underwork_reason?: 'long_break' | 'short_span' | null;
  // true, если за день у сотрудника в БД есть object-adjustments (source_type='manual_object').
  // Такие корректировки нельзя удалить через DELETE /api/timesheet/:id — фронт по этому флагу
  // прячет кнопку «Снять корректировку» в day-modal режима «По сотрудникам».
  has_object_adjustments?: boolean;
  // Источник авторитетной корректировки: 'leave_request' (материализованная заявка),
  // 'manual', 'manual_object', 'legacy_tender_timesheet'. Отличает заявку «работа в выходной»
  // (status='work' + source_type='leave_request') от обычного дня → решает, показывать ли
  // кнопку «+ Удалёнка».
  source_type?: string | null;
  // Согласованный выход в выходной (leave_request/work), поверх которого лежит ведущая
  // корректировка «Удалёнка» (manual/remote). Заполнен ТОЛЬКО при сосуществовании обеих
  // записей → модалка рисует вторую (read-only) карточку «выход согласован».
  companion_work_request?: {
    id: number;
    approval_status: 'auto_approved' | 'pending' | 'approved' | 'rejected' | null;
    approved_at: string | null;
    approved_by_name: string | null;
    reason: string | null;
  } | null;
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

/** Элемент массового применения объектных правок (PUT /timesheet/object-entry/bulk). */
export interface TimesheetObjectEntryBulkItem {
  /** Обратная ссылка на ячейку клиента: сервер дедуплицирует и сортирует элементы,
   *  поэтому связывать ответ по индексу исходного массива нельзя. */
  client_item_id: string;
  employee_id: number;
  work_date: string;
  object_key: string;
  object_id?: string | null;
  object_name: string;
  hours_worked: number;
  notes?: string | null;
}

export interface TimesheetObjectEntryBulkResult {
  total_items: number;
  processed: number;
  succeeded: Array<{
    client_item_id: string | null;
    employee_id: number;
    work_date: string;
    object_key: string;
    adjustment_id: number | null;
    removed: boolean;
    approval_status: string | null;
  }>;
  failed: Array<{
    client_item_id: string | null;
    employee_id: number;
    work_date: string;
    object_key: string;
    status: number;
    code: string | null;
    error: string;
  }>;
  /** Вытесненные дубли (побеждает последний элемент), с id применённой строки. */
  duplicates: Array<{
    client_item_id: string | null;
    employee_id: number;
    work_date: string;
    object_key: string;
    status: 'duplicate';
    applied_client_item_id: string | null;
    adjustment_id: number | null;
  }>;
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
  /** Ключ строки сетки. Нужен режиму «По сотруднику»: у строк одного человека
   *  по разным отделам своя статистика. По умолчанию = String(employee_id). */
  row_key?: string;
  norm_hours: number;
  fact_hours: number;
  deviation_hours: number;
}

export type TimesheetEmployeeSource = 'department' | 'direct_report' | 'self' | 'supervisor' | 'skud_presence';

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
  /** Дата (включительно), С КОТОРОЙ сотрудник пришёл в отдел (нижняя граница при настоящем переводе/увольнении) — дни ДО неё рендерятся как inactive. */
  joined_date?: string | null;
  /** Источник появления в табеле: membership выбранного отдела, прямой подчинённый, либо сам руководитель. */
  source?: TimesheetEmployeeSource;
  /** false → сотрудник виден, но не редактируем (view-отдел, миграция 167). По умолчанию true. */
  editable?: boolean;
  /**
   * Уникальный ключ СТРОКИ сетки. Обычные режимы его не задают (ключ = id).
   * В режиме «По сотруднику» один человек занимает несколько строк — по одной на
   * отдел, — и они обязаны различаться. Для записи корректировок, графиков и
   * замков по-прежнему используется настоящий `id`, а не этот ключ.
   */
  row_key?: string;
  /** Период сотрудника в отделе недоступен по правам: строка без цифр и без правки. */
  is_restricted_period?: boolean;
}

/** Период работы сотрудника в отделе — строка режима «По сотруднику». */
export interface IEmployeeAssignmentPeriod {
  org_department_id: string;
  department_name: string | null;
  from: string;
  to: string;
  accessible: boolean;
  editable: boolean;
}

/** Найденный сотрудник в поиске режима «По сотруднику». */
export interface ITimesheetEmployeeSearchResult {
  id: number;
  full_name: string;
  department_name: string | null;
  employment_status: string | null;
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
  /** Период временно открыт для правок (null = закрыт). Статус подачи при этом не меняется. */
  unlocked_at?: string | null;
  unlocked_by_name?: string | null;
  unlock_reason?: string | null;
}

/** Замок закрытого табеля по конкретному сотруднику (интервал подачи, клипнутый периодом). */
export interface IEmployeeApprovalLock {
  employee_id: number;
  start_date: string;
  end_date: string;
  status: 'submitted' | 'approved';
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
  /** Замки по сотруднику. Пусто для is_admin — он правит закрытый период. */
  approval_locks?: IEmployeeApprovalLock[];
  /** Легаси-поле: плоский список дат. Оставлено на переходный релиз, не использовать. */
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

export interface IDepartmentSupervisor {
  department_id: string;
  kind: string;
  supervisor: { id: number; full_name: string } | null;
}
