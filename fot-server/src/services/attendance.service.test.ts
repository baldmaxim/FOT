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
  objectSchedulesByDate: new Map<string, Map<string, IResolvedSchedule>>(),
  objectAttendanceData: {
    objectEntries: [] as Array<Record<string, unknown>>,
    objectEntriesByEmployeeDate: new Map<number, Map<string, Array<Record<string, unknown>>>>(),
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
  getScheduleForDate: vi.fn((schedule?: { work_hours?: number }) => ({
    work_hours: schedule?.work_hours ?? mockedState.scheduleWorkHours,
    work_start: '09:00',
    work_end: '18:00',
  })),
  getShiftDurationHours: vi.fn((dayParams?: { work_hours?: number }) => (
    dayParams?.work_hours ?? mockedState.scheduleWorkHours
  )),
  isPreHoliday: vi.fn(() => false),
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
    mockedState.objectSchedulesByDate = new Map();
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
    const calendarMonth = { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth;

    const result = await buildAttendanceEntries({
      employees: [{ id: 1, full_name: 'Иван Иванов' }],
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
      display_hours_worked: 8,
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
      employees: [{ id: 1, full_name: 'Иван Иванов' }],
      startDate: '2026-04-01',
      endDate: '2026-04-01',
      dailySchedulesMap: new Map(),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-01',
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      employee_id: 1,
      work_date: '2026-04-01',
      hours_worked: 8,
      display_hours_worked: 8,
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
      employees: [{ id: 1, full_name: 'Иван Иванов' }],
      startDate: '2026-04-01',
      endDate: '2026-04-01',
      dailySchedulesMap: new Map([
        [1, new Map([['2026-04-01', {} as IResolvedSchedule]])],
      ]),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-03',
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      employee_id: 1,
      work_date: '2026-04-01',
      status: 'work',
      hours_worked: 8,
      display_hours_worked: 8,
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
      employees: [{ id: 1, full_name: 'Иван Иванов' }],
      startDate: '2026-04-01',
      endDate: '2026-04-01',
      dailySchedulesMap: new Map([
        [1, new Map([['2026-04-01', {} as IResolvedSchedule]])],
      ]),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-03',
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      employee_id: 1,
      work_date: '2026-04-01',
      status: 'absent',
      hours_worked: 0,
      display_hours_worked: 0,
      base_hours_worked: 0,
      first_entry: null,
      last_exit: null,
      is_correction: false,
    });
  });

  it('keeps absent adjustment intact when day has object entries (does not overwrite status/hours)', async () => {
    const objectEntry = {
      adjustment_id: null,
      employee_id: 1,
      work_date: '2026-04-01',
      object_key: 'obj-a',
      object_id: 'obj-a',
      object_name: 'Объект A',
      hours_worked: 6,
      display_hours_worked: 6,
      base_hours_worked: 6,
      is_correction: false,
    };

    mockedState.objectAttendanceData = {
      objectEntries: [objectEntry],
      objectEntriesByEmployeeDate: new Map([
        [1, new Map([['2026-04-01', [objectEntry]]])],
      ]),
      employeeDistinctObjectKeys: new Map([[1, new Set(['obj-a'])]]),
      legacyBlockedDays: new Map(),
      rawFallbackSummaries: new Map(),
    };

    mockedState.resolver = (query) => {
      if (query.table === 'skud_daily_summary') {
        return {
          data: [{
            employee_id: 1,
            date: '2026-04-01',
            first_entry: '09:00:00',
            last_exit: '15:00:00',
            total_hours: 6,
            total_minutes: 360,
          }],
          error: null,
        };
      }

      if (query.table === 'attendance_adjustments') {
        return {
          data: [{
            id: 42,
            employee_id: 1,
            work_date: '2026-04-01',
            status: 'absent',
            hours_override: null,
            source_type: 'manual',
            source_id: 'manual',
            reason: 'Сотрудник не вышел',
            created_by: 'user-1',
            created_at: '2026-04-01T07:00:00.000Z',
            updated_at: '2026-04-01T07:05:00.000Z',
            metadata: {},
          }],
          error: null,
        };
      }

      if (query.table === 'user_profiles') {
        return { data: [{ id: 'user-1', full_name: 'HR Admin' }], error: null };
      }

      if (query.table === 'employees') {
        return { data: [], error: null };
      }

      throw new Error(`Unexpected query for table ${query.table}`);
    };

    const result = await buildAttendanceEntries({
      employees: [{ id: 1, full_name: 'Иван Иванов' }],
      startDate: '2026-04-01',
      endDate: '2026-04-01',
      dailySchedulesMap: new Map([
        [1, new Map([['2026-04-01', {} as IResolvedSchedule]])],
      ]),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-01',
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      id: 42,
      employee_id: 1,
      work_date: '2026-04-01',
      status: 'absent',
      hours_worked: 8,
      display_hours_worked: 8,
      is_correction: true,
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

  it('reconciles summary hours with backend object rows even for a single object day', async () => {
    const singleObjectEntry = {
      adjustment_id: null,
      employee_id: 1,
      work_date: '2026-04-02',
      object_key: 'obj-a',
      object_id: 'obj-a',
      object_name: 'Объект A',
      hours_worked: 8,
      display_hours_worked: 8,
      base_hours_worked: 8,
      is_correction: false,
    };

    mockedState.objectAttendanceData = {
      objectEntries: [singleObjectEntry],
      objectEntriesByEmployeeDate: new Map([
        [1, new Map([['2026-04-02', [singleObjectEntry]]])],
      ]),
      employeeDistinctObjectKeys: new Map([[1, new Set(['obj-a'])]]),
      legacyBlockedDays: new Map(),
      rawFallbackSummaries: new Map(),
    };

    mockedState.resolver = (query) => {
      if (query.table === 'skud_daily_summary') {
        return {
          data: [{
            employee_id: 1,
            date: '2026-04-02',
            first_entry: '09:00:00',
            last_exit: '17:02:00',
            total_hours: 8.03,
            total_minutes: 482,
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
      employees: [{ id: 1, full_name: 'Иван Иванов' }],
      startDate: '2026-04-02',
      endDate: '2026-04-02',
      dailySchedulesMap: new Map([
        [1, new Map([['2026-04-02', {} as IResolvedSchedule]])],
      ]),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-02',
    });

    expect(result.entries[0]).toMatchObject({
      employee_id: 1,
      work_date: '2026-04-02',
      hours_worked: 8,
      display_hours_worked: 8,
      base_hours_worked: 8,
      object_detail_mode: 'none',
      object_detail_count: 0,
    });
  });

  it('proportionally caps object hours when actual total exceeds planned day hours', async () => {
    mockedState.scheduleWorkHours = 8;

    const objectEntryA = {
      adjustment_id: 1,
      employee_id: 1,
      work_date: '2026-04-01',
      object_key: 'obj-a',
      object_id: 'obj-a',
      object_name: 'Объект A',
      hours_worked: 6,
      display_hours_worked: 6,
      base_hours_worked: 6,
      is_correction: false,
    };
    const objectEntryB = {
      adjustment_id: 2,
      employee_id: 1,
      work_date: '2026-04-01',
      object_key: 'obj-b',
      object_id: 'obj-b',
      object_name: 'Объект B',
      hours_worked: 5,
      display_hours_worked: 5,
      base_hours_worked: 5,
      is_correction: false,
    };

    mockedState.objectAttendanceData = {
      objectEntries: [objectEntryA, objectEntryB],
      objectEntriesByEmployeeDate: new Map([
        [1, new Map([['2026-04-01', [objectEntryA, objectEntryB]]])],
      ]),
      employeeDistinctObjectKeys: new Map([[1, new Set(['obj-a', 'obj-b'])]]),
      legacyBlockedDays: new Map(),
      rawFallbackSummaries: new Map(),
    };

    mockedState.resolver = (query) => {
      if (query.table === 'skud_daily_summary') {
        return {
          data: [{
            employee_id: 1,
            date: '2026-04-01',
            first_entry: '09:00:00',
            last_exit: '20:00:00',
            total_hours: 11,
            total_minutes: 660,
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
      employees: [{ id: 1, full_name: 'Иван Иванов' }],
      startDate: '2026-04-01',
      endDate: '2026-04-01',
      dailySchedulesMap: new Map([
        [1, new Map([['2026-04-01', {} as IResolvedSchedule]])],
      ]),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-01',
      displayMode: 'capped_to_schedule',
    });

    expect(result.entries[0]).toMatchObject({
      employee_id: 1,
      work_date: '2026-04-01',
      hours_worked: 8,
      display_hours_worked: 8,
      base_hours_worked: 8,
      first_entry: null,
      last_exit: null,
      object_detail_mode: 'available',
    });

    const objA = result.objectEntries.find(entry => entry.object_key === 'obj-a')!;
    const objB = result.objectEntries.find(entry => entry.object_key === 'obj-b')!;
    expect(objA.display_hours_worked).toBeCloseTo(6 * 8 / 11, 2);
    expect(objA.hours_worked).toBe(objA.display_hours_worked);
    expect(objA.base_hours_worked).toBe(objA.display_hours_worked);
    expect(objB.display_hours_worked).toBeCloseTo(8 - objA.display_hours_worked, 2);
    expect(objB.hours_worked).toBe(objB.display_hours_worked);
    expect(objA.display_hours_worked + objB.display_hours_worked).toBeCloseTo(8, 2);
  });

  it('keeps actual object hours when total is within planned day hours', async () => {
    mockedState.scheduleWorkHours = 8;

    const objectEntryA = {
      adjustment_id: 1,
      employee_id: 1,
      work_date: '2026-04-01',
      object_key: 'obj-a',
      object_id: 'obj-a',
      object_name: 'Объект A',
      hours_worked: 3,
      display_hours_worked: 3,
      base_hours_worked: 3,
      is_correction: false,
    };
    const objectEntryB = {
      adjustment_id: 2,
      employee_id: 1,
      work_date: '2026-04-01',
      object_key: 'obj-b',
      object_id: 'obj-b',
      object_name: 'Объект B',
      hours_worked: 4,
      display_hours_worked: 4,
      base_hours_worked: 4,
      is_correction: false,
    };

    mockedState.objectAttendanceData = {
      objectEntries: [objectEntryA, objectEntryB],
      objectEntriesByEmployeeDate: new Map([
        [1, new Map([['2026-04-01', [objectEntryA, objectEntryB]]])],
      ]),
      employeeDistinctObjectKeys: new Map([[1, new Set(['obj-a', 'obj-b'])]]),
      legacyBlockedDays: new Map(),
      rawFallbackSummaries: new Map(),
    };

    mockedState.resolver = (query) => {
      if (query.table === 'skud_daily_summary') {
        return {
          data: [{
            employee_id: 1,
            date: '2026-04-01',
            first_entry: '10:00:00',
            last_exit: '17:00:00',
            total_hours: 7,
            total_minutes: 420,
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
      employees: [{ id: 1, full_name: 'Иван Иванов' }],
      startDate: '2026-04-01',
      endDate: '2026-04-01',
      dailySchedulesMap: new Map([
        [1, new Map([['2026-04-01', {} as IResolvedSchedule]])],
      ]),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-01',
      displayMode: 'capped_to_schedule',
    });

    expect(result.entries[0]).toMatchObject({
      hours_worked: 7,
      display_hours_worked: 7,
      base_hours_worked: 7,
      first_entry: null,
      last_exit: null,
    });

    const objA = result.objectEntries.find(entry => entry.object_key === 'obj-a')!;
    const objB = result.objectEntries.find(entry => entry.object_key === 'obj-b')!;
    expect(objA.display_hours_worked).toBe(3);
    expect(objB.display_hours_worked).toBe(4);
  });

  it('caps and masks actual fields when the day has no object breakdown', async () => {
    mockedState.scheduleWorkHours = 8;

    mockedState.resolver = (query) => {
      if (query.table === 'skud_daily_summary') {
        return {
          data: [{
            employee_id: 1,
            date: '2026-04-01',
            first_entry: '08:00:00',
            last_exit: '18:00:00',
            total_hours: 10,
            total_minutes: 600,
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
      employees: [{ id: 1, full_name: 'Иван Иванов' }],
      startDate: '2026-04-01',
      endDate: '2026-04-01',
      dailySchedulesMap: new Map([
        [1, new Map([['2026-04-01', {} as IResolvedSchedule]])],
      ]),
      calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
      todayStr: '2026-04-01',
      displayMode: 'capped_to_schedule',
    });

    expect(result.entries[0]).toMatchObject({
      employee_id: 1,
      work_date: '2026-04-01',
      hours_worked: 8,
      display_hours_worked: 8,
      base_hours_worked: 8,
      first_entry: null,
      last_exit: null,
    });
  });

  describe('presence_covers_shift', () => {
    const buildResolver = (summaryRow: Record<string, unknown> | null) => (query: QueryRecord): QueryResponse => {
      if (query.table === 'skud_daily_summary') {
        return { data: summaryRow ? [summaryRow] : [], error: null };
      }
      if (query.table === 'attendance_adjustments' || query.table === 'user_profiles' || query.table === 'employees') {
        return { data: [], error: null };
      }
      throw new Error(`Unexpected query for table ${query.table}`);
    };

    it('flags span=8h as insufficient when shift needs 9h (entered 9 left 17 without lunch)', async () => {
      mockedState.resolver = buildResolver({
        employee_id: 1,
        date: '2026-04-01',
        first_entry: '09:00:00',
        last_exit: '17:00:00',
        total_hours: 8,
        total_minutes: 480,
      });

      const schedule = { work_hours: 9, lunch_minutes: 60 } as unknown as IResolvedSchedule;
      const result = await buildAttendanceEntries({
        employees: [{ id: 1, full_name: 'A' }],
        startDate: '2026-04-01',
        endDate: '2026-04-01',
        dailySchedulesMap: new Map([[1, new Map([['2026-04-01', schedule]])]]),
        calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
        todayStr: '2026-04-03',
      });

      expect(result.entries[0].presence_covers_shift).toBe(false);
    });

    it('accepts full 9:00-18:00 with proper lunch break', async () => {
      mockedState.resolver = buildResolver({
        employee_id: 1,
        date: '2026-04-01',
        first_entry: '09:00:00',
        last_exit: '18:00:00',
        total_hours: 8,
        total_minutes: 480,
      });

      const schedule = { work_hours: 9, lunch_minutes: 60 } as unknown as IResolvedSchedule;
      const result = await buildAttendanceEntries({
        employees: [{ id: 1, full_name: 'A' }],
        startDate: '2026-04-01',
        endDate: '2026-04-01',
        dailySchedulesMap: new Map([[1, new Map([['2026-04-01', schedule]])]]),
        calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
        todayStr: '2026-04-03',
      });

      expect(result.entries[0].presence_covers_shift).toBe(true);
    });

    it('rejects day when gaps exceed allotted lunch (90min absence while lunch=60)', async () => {
      mockedState.resolver = buildResolver({
        employee_id: 1,
        date: '2026-04-01',
        first_entry: '09:00:00',
        last_exit: '18:30:00',
        total_hours: 8,
        total_minutes: 480,
      });

      const schedule = { work_hours: 9, lunch_minutes: 60 } as unknown as IResolvedSchedule;
      const result = await buildAttendanceEntries({
        employees: [{ id: 1, full_name: 'A' }],
        startDate: '2026-04-01',
        endDate: '2026-04-01',
        dailySchedulesMap: new Map([[1, new Map([['2026-04-01', schedule]])]]),
        calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
        todayStr: '2026-04-03',
      });

      expect(result.entries[0].presence_covers_shift).toBe(false);
    });

    it('flags past day with missing last_exit as not covering shift', async () => {
      mockedState.needsSkudCheck = true;
      mockedState.resolver = buildResolver(null);
      mockedState.objectAttendanceData.rawFallbackSummaries = new Map([
        [1, new Map([['2026-04-01', {
          employee_id: 1,
          date: '2026-04-01',
          first_entry: '09:00:00',
          last_exit: null,
          total_hours: 0,
          total_minutes: 0,
        }]])],
      ]);

      const schedule = { work_hours: 9, lunch_minutes: 60 } as unknown as IResolvedSchedule;
      const result = await buildAttendanceEntries({
        employees: [{ id: 1, full_name: 'A' }],
        startDate: '2026-04-01',
        endDate: '2026-04-01',
        dailySchedulesMap: new Map([[1, new Map([['2026-04-01', schedule]])]]),
        calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
        todayStr: '2026-04-05',
      });

      expect(result.entries[0].presence_covers_shift).toBe(false);
    });

    it('marks remote day as covering shift without SKUD check', async () => {
      mockedState.needsSkudCheck = false;
      mockedState.resolver = buildResolver(null);

      const schedule = { work_hours: 8, lunch_minutes: 0 } as unknown as IResolvedSchedule;
      const result = await buildAttendanceEntries({
        employees: [{ id: 1, full_name: 'A' }],
        startDate: '2026-04-01',
        endDate: '2026-04-01',
        dailySchedulesMap: new Map([[1, new Map([['2026-04-01', schedule]])]]),
        calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
        todayStr: '2026-04-05',
      });

      expect(result.entries[0]).toMatchObject({
        status: 'remote',
        presence_covers_shift: true,
      });
    });

    it('preserves presence_covers_shift flag in capped_to_schedule mode', async () => {
      mockedState.resolver = buildResolver({
        employee_id: 1,
        date: '2026-04-01',
        first_entry: '09:00:00',
        last_exit: '17:00:00',
        total_hours: 8,
        total_minutes: 480,
      });

      const schedule = { work_hours: 9, lunch_minutes: 60 } as unknown as IResolvedSchedule;
      const result = await buildAttendanceEntries({
        employees: [{ id: 1, full_name: 'A' }],
        startDate: '2026-04-01',
        endDate: '2026-04-01',
        dailySchedulesMap: new Map([[1, new Map([['2026-04-01', schedule]])]]),
        calendarMonth: { holidays: [], mandatory_holidays: [], pre_holidays: [], norm_days: 22 } as unknown as IProductionCalendarMonth,
        todayStr: '2026-04-03',
        displayMode: 'capped_to_schedule',
      });

      expect(result.entries[0]).toMatchObject({
        first_entry: null,
        last_exit: null,
        presence_covers_shift: false,
      });
    });
  });
});
