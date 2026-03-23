/** Типы для СКУД-модуля */

export interface ISkudEventRow {
  organization_id: string;
  physical_person: string;
  card_number: string | null;
  event_date: string;
  event_time: string;
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
  organizationId: string | undefined;
  departmentId: string;
  period: string;
}

export interface IDashboardRecentEvent {
  time: string;
  name: string;
  accessPoint: string;
  direction: 'entry' | 'exit' | null;
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
  hourlyActivity: { hour: number; count: number }[];
  weekComparison: { thisWeek: IDashboardWeekMetrics; lastWeek: IDashboardWeekMetrics } | null;
  topLate: IDashboardTopLate[];
  periodStats: IDashboardPeriodStats | null;
  earlyLeaveToday: number;
  recentEvents: IDashboardRecentEvent[];
  anomalies: { refusals: number; multipleEntry: number };
  todayEntriesCount: number;
  todayExitsCount: number;
}

export interface IPresenceParams {
  organizationId: string | undefined;
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
  organizationId: string | undefined;
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
  organizationId: string;
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
  organizationId: string | undefined;
  connection?: 'external' | 'internal';
  userId: string;
}

export interface ICleanDuplicatesResult {
  hashesUpdated: number;
  duplicatesDeleted: number;
}

export interface IClearParams {
  organizationId: string;
  startDate?: string;
  endDate?: string;
  userId: string;
}

export interface IAccessPointSettingsRow {
  access_point_name: string;
  is_internal: boolean;
}

export interface ISaveAccessPointSettingsParams {
  organizationId: string | undefined;
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
  organizationId: string | undefined;
  startDate: unknown;
  endDate: unknown;
  isSelfRequest: boolean;
}

export interface IEventsParams {
  organizationId: string | undefined;
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
