import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { pgQuery, pgQueryOne, pgExecute, pgTx } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  pgExecute: vi.fn(),
  pgTx: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: pgExecute,
  withTransaction: pgTx,
}));

type QueryCall = {
  sql: string;
  params: unknown[];
  table: 'employees' | 'skud_daily_summary' | 'skud_events' | 'skud_events_recent' | 'unknown';
  offset?: number;
  limit?: number;
};

type EmployeeRow = {
  id: number;
  full_name: string;
  org_department_id: string;
  is_archived: boolean;
  employment_status: string;
};

type SummaryRow = {
  employee_id: number;
  date: string;
  first_entry: string | null;
  last_exit: string | null;
  total_hours: number | null;
  is_present: boolean;
};

type EventRow = {
  employee_id: number;
  event_date: string;
  event_time: string;
  physical_person: string | null;
  access_point: string | null;
  direction: 'entry' | 'exit';
};

const mockedState = vi.hoisted(() => ({
  queryLog: [] as Array<{
    sql: string;
    params: unknown[];
    table: 'employees' | 'skud_daily_summary' | 'skud_events' | 'skud_events_recent' | 'unknown';
    offset?: number;
    limit?: number;
  }>,
  employees: [] as EmployeeRow[],
  summaryRows: [] as SummaryRow[],
  eventRows: [] as EventRow[],
  internalPoints: new Set<string>(),
}));

function getMonday(date: Date): Date {
  const next = new Date(date);
  const day = next.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  next.setDate(next.getDate() + diff);
  return next;
}

function countWorkingDays(startStr: string, endStr: string): number {
  let count = 0;
  const current = new Date(`${startStr}T00:00:00`);
  const end = new Date(`${endStr}T00:00:00`);
  while (current <= end) {
    const dow = current.getDay();
    if (dow !== 0 && dow !== 6) count++;
    current.setDate(current.getDate() + 1);
  }
  return count;
}

vi.mock('./skud-shared.service.js', () => ({
  collectDeptIds: vi.fn(async (departmentId: string) => [departmentId]),
  getMonday,
  DAY_NAMES: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт'],
  countWorkingDays,
  getInternalAccessPoints: vi.fn(async () => mockedState.internalPoints),
}));

vi.mock('./schedule.service.js', () => ({
  resolveSchedulesBulk: vi.fn(async () => new Map()),
  resolveSchedulesForPeriod: vi.fn(async () => new Map()),
  loadCalendarMonth: vi.fn(async () => null),
  getEffectiveLateThreshold: vi.fn(() => '09:00:00'),
  getScheduleForDate: vi.fn(() => ({ work_start: '09:00:00', work_hours: 8 })),
  needsSkudCheck: vi.fn(() => true),
}));

vi.mock('./attendance.service.js', () => ({
  buildAttendanceEntries: vi.fn(async () => ({
    entries: [],
    objectEntries: [],
    byEmployeeDate: new Map(),
    objectEntriesByEmployeeDate: new Map(),
    skudMap: new Map(),
  })),
}));

import { getDashboardStats, invalidateDashboardCache } from './skud-dashboard.service.js';

function classifyQuery(sql: string, params: unknown[]): QueryCall {
  let table: QueryCall['table'] = 'unknown';
  if (/FROM\s+employees\b/i.test(sql)) table = 'employees';
  else if (/FROM\s+skud_daily_summary\b/i.test(sql)) table = 'skud_daily_summary';
  else if (/FROM\s+skud_events\b/i.test(sql)) {
    table = /LIMIT\s+50/i.test(sql) && !/OFFSET/i.test(sql) ? 'skud_events_recent' : 'skud_events';
  }

  const limitMatch = /LIMIT\s+(\d+)/i.exec(sql);
  const offsetMatch = /OFFSET\s+(\d+)/i.exec(sql);
  return {
    sql,
    params,
    table,
    offset: offsetMatch ? Number(offsetMatch[1]) : undefined,
    limit: limitMatch ? Number(limitMatch[1]) : undefined,
  };
}

function applyEmployees(empIds: number[]): EmployeeRow[] {
  return mockedState.employees.filter(emp =>
    !emp.is_archived && emp.employment_status === 'active' && empIds.length > 0 && empIds.includes(emp.id),
  );
}

function applyEmployeesByDept(deptIds: string[]): EmployeeRow[] {
  return mockedState.employees.filter(emp =>
    !emp.is_archived && emp.employment_status === 'active' && deptIds.includes(emp.org_department_id),
  );
}

function resolveQuery(call: QueryCall): unknown[] {
  if (call.table === 'employees') {
    const deptIds = (call.params[0] as string[]) ?? [];
    return applyEmployeesByDept(deptIds);
  }
  if (call.table === 'skud_daily_summary') {
    const empIds = new Set(((call.params[0] as number[]) ?? []));
    const start = call.params[1] as string;
    const end = call.params[2] as string;
    let rows = mockedState.summaryRows.filter(r => empIds.has(r.employee_id) && r.date >= start && r.date <= end);
    rows = [...rows].sort((a, b) => (a.date === b.date ? a.employee_id - b.employee_id : a.date < b.date ? -1 : 1));
    const offset = call.offset ?? 0;
    const limit = call.limit ?? rows.length;
    return rows.slice(offset, offset + limit);
  }
  if (call.table === 'skud_events') {
    if (/event_date\s*=\s*\$1\s+AND\s+direction\s*=\s*\$2/i.test(call.sql)) {
      // today events
      const date = call.params[0] as string;
      const direction = call.params[1] as 'entry' | 'exit';
      const empIds = new Set(((call.params[2] as number[]) ?? []));
      let rows = mockedState.eventRows.filter(r => r.event_date === date && r.direction === direction && empIds.has(r.employee_id));
      rows = [...rows].sort((a, b) => (a.employee_id === b.employee_id ? (a.event_time < b.event_time ? -1 : 1) : a.employee_id - b.employee_id));
      const offset = call.offset ?? 0;
      const limit = call.limit ?? rows.length;
      return rows.slice(offset, offset + limit).map(({ event_time, employee_id }) => ({ event_time, employee_id }));
    }
    // entry-events over period
    const empIds = new Set(((call.params[0] as number[]) ?? []));
    const start = call.params[1] as string;
    const end = call.params[2] as string;
    let rows = mockedState.eventRows.filter(r => r.direction === 'entry' && empIds.has(r.employee_id) && r.event_date >= start && r.event_date <= end);
    rows = [...rows].sort((a, b) =>
      a.event_date !== b.event_date ? (a.event_date < b.event_date ? -1 : 1)
        : a.employee_id !== b.employee_id ? a.employee_id - b.employee_id
          : a.event_time < b.event_time ? -1 : 1);
    const offset = call.offset ?? 0;
    const limit = call.limit ?? rows.length;
    return rows.slice(offset, offset + limit).map(({ event_date, event_time, employee_id }) => ({ event_date, event_time, employee_id }));
  }
  if (call.table === 'skud_events_recent') {
    const date = call.params[0] as string;
    const empIds = new Set(((call.params[1] as number[]) ?? []));
    return mockedState.eventRows
      .filter(r => r.event_date === date && empIds.has(r.employee_id))
      .sort((a, b) => (a.event_time < b.event_time ? 1 : -1))
      .slice(0, 50);
  }
  return [];
}

describe('skud-dashboard.service', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T09:30:00+03:00'));
    mockedState.queryLog.length = 0;
    mockedState.employees = [];
    mockedState.summaryRows = [];
    mockedState.eventRows = [];
    mockedState.internalPoints = new Set();
    pgQuery.mockReset();
    pgQueryOne.mockReset();
    pgExecute.mockReset();
    pgTx.mockReset();

    pgQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const call = classifyQuery(sql, params);
      mockedState.queryLog.push(call);
      return resolveQuery(call);
    });

    invalidateDashboardCache();
  });

  afterEach(() => {
    invalidateDashboardCache();
    vi.useRealTimers();
  });

  it('paginates weekly summaries and preserves full period stats for large departments', async () => {
    const employees = Array.from({ length: 1500 }, (_, index) => ({
      id: index + 1,
      full_name: `Сотрудник ${index + 1}`,
      org_department_id: 'dept-1',
      is_archived: false,
      employment_status: 'active',
    }));
    const prevWeekDates = ['2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09', '2026-04-10'];
    const currentWeekDates = ['2026-04-13', '2026-04-14', '2026-04-15', '2026-04-16', '2026-04-17'];

    mockedState.employees = employees;
    for (const date of [...prevWeekDates, ...currentWeekDates]) {
      mockedState.summaryRows.push(...employees.map(emp => ({
        employee_id: emp.id,
        date,
        first_entry: '09:00:00',
        last_exit: '18:00:00',
        total_hours: 8,
        is_present: true,
      })));
      mockedState.eventRows.push(...employees.map(emp => ({
        employee_id: emp.id,
        event_date: date,
        event_time: '09:00:00',
        physical_person: emp.full_name,
        access_point: 'КПП-1',
        direction: 'entry' as const,
      })));
    }

    const stats = await getDashboardStats({ departmentId: 'dept-1', period: 'week', showActualHours: false });

    expect(stats.periodStats).toEqual({
      avgPresent: 1500,
      avgAbsent: 0,
      attendanceRate: 100,
      lateCount: 0,
      prevLateCount: 0,
    });
    expect(stats.weekComparison).toMatchObject({
      thisWeek: { attendanceRate: 100, lateCount: 0 },
      lastWeek: { attendanceRate: 100, lateCount: 0 },
    });
    expect(stats.todayEntriesCount).toBe(1500);

    const summaryQueries = mockedState.queryLog.filter(q => q.table === 'skud_daily_summary');
    expect(summaryQueries.length).toBeGreaterThan(2);
    expect(summaryQueries.some(q => q.offset === 1000 && q.limit === 1000)).toBe(true);
  });

  it('paginates monthly entry events for arrival and hourly activity aggregations', async () => {
    const employees = Array.from({ length: 800 }, (_, index) => ({
      id: index + 1,
      full_name: `Сотрудник ${index + 1}`,
      org_department_id: 'dept-1',
      is_archived: false,
      employment_status: 'active',
    }));
    const monthDates = [
      '2026-04-01', '2026-04-02', '2026-04-03',
      '2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09', '2026-04-10',
      '2026-04-13', '2026-04-14', '2026-04-15', '2026-04-16', '2026-04-17',
    ];
    const fridayTimes: Record<string, string> = {
      '2026-04-03': '09:00:00',
      '2026-04-10': '09:00:00',
      '2026-04-17': '10:00:00',
    };

    mockedState.employees = employees;
    for (const date of monthDates) {
      const entryTime = fridayTimes[date] || '09:00:00';
      mockedState.summaryRows.push(...employees.map(emp => ({
        employee_id: emp.id,
        date,
        first_entry: entryTime,
        last_exit: '18:00:00',
        total_hours: 8,
        is_present: true,
      })));
      mockedState.eventRows.push(...employees.map(emp => ({
        employee_id: emp.id,
        event_date: date,
        event_time: entryTime,
        physical_person: emp.full_name,
        access_point: 'КПП-1',
        direction: 'entry' as const,
      })));
    }

    const stats = await getDashboardStats({
      departmentId: 'dept-1',
      period: 'month',
      month: '2026-04',
      showActualHours: false,
    });

    expect(stats.periodStats).toMatchObject({
      avgPresent: 800,
      avgAbsent: 0,
      attendanceRate: 100,
    });
    expect(stats.avgArrivalByDay.find(item => item.day === 'Пт')?.avgTime).toBe('09:20');

    const pagedEventQueries = mockedState.queryLog.filter(q =>
      q.table === 'skud_events'
      && q.offset !== undefined
      && q.params[1] === '2026-04-01'
      && q.params[2] === '2026-04-17',
    );
    expect(pagedEventQueries.length).toBeGreaterThan(2);
  });

  it('keeps today calculations unchanged while using paged today event queries', async () => {
    const employeeA = { id: 1, full_name: 'Сотрудник 1', org_department_id: 'dept-1', is_archived: false, employment_status: 'active' };
    const employeeB = { id: 2, full_name: 'Сотрудник 2', org_department_id: 'dept-1', is_archived: false, employment_status: 'active' };
    mockedState.employees = [employeeA, employeeB];

    mockedState.summaryRows = [
      { employee_id: employeeA.id, date: '2026-04-16', first_entry: '09:00:00', last_exit: '18:00:00', total_hours: 8, is_present: true },
      { employee_id: employeeB.id, date: '2026-04-16', first_entry: '09:30:00', last_exit: '18:00:00', total_hours: 8, is_present: true },
      { employee_id: employeeA.id, date: '2026-04-17', first_entry: '09:20:00', last_exit: '18:05:00', total_hours: 8, is_present: true },
      { employee_id: employeeB.id, date: '2026-04-17', first_entry: '08:55:00', last_exit: null, total_hours: 7.5, is_present: true },
    ];

    mockedState.eventRows = [
      { employee_id: employeeA.id, event_date: '2026-04-17', event_time: '09:20:00', physical_person: employeeA.full_name, access_point: 'КПП-1', direction: 'entry' },
      { employee_id: employeeB.id, event_date: '2026-04-17', event_time: '08:55:00', physical_person: employeeB.full_name, access_point: 'КПП-1', direction: 'entry' },
      { employee_id: employeeA.id, event_date: '2026-04-17', event_time: '18:05:00', physical_person: employeeA.full_name, access_point: 'КПП-1', direction: 'exit' },
    ];

    const stats = await getDashboardStats({ departmentId: 'dept-1', period: 'today', showActualHours: false });

    expect(stats.lateToday).toBe(1);
    expect(stats.lateYesterday).toBe(1);
    expect(stats.periodStats).toBeNull();
    expect(stats.todayEntriesCount).toBe(2);
    expect(stats.todayExitsCount).toBe(1);
    expect(stats.punctuality).toEqual({
      onTime: 50,
      slightlyLate: 0,
      veryLate: 50,
      absent: 0,
    });
  });

  it('returns all late employees instead of truncating the late list to five items', async () => {
    const employees = Array.from({ length: 6 }, (_, index) => ({
      id: index + 1,
      full_name: `Сотрудник ${index + 1}`,
      org_department_id: 'dept-1',
      is_archived: false,
      employment_status: 'active',
    }));
    mockedState.employees = employees;

    mockedState.summaryRows = employees.map((employee, index) => ({
      employee_id: employee.id,
      date: '2026-04-17',
      first_entry: `09:${String((index + 1) * 5).padStart(2, '0')}:00`,
      last_exit: '18:00:00',
      total_hours: 8,
      is_present: true,
    }));

    mockedState.eventRows = employees.map((employee, index) => ({
      employee_id: employee.id,
      event_date: '2026-04-17',
      event_time: `09:${String((index + 1) * 5).padStart(2, '0')}:00`,
      physical_person: employee.full_name,
      access_point: 'КПП-1',
      direction: 'entry' as const,
    }));

    const stats = await getDashboardStats({ departmentId: 'dept-1', period: 'month', month: '2026-04', showActualHours: false });

    expect(stats.topLate).toHaveLength(6);
    expect(stats.topLate.map(item => item.employee_id)).toEqual(employees.map(employee => employee.id));
  });
});

// Silence unused import warning when typings change.
void applyEmployees;
