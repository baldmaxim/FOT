import type { IPayrollCalcLine, PayrollCalcMissing } from '../services/payrollService';
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
  /** Часы проставлены корректировкой (положительная правка часов) — авторитетны для 1С и переработки. */
  hours_overridden?: boolean;
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

export type TimesheetEmployeeSource =
  | 'department' | 'direct_report' | 'direct_report_covered' | 'self' | 'supervisor' | 'skud_presence'
  | 'view_only';

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
   * «Просмотр табеля» (миграция 309): табель открыт пользователю только на чтение. Окно дня
   * открывается без правки и без файлов, выгрузки детализации нет.
   */
  view_only?: boolean;
  /** Уволен в месяце периода: виден в портале (show_fired), но в подачу и 1С не идёт. */
  excluded_from_submission?: boolean;
  /**
   * Даты, за которые табель ведёт руководитель отдела сотрудника, а не текущий
   * пользователь. У полностью покрытых строка и так `editable: false`; массив нужен
   * частично покрытым — переведённым внутри периода: их непокрытые дни правятся
   * как обычно, покрытые заблокированы.
   */
  covered_dates?: string[] | null;
  /**
   * Уникальный ключ СТРОКИ сетки. Обычные режимы его не задают (ключ = id).
   * В режиме «По сотруднику» один человек занимает несколько строк — по одной на
   * отдел, — и они обязаны различаться. Для записи корректировок, графиков и
   * замков по-прежнему используется настоящий `id`, а не этот ключ.
   */
  row_key?: string;
  /** Период сотрудника в отделе недоступен по правам: строка без цифр и без правки. */
  is_restricted_period?: boolean;
  /** Объект табелирования за месяц табеля: «Офис», имя объекта или null (миграция 288). */
  timesheet_object_label?: string | null;
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
  /** Замки по сотруднику. Приходят ВСЕМ, включая is_admin: закрытый табель не правит никто. */
  approval_locks?: IEmployeeApprovalLock[];
  /** Легаси-поле: плоский список дат. Оставлено на переходный релиз, не использовать. */
  approval_locked_dates?: string[];
  /**
   * Можно ли ПИСАТЬ в выбранный отдел (meta.department_writable сервера).
   * true только когда открыт ровно один отдел из табельно-редактируемого скоупа:
   * право на страницу /timesheet само по себе записи не даёт.
   */
  department_writable?: boolean;
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

/** «Табель → Зарплата»: состояние сумм бригады (миграция 330). */
export type TimesheetSalaryState = 'preliminary' | 'fixed' | 'stale';
export type TimesheetSalaryDistribution = 'ok' | 'no_output' | 'nothing_to_distribute' | 'error';
/** object_config — разбивку по объектам собрать нельзя (режим «объект» без закреплённого объекта). */
export type TimesheetSalaryErrorCode = 'unknown_status' | 'no_schedule' | 'duplicate_day' | 'object_config';
/**
 * Объект бригады: no_output — выработка не внесена; nothing_to_distribute — внесена, учтённых часов нет; by_brigade —
 * выработка внесена одной суммой на бригаду (341), объект только для показа часов.
 */
export type TimesheetSalaryObjectState = 'ok' | 'no_output' | 'nothing_to_distribute' | 'by_brigade';
/** Как внесена выработка бригады: по объектам или одной суммой на бригаду (341) — не обе сразу. */
export type TimesheetSalaryOutputMode = 'objects' | 'brigade';

/** Строка вкладки «Табель → Бригады»: бригада месяца и внесённая выработка. */
export interface ITimesheetBrigadeOutputItem {
  department_id: string;
  name: string;
  is_active: boolean;
  /** Сумма бригаде; null — не внесена. */
  brigade_output: string | null;
  /** Σ выработки по объектам; null — не внесена ни на одном. */
  objects_output: string | null;
  objects_with_output: number;
}

export interface ITimesheetSalaryRow {
  employee_id: number;
  /** ФИО — у бригады (группы по объектам рисуются без сетки табеля); у отдела null. */
  full_name?: string | null;
  /** КТУ для выбора ('1.0' по умолчанию); у отделов null. */
  ktu: string | null;
  counted_hours: number | null;
  /** К выплате: начислено − удержания, без НДФЛ, с копейками строкой; null — суммы нет. */
  amount: string | null;
  /** Доля «Выработки» по КТУ (бригада); нет у старого бэкенда. */
  share?: string | null;
  /** Учтённые удержания месяца. */
  deducted?: string | null;
  /** Отдел, табель закрыт или расчёт предварительный: «По трудовому договору» (оклад по дням); нет у старого бэкенда. */
  contract?: IPayrollCalcLine | null;
  /** Отдел, табель закрыт или расчёт предварительный: «Переработка»; null — переработки нет. */
  overtime?: IPayrollCalcLine | null;
  /** Чего в сумме нет: отпускные, выработка бригады и т. п. */
  missing?: PayrollCalcMissing[];
  /**
   * Отдел: closed — табель месяца закрыт; preliminary — не закрыт, суммы по живому табелю на as_of ответа;
   * not_closed — суммы нет. У бригады — null.
   */
  payout_state?: 'closed' | 'preliminary' | 'not_closed' | null;
  source: 'version' | 'live' | null;
  can_edit: boolean;
}

export interface ITimesheetSalaryError {
  employee_id: number;
  full_name: string;
  code: TimesheetSalaryErrorCode;
  /** null — ошибка настройки сотрудника (object_config), не дня. */
  date: string | null;
}

/** Рабочий в группе объекта «Зарплаты по объектам» (миграция 336). */
export interface ITimesheetSalaryObjectMember {
  employee_id: number;
  /** Часы по дням на объекте: 'YYYY-MM-DD' → часы. */
  days: Record<string, number>;
  hours: number;
  /** Учтённые минуты на объекте — по ним доля. */
  counted_minutes: number;
  /** КТУ в десятых × учтённые минуты. */
  weight: number;
  /** Доля на объекте; null — нет. */
  share: string | null;
}

/** Группа «Зарплаты по объектам»: объект бригады, его выработка и рабочие. */
export interface ITimesheetSalaryObject {
  object_key: string;
  object_name: string;
  output_amount: string | null;
  state: TimesheetSalaryObjectState;
  total_hours: number;
  /** Σ весов объекта — точный знаменатель долей (КТУ в десятых × минуты). */
  total_weight: number;
  members: ITimesheetSalaryObjectMember[];
}

export interface ITimesheetSalaryResponse {
  department_id: string;
  month: string;
  kind: 'brigade' | 'department';
  state: TimesheetSalaryState | null;
  distribution: TimesheetSalaryDistribution | null;
  as_of: string | null;
  open_ranges: Array<{ start_date: string; end_date: string }>;
  /** Внесённая выработка: сумма бригаде или Σ по объектам; null — ничего не внесено. */
  output_amount: string | null;
  /** Как внесена выработка (по ней — поля ввода); у отдела и у старого бэкенда — null / нет. */
  output_mode?: TimesheetSalaryOutputMode | null;
  /** Сумма бригаде (341); null — не внесена. */
  brigade_output?: string | null;
  errors: ITimesheetSalaryError[];
  computed_at: string | null;
  rows: ITimesheetSalaryRow[];
  /** Группы по объектам — только у бригады (нет у старого бэкенда). */
  objects?: ITimesheetSalaryObject[];
}
