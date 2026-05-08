import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type QueryRecord = {
  table: string;
  operations: Array<{ method: string; args: unknown[] }>;
};

type QueryResponse = {
  data?: unknown;
  error?: { code?: string; message?: string } | null;
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
  queryLog: [] as QueryRecord[],
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

function createBuilder(table: string) {
  const query: QueryRecord = { table, operations: [] };
  mockedState.queryLog.push(query);

  const builder = {
    select: (...args: unknown[]) => {
      query.operations.push({ method: 'select', args });
      return builder;
    },
    in: (...args: unknown[]) => {
      query.operations.push({ method: 'in', args });
      return builder;
    },
    gte: (...args: unknown[]) => {
      query.operations.push({ method: 'gte', args });
      return builder;
    },
    lte: (...args: unknown[]) => {
      query.operations.push({ method: 'lte', args });
      return builder;
    },
    eq: (...args: unknown[]) => {
      query.operations.push({ method: 'eq', args });
      return builder;
    },
    order: (...args: unknown[]) => {
      query.operations.push({ method: 'order', args });
      return builder;
    },
    range: (...args: unknown[]) => {
      query.operations.push({ method: 'range', args });
      return builder;
    },
    limit: (...args: unknown[]) => {
      query.operations.push({ method: 'limit', args });
      return builder;
    },
    then: (onFulfilled: (value: QueryResponse) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(resolveQuery(query)).then(onFulfilled, onRejected),
  };

  return builder;
}

function getOperation(query: QueryRecord, method: string, field?: string) {
  return query.operations.find(op => op.method === method && (field === undefined || op.args[0] === field));
}

function applyFilters<T extends Record<string, unknown>>(rows: T[], query: QueryRecord): T[] {
  let filtered = rows.slice();

  for (const operation of query.operations) {
    if (operation.method === 'eq') {
      const [field, value] = operation.args as [keyof T, unknown];
      filtered = filtered.filter(row => row[field] === value);
    }
    if (operation.method === 'in') {
      const [field, values] = operation.args as [keyof T, unknown[]];
      const valueSet = new Set(values);
      filtered = filtered.filter(row => valueSet.has(row[field]));
    }
    if (operation.method === 'gte') {
      const [field, value] = operation.args as [keyof T, string];
      filtered = filtered.filter(row => String(row[field]) >= value);
    }
    if (operation.method === 'lte') {
      const [field, value] = operation.args as [keyof T, string];
      filtered = filtered.filter(row => String(row[field]) <= value);
    }
  }

  return filtered;
}

function applyOrdering<T extends Record<string, unknown>>(rows: T[], query: QueryRecord): T[] {
  const orders = query.operations
    .filter(op => op.method === 'order')
    .map(op => ({
      field: String(op.args[0]),
      ascending: ((op.args[1] as { ascending?: boolean } | undefined)?.ascending ?? true),
    }));

  if (orders.length === 0) return rows;

  const sorted = rows.slice();
  for (const order of orders.reverse()) {
    sorted.sort((left, right) => {
      const leftValue = left[order.field];
      const rightValue = right[order.field];
      if (leftValue === rightValue) return 0;
      if (leftValue == null) return order.ascending ? -1 : 1;
      if (rightValue == null) return order.ascending ? 1 : -1;
      const result = leftValue < rightValue ? -1 : 1;
      return order.ascending ? result : -result;
    });
  }

  return sorted;
}

function applyWindow<T>(rows: T[], query: QueryRecord): T[] {
  const range = getOperation(query, 'range');
  if (range) {
    const [from, to] = range.args as [number, number];
    return rows.slice(from, to + 1);
  }

  const limit = getOperation(query, 'limit');
  if (limit) {
    const [count] = limit.args as [number];
    return rows.slice(0, count);
  }

  return rows;
}

function resolveQuery(query: QueryRecord): QueryResponse {
  if (query.table === 'employees') {
    return {
      data: applyWindow(applyOrdering(applyFilters(mockedState.employees, query), query), query),
      error: null,
    };
  }

  if (query.table === 'skud_daily_summary') {
    return {
      data: applyWindow(applyOrdering(applyFilters(mockedState.summaryRows, query), query), query),
      error: null,
    };
  }

  if (query.table === 'skud_events') {
    return {
      data: applyWindow(applyOrdering(applyFilters(mockedState.eventRows, query), query), query),
      error: null,
    };
  }

  throw new Error(`Unexpected query for table ${query.table}`);
}

vi.mock('../config/database.js', () => ({
  supabase: {
    from: vi.fn((table: string) => createBuilder(table)),
  },
}));

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

function buildEmployees(count: number): EmployeeRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    full_name: `Сотрудник ${index + 1}`,
    org_department_id: 'dept-1',
    is_archived: false,
    employment_status: 'active',
  }));
}

function pushSummaryRows(
  employees: EmployeeRow[],
  date: string,
  firstEntry: string,
  options: { lastExit?: string; totalHours?: number; isPresent?: boolean } = {},
): void {
  mockedState.summaryRows.push(...employees.map(employee => ({
    employee_id: employee.id,
    date,
    first_entry: firstEntry,
    last_exit: options.lastExit ?? '18:00:00',
    total_hours: options.totalHours ?? 8,
    is_present: options.isPresent ?? true,
  })));
}

function pushEventRows(
  employees: EmployeeRow[],
  date: string,
  time: string,
  direction: 'entry' | 'exit',
  accessPoint = 'КПП-1',
): void {
  mockedState.eventRows.push(...employees.map(employee => ({
    employee_id: employee.id,
    event_date: date,
    event_time: time,
    physical_person: employee.full_name,
    access_point: accessPoint,
    direction,
  })));
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
    invalidateDashboardCache();
  });

  afterEach(() => {
    invalidateDashboardCache();
    vi.useRealTimers();
  });

  it('paginates weekly summaries and preserves full period stats for large departments', async () => {
    const employees = buildEmployees(1500);
    const prevWeekDates = ['2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09', '2026-04-10'];
    const currentWeekDates = ['2026-04-13', '2026-04-14', '2026-04-15', '2026-04-16', '2026-04-17'];

    mockedState.employees = employees;
    for (const date of [...prevWeekDates, ...currentWeekDates]) {
      pushSummaryRows(employees, date, '09:00:00');
      pushEventRows(employees, date, '09:00:00', 'entry');
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

    const summaryQueries = mockedState.queryLog.filter(query => query.table === 'skud_daily_summary');
    expect(summaryQueries.length).toBeGreaterThan(2);
    expect(summaryQueries.some(query => {
      const range = getOperation(query, 'range');
      return Array.isArray(range?.args) && range.args[0] === 1000 && range.args[1] === 1999;
    })).toBe(true);
  });

  it('paginates monthly entry events for arrival and hourly activity aggregations', async () => {
    const employees = buildEmployees(800);
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
      pushSummaryRows(employees, date, entryTime);
      pushEventRows(employees, date, entryTime, 'entry');
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

    const pagedEventQueries = mockedState.queryLog.filter(query =>
      query.table === 'skud_events'
      && getOperation(query, 'range') !== undefined
      && getOperation(query, 'gte', 'event_date')?.args[1] === '2026-04-01'
      && getOperation(query, 'lte', 'event_date')?.args[1] === '2026-04-17',
    );
    expect(pagedEventQueries.length).toBeGreaterThan(2);
  });

  it('keeps today calculations unchanged while using paged today event queries', async () => {
    const [employeeA, employeeB] = buildEmployees(2);
    mockedState.employees = [employeeA, employeeB];

    mockedState.summaryRows = [
      {
        employee_id: employeeA.id,
        date: '2026-04-16',
        first_entry: '09:00:00',
        last_exit: '18:00:00',
        total_hours: 8,
        is_present: true,
      },
      {
        employee_id: employeeB.id,
        date: '2026-04-16',
        first_entry: '09:30:00',
        last_exit: '18:00:00',
        total_hours: 8,
        is_present: true,
      },
      {
        employee_id: employeeA.id,
        date: '2026-04-17',
        first_entry: '09:20:00',
        last_exit: '18:05:00',
        total_hours: 8,
        is_present: true,
      },
      {
        employee_id: employeeB.id,
        date: '2026-04-17',
        first_entry: '08:55:00',
        last_exit: null,
        total_hours: 7.5,
        is_present: true,
      },
    ];

    mockedState.eventRows = [
      {
        employee_id: employeeA.id,
        event_date: '2026-04-17',
        event_time: '09:20:00',
        physical_person: employeeA.full_name,
        access_point: 'КПП-1',
        direction: 'entry',
      },
      {
        employee_id: employeeB.id,
        event_date: '2026-04-17',
        event_time: '08:55:00',
        physical_person: employeeB.full_name,
        access_point: 'КПП-1',
        direction: 'entry',
      },
      {
        employee_id: employeeA.id,
        event_date: '2026-04-17',
        event_time: '18:05:00',
        physical_person: employeeA.full_name,
        access_point: 'КПП-1',
        direction: 'exit',
      },
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
    const employees = buildEmployees(6);
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
