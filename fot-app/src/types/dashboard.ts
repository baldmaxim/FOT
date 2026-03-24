// Dashboard / UI types

export interface INavItem {
  id: string;
  label: string;
  icon: string;
  badge?: number;
}

export interface INavGroup {
  label: string;
  items: INavItem[];
}

export interface IStatCard {
  label: string;
  value: string;
  change?: string;
  changeType?: 'positive' | 'negative';
  iconType: 'blue' | 'green' | 'orange';
}

export interface IActivityItem {
  id: string;
  name: string;
  role: string;
  location: string;
  status: 'in' | 'out' | 'late';
  time: string;
  initials: string;
}

export interface IProgressItem {
  id: string;
  label: string;
  current: number;
  total: number;
}

export interface IQuickAction {
  id: string;
  label: string;
  icon: string;
}

// Dashboard analytics
export interface IPeriodStats {
  avgPresent: number;
  avgAbsent: number;
  attendanceRate: number;
  lateCount: number;
  prevLateCount: number;
}

export type DashboardPeriod = 'today' | 'week' | 'month';

export interface IRecentEvent {
  time: string;
  name: string;
  accessPoint: string;
  direction: 'entry' | 'exit' | null;
}

export interface IDashboardStats {
  lateToday: number;
  lateYesterday: number;
  punctuality: { onTime: number; slightlyLate: number; veryLate: number; absent: number };
  avgArrivalByDay: Array<{ day: string; avgTime: string | null; date: string; isToday?: boolean }>;
  risks: Array<{ employee_id: number; full_name: string; reason: string; severity: 'high' | 'medium' }>;
  hourlyActivity: Array<{ hour: number; count: number }>;
  weekComparison: {
    thisWeek: { attendanceRate: number; avgArrival: string; avgHours: number; lateCount: number };
    lastWeek: { attendanceRate: number; avgArrival: string; avgHours: number; lateCount: number };
  } | null;
  topLate: Array<{ employee_id: number; full_name: string; lateCount: number; avgArrival: string }>;
  periodStats: IPeriodStats | null;
  earlyLeaveToday: number;
  recentEvents: IRecentEvent[];
  anomalies: { refusals: number; multipleEntry: number };
  todayEntriesCount: number;
  todayExitsCount: number;
}
