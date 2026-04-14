import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IProductionCalendarMonth, IResolvedSchedule } from '../types/index.js';

type QueryRecord = {
  table: string;
  operations: Array<{ method: string; args: unknown[] }>;
};

type QueryResponse = {
  data?: unknown;
  error?: { code?: string; message?: string } | null;
};

const mockedState = vi.hoisted(() => ({
  queryLog: [] as QueryRecord[],
  resolver: (() => ({ data: [], error: null })) as (query: QueryRecord) => QueryResponse | Promise<QueryResponse>,
  travelSummary: new Map<string, {
    creditedMinutes: number;
    delayMinutes: number;
    segmentsCount: number;
    problematicSegmentsCount: number;
    objectProblemSegmentsCount: number;
  }>(),
  internalPoints: new Set<string>(),
  scheduleWorkHours: 8,
  isWorkingDay: true,
  needsSkudCheck: false,
  objectAttendanceData: {
    objectEntries: [],
    objectEntriesByEmployeeDate: new Map<number, Map<string, []>>(),
    employeeDistinctObjectKeys: new Map<number, Set<string>>(),
    legacyBlockedDays: new Map<string, string>(),
    rawFallbackSummaries: new Map<number, Map<string, {
      employee_id: number;
      date: string;
      first_entry: string | null;
      last_exit: string | null;
      total_hours: number | null;
      total_minutes?: number | null;
    }>>(),
  },
}));

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
    upsert: (...args: unknown[]) => {
      query.operations.push({ method: 'upsert', args });
      return builder;
    },
    update: (...args: unknown[]) => {
      query.operations.push({ method: 'update', args });
      return builder;
    },
    single: async () => mockedState.resolver(query),
    then: (onFulfilled: (value: QueryResponse) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(mockedState.resolver(query)).then(onFulfilled, onRejected),
  };

  return builder;
}

vi.mock('../config/database.js', () => ({
  supabase: {
    from: vi.fn((table: string) => createBuilder(table)),
  },
}));

vi.mock('./skud-travel.service.js', () => ({
  getTravelHoursSummaryForRange: vi.fn(async () => mockedState.travelSummary),
  travelMinutesToHours: (minutes: number) => Math.round((minutes / 60) * 100) / 100,
}));

vi.mock('./schedule.service.js', () => ({
  getScheduleForDate: vi.fn(() => ({ work_hours: mockedState.scheduleWorkHours })),
  isWorkingDay: vi.fn(() => mockedState.isWorkingDay),
  needsSkudCheck: vi.fn(() => mockedState.needsSkudCheck),
}));

vi.mock('./skud-shared.service.js', () => ({
  getInternalAccessPoints: vi.fn(async () => mockedState.internalPoints),
}));

vi.mock('./timesheet-object.service.js', () => ({
  OBJECT_ADJUSTMENT_SOURCE_TYPE: 'manual_object',
  buildObjectAttendanceData: vi.fn(async () => mockedState.objectAttendanceData),
}));

import {
  buildAttendanceEntries,
  upsertAttendanceAdjustment,
} from './attendance.service.js';

describe('attendance.service', () => {
  beforeEach(() => {
    mockedState.queryLog.length = 0;
    mockedState.travelSummary = new Map();
    mockedState.internalPoints = new Set();
    mockedState.scheduleWorkHours = 8;
    mockedState.isWorkingDay = true;
    mockedState.needsSkudCheck = false;
    mockedState.objectAttendanceData = {
      objectEntries: [],
      objectEntriesByEmployeeDate: new Map(),
      employeeDistinctObjectKeys: new Map(),
      legacyBlockedDays: new Map(),
      rawFallbackSummaries: new Map(),
    };
    mockedState.resolver = () => ({ data: [], error: null });
  });

  it('prefers attendance adjustments over daily summary and keeps travel issue metadata without crediting hours', async () => {
    mockedState.travelSummary = new Map([
      ['1_2026-04-01', {
        creditedMinutes: 30,
        delayMinutes: 5,
        segmentsCount: 2,
        problematicSegmentsCount: 1,
        objectProblemSegmentsCount: 1,
      }],
    ]);

    mockedState.resolver = (query) => {
      if (query.table === 'skud_daily_summary') {
        return {
          data: [{
            employee_id: 1,
            date: '2026-04-01',
            first_entry: '09:10:00',
            last_exit: '18:00:00',
            total_hours: 7.5,
            total_minutes: 450,
          }],
          error: null,
        };
      }

      if (query.table === 'attendance_adjustments') {
        return {
          data: [{
            id: 10,
            employee_id: 1,
            work_date: '2026-04-01',
            status: 'manual',
            hours_override: 8,
            source_type: 'manual',
            source_id: 'manual',
            reason: 'Manual correction',
            created_by: 'user-1',
            created_at: '2026-04-01T07:00:00.000Z',
            updated_at: '2026-04-01T07:05:00.000Z',
            metadata: {},
          }],
          error: null,
        };
      }

      if (query.table === 'user_profiles') {
        return {
          data: [{ id: 'user-1', full_name: 'HR Admin' }],
          error: null,
        };
      }

      if (query.table === 'employees') {
        return {
          data: [],
          error: null,
        };
      }

      throw new Error(`Unexpected query for table ${query.table}`);
    };

    const dailySchedulesMap = new Map<number, Map<string, IResolvedSchedule>>();
    const calendarMonth = { holidays: [], shortened_days: [], norm_days: 22 } as unknown as IProductionCalendarMonth;

    const result = await buildAttendanceEntries({
      employees: [{ id: 1, full_name: 'Иван Иванов', work_category: 'office' }],
      startDate: '2026-04-01',
      endDate: '2026-04-01',
      dailySchedulesMap,
      calendarMonth,
      todayStr: '2026-04-01',
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      id: 10,
      employee_id: 1,
      work_date: '2026-04-01',
      status: 'manual',
      hours_worked: 8,
      travel_minutes_credited: 0,
      travel_hours_credited: 0,
      travel_delay_minutes: 5,
      travel_segments_count: 2,
      travel_problematic_segments: 1,
      is_correction: true,
      corrected_by_name: 'HR Admin',
    });
    expect(result.skudMap.get(1)?.get('2026-04-01')).toEqual({ hours: 7.5, corrected: true });
    expect(result.objectEntries).toEqual([]);
  });

  it('does not add travel time to summary hours but keeps delay metadata', async () => {
    mockedState.travelSummary = new Map([
      ['1_2026-04-01', {
        creditedMinutes: 45,
        delayMinutes: 20,
        segmentsCount: 1,
        problematicSegmentsCount: 1,
        objectProblemSegmentsCount: 0,
      }],
    ]);

    mockedState.resolver = (query) => {
      if (query.table === 'skud_daily_summary') {
        return {
          data: [{
            employee_id: 1,
            date: '2026-04-01',
            first_entry: '09:00:00',
            last_exit: '18:00:00',
            total_hours: 8,
            total_minutes: 480,
          }],
          error: null,
        };
      }

      if (query.table === 'attendance_adjustments' || query.table === 'user_profiles' || query.table === 'employees') {
        return { data: [], error: null };
      }

      throw new Error(`Unexpected query for table ${query.table}`);
    };

    const result = await buildAttendanceEntries({
      employees: [{ id: 1, full_name: 'Иван Иванов', work_category: 'office' }],
      startDate: '2026-04-01',
      endDate: '2026-04-01',
      dailySchedulesMap: new Map(),
      calendarMonth: { holidays: [], shortened_days: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-01',
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      employee_id: 1,
      work_date: '2026-04-01',
      hours_worked: 8,
      base_hours_worked: 8,
      travel_minutes_credited: 0,
      travel_hours_credited: 0,
      travel_delay_minutes: 20,
      travel_problematic_segments: 0,
    });
    expect(result.objectEntries).toEqual([]);
  });

  it('builds a work entry from raw skud events when daily summary is missing', async () => {
    mockedState.needsSkudCheck = true;

    mockedState.resolver = (query) => {
      if (
        query.table === 'skud_daily_summary'
        || query.table === 'attendance_adjustments'
        || query.table === 'user_profiles'
        || query.table === 'employees'
      ) {
        return { data: [], error: null };
      }

      throw new Error(`Unexpected query for table ${query.table}`);
    };

    mockedState.objectAttendanceData.rawFallbackSummaries = new Map([
      [1, new Map([['2026-04-01', {
        employee_id: 1,
        date: '2026-04-01',
        first_entry: '09:00:00',
        last_exit: '18:00:00',
        total_hours: 9,
        total_minutes: 540,
      }]])],
    ]);

    const result = await buildAttendanceEntries({
      employees: [{ id: 1, full_name: 'Иван Иванов', work_category: 'office' }],
      startDate: '2026-04-01',
      endDate: '2026-04-01',
      dailySchedulesMap: new Map([
        [1, new Map([['2026-04-01', {} as IResolvedSchedule]])],
      ]),
      calendarMonth: { holidays: [], shortened_days: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-03',
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      employee_id: 1,
      work_date: '2026-04-01',
      status: 'work',
      hours_worked: 8,
      base_hours_worked: 9,
      first_entry: '09:00:00',
      last_exit: '18:00:00',
      is_correction: false,
    });
    expect(result.skudMap.get(1)?.get('2026-04-01')).toEqual({ hours: 8, corrected: false });
  });

  it('marks a scheduled skud day as absent when both summary and raw events are missing', async () => {
    mockedState.needsSkudCheck = true;

    mockedState.resolver = (query) => {
      if (
        query.table === 'skud_daily_summary'
        || query.table === 'attendance_adjustments'
        || query.table === 'user_profiles'
        || query.table === 'employees'
      ) {
        return { data: [], error: null };
      }

      throw new Error(`Unexpected query for table ${query.table}`);
    };

    const result = await buildAttendanceEntries({
      employees: [{ id: 1, full_name: 'Иван Иванов', work_category: 'office' }],
      startDate: '2026-04-01',
      endDate: '2026-04-01',
      dailySchedulesMap: new Map([
        [1, new Map([['2026-04-01', {} as IResolvedSchedule]])],
      ]),
      calendarMonth: { holidays: [], shortened_days: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-03',
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      employee_id: 1,
      work_date: '2026-04-01',
      status: 'absent',
      hours_worked: 0,
      base_hours_worked: 0,
      first_entry: null,
      last_exit: null,
      is_correction: false,
    });
  });

  it('writes attendance adjustments into canonical attendance_adjustments table', async () => {
    mockedState.resolver = (query) => {
      if (query.table === 'attendance_adjustments') {
        return {
          data: {
            id: 99,
            employee_id: 7,
            work_date: '2026-04-05',
            status: 'manual',
            hours_override: 6,
          },
          error: null,
        };
      }

      throw new Error(`Unexpected query for table ${query.table}`);
    };

    const result = await upsertAttendanceAdjustment({
      employee_id: 7,
      work_date: '2026-04-05',
      status: 'manual',
      hours_override: 6,
      source_type: 'manual',
      source_id: 'manual',
      reason: 'Legacy fallback',
      created_by: 'user-1',
    });

    expect(result).toMatchObject({
      id: 99,
      employee_id: 7,
      work_date: '2026-04-05',
      status: 'manual',
    });
    expect(mockedState.queryLog.map(item => item.table)).toEqual(['attendance_adjustments']);
  });
});
