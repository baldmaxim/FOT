/** Типы для СКУД-модуля */

export interface ISkudEventRow {
  physical_person: string;
  card_number: string | null;
  event_date: string;
  event_time: string;
  event_at: string;
  access_point: string | null;
  direction: 'entry' | 'exit' | null;
  employee_id: number | null;
  dedup_hash: string;
}

export interface IDailySummaryRow {
  id: number;
  employee_id: number;
  date: string;
  first_entry: string | null;
  last_exit: string | null;
  total_hours: number | null;
  is_present: boolean;
}

export interface IDashboardStatsParams {
  departmentId: string;
  period: string;
  month?: string; // YYYY-MM — конкретный месяц (только для period=month)
  // Per-role «Факт / Урезанные часы» (system_roles.show_actual_hours):
  // true → hours_worked (фактические по СКУД), false → display_hours_worked
  // (cap по длине смены через attendance.service). Совпадает с логикой
  // /api/timesheet, чтобы цифры на дашборде и в табеле не расходились.
  showActualHours: boolean;
  // Bypass server-side dashboardCache при ручном refresh с фронта.
  force?: boolean;
  // Объектный view-скоуп (миграция 167 + объекты): если задан, сотрудники отдела
  // дополнительно сужаются до этого набора (отделы ∩ объекты руководителя).
  allowedEmployeeIds?: Set<number>;
}

export interface IDashboardRecentEvent {
  time: string;
  name: string;
  accessPoint: string;
  direction: 'entry' | 'exit' | null;
  isInternal: boolean;
}

export interface IDashboardRisk {
  employee_id: number;
  full_name: string;
  reason: string;
  severity: 'high' | 'medium';
}

export interface IDashboardTopLate {
  employee_id: number;
  full_name: string;
  lateCount: number;
  avgArrival: string;
  lateDetails: Array<{ date: string; arrival: string }>;
}

export interface IDashboardWeekMetrics {
  attendanceRate: number;
  avgArrival: string;
  avgHours: number;
  lateCount: number;
}

export interface IDashboardPeriodStats {
  avgPresent: number;
  avgAbsent: number;
  attendanceRate: number;
  lateCount: number;
  prevLateCount: number;
}

export interface IDashboardStatsResult {
  lateToday: number;
  lateYesterday: number;
  punctuality: { onTime: number; slightlyLate: number; veryLate: number; absent: number };
  avgArrivalByDay: { day: string; avgTime: string | null; date: string; isToday: boolean }[];
  risks: IDashboardRisk[];
  weekComparison: { thisWeek: IDashboardWeekMetrics; lastWeek: IDashboardWeekMetrics } | null;
  topLate: IDashboardTopLate[];
  periodStats: IDashboardPeriodStats | null;
  earlyLeaveToday: number;
  recentEvents: IDashboardRecentEvent[];
  todayEntriesCount: number;
  todayExitsCount: number;
}

export interface IPresenceParams {
  departmentId: string | null;
}

export interface IPresenceItem {
  employee_id: number;
  full_name: string;
  department_name: string | null;
  position_name: string | null;
  status: 'online' | 'offline' | 'unknown';
  since: string | null;
  first_entry: string | null;
  total_hours: number | null;
  exit_count: number;
  time_outside_minutes: number;
  last_access_point: string | null;
  punctuality_percent: number | null;
}

export interface IDisciplineParams {
  startMonth: string;
  endMonth: string;
}

export interface IDisciplineViolation {
  employee_id: number;
  date: string;
  type: 'late' | 'underwork' | 'early' | 'absence';
  first_entry: string | null;
  last_exit: string | null;
  total_hours: number | null;
  deviation: string;
}

export interface IDisciplineResult {
  violations: IDisciplineViolation[];
  employees: Record<number, { full_name: string; position: string | null; department_id: string | null }>;
  departments: Record<string, string>;
}

export interface IImportParams {
  fileBuffer: Buffer;
  userId: string;
}

export interface IImportResult {
  imported: number;
  matched: number;
  errors: string[];
}

export interface ISyncEmployeeParams {
  employeeId: number;
  startDate: string;
  endDate: string;
  connection?: 'external' | 'internal';
  userId: string;
}

export interface ICleanDuplicatesResult {
  hashesUpdated: number;
  duplicatesDeleted: number;
}

export interface IClearParams {
  startDate?: string;
  endDate?: string;
  userId: string;
}

export interface IAccessPointSettingsRow {
  access_point_name: string;
  is_internal: boolean;
}

export interface IAccessPointOption {
  name: string;
  id: number | null;
}

export interface ISaveAccessPointSettingsParams {
  departmentId: string | null;
  settings: { access_point_name: string; is_internal: boolean }[];
}

export interface ISyncAccessPointsResult {
  accessPoints: string[];
  removed: string[];
  settingsRemoved: number;
}

export interface IEmployeeEventsParams {
  employeeId: number;
  startDate: unknown;
  endDate: unknown;
  isSelfRequest: boolean;
}

export interface IEventsParams {
  startDate: unknown;
  endDate: unknown;
  accessPoint: unknown;
  employeeId: unknown;
  search: unknown;
}

export interface ISkudEventResult {
  id: number;
  physical_person: string;
  card_number: string | null;
  event_date: string;
  event_time: string;
  access_point: string | null;
  direction: string | null;
  employee_id: number | null;
}
