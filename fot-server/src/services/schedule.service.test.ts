import { beforeEach, describe, expect, it, vi } from 'vitest';

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
}));

function createBuilder(table: string) {
  const query: QueryRecord = { table, operations: [] };
  mockedState.queryLog.push(query);

  const builder = {
    select: (...args: unknown[]) => {
      query.operations.push({ method: 'select', args });
      return builder;
    },
    eq: (...args: unknown[]) => {
      query.operations.push({ method: 'eq', args });
      return builder;
    },
    in: (...args: unknown[]) => {
      query.operations.push({ method: 'in', args });
      return builder;
    },
    lte: (...args: unknown[]) => {
      query.operations.push({ method: 'lte', args });
      return builder;
    },
    or: (...args: unknown[]) => {
      query.operations.push({ method: 'or', args });
      return builder;
    },
    order: (...args: unknown[]) => {
      query.operations.push({ method: 'order', args });
      return builder;
    },
    limit: (...args: unknown[]) => {
      query.operations.push({ method: 'limit', args });
      return builder;
    },
    maybeSingle: async () => mockedState.resolver(query),
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

import {
  countNormHoursForSchedule,
  getDayNormHours,
  getFullDayThresholdHoursForDate,
  resolveObjectSchedule,
  resolveObjectSchedulesForPeriod,
} from './schedule.service.js';
import type { IProductionCalendarMonth, IResolvedSchedule } from '../types/index.js';

describe('schedule.service object assignments', () => {
  beforeEach(() => {
    mockedState.queryLog.length = 0;
    mockedState.resolver = () => ({ data: [], error: null });
  });

  it('resolves an object schedule for a single date', async () => {
    mockedState.resolver = (query) => {
      if (query.table === 'object_schedule_assignments') {
        return {
          data: {
            schedule_id: 'sched-object',
            work_schedules: {
              id: 'sched-object',
              schedule_type: 'shift',
              work_start: '08:00:00',
              work_end: '17:00:00',
              work_hours: 9,
              work_days: [1, 2, 3, 4, 5],
              office_days: null,
              late_threshold_minutes: 15,
              day_overrides: null,
              lunch_minutes: 60,
              respects_holidays: true,
              pattern_type: 'custom',
              expected_saturdays_per_month: 0,
              full_day_threshold_minutes: null,
              weekend_full_day_threshold_minutes: null,
            },
          },
          error: null,
        };
      }

      throw new Error(`Unexpected query for table ${query.table}`);
    };

    const result = await resolveObjectSchedule('obj-a', '2026-04-10');

    expect(result).toMatchObject({
      schedule_id: 'sched-object',
      work_hours: 9,
      source: 'object',
    });
  });

  it('returns null when object has no assigned schedule on date', async () => {
    const result = await resolveObjectSchedule('obj-missing', '2026-04-10');
    expect(result).toBeNull();
  });

  it('builds daily object schedules only for dates covered by object assignment periods', async () => {
    mockedState.resolver = (query) => {
      if (query.table === 'object_schedule_assignments') {
        return {
          data: [
            {
              object_id: 'obj-a',
              effective_from: '2026-04-01',
              effective_to: '2026-04-02',
              work_schedules: {
                id: 'sched-a',
                schedule_type: 'office',
                work_start: '09:00:00',
                work_end: '12:00:00',
                work_hours: 3,
                work_days: [1, 2, 3, 4, 5],
                office_days: null,
                late_threshold_minutes: 0,
                day_overrides: null,
                lunch_minutes: 0,
                respects_holidays: true,
                pattern_type: 'custom',
                expected_saturdays_per_month: 0,
                full_day_threshold_minutes: null,
                weekend_full_day_threshold_minutes: null,
              },
            },
            {
              object_id: 'obj-b',
              effective_from: '2026-04-02',
              effective_to: null,
              work_schedules: {
                id: 'sched-b',
                schedule_type: 'office',
                work_start: '10:00:00',
                work_end: '14:00:00',
                work_hours: 4,
                work_days: [1, 2, 3, 4, 5],
                office_days: null,
                late_threshold_minutes: 0,
                day_overrides: null,
                lunch_minutes: 0,
                respects_holidays: true,
                pattern_type: 'custom',
                expected_saturdays_per_month: 0,
                full_day_threshold_minutes: null,
                weekend_full_day_threshold_minutes: null,
              },
            },
          ],
          error: null,
        };
      }

      throw new Error(`Unexpected query for table ${query.table}`);
    };

    const result = await resolveObjectSchedulesForPeriod(
      ['obj-a', 'obj-b', 'obj-c'],
      '2026-04-01',
      '2026-04-03',
    );

    expect(result.get('obj-a')).toEqual(new Map([
      ['2026-04-01', expect.objectContaining({ schedule_id: 'sched-a', source: 'object' })],
      ['2026-04-02', expect.objectContaining({ schedule_id: 'sched-a', source: 'object' })],
    ]));
    expect(result.get('obj-b')).toEqual(new Map([
      ['2026-04-02', expect.objectContaining({ schedule_id: 'sched-b', source: 'object' })],
      ['2026-04-03', expect.objectContaining({ schedule_id: 'sched-b', source: 'object' })],
    ]));
    expect(result.has('obj-c')).toBe(false);
  });
});

describe('schedule.service pre-holidays', () => {
  const baseSchedule: IResolvedSchedule = {
    schedule_id: 's-1',
    schedule_type: 'office',
    work_start: '09:00:00',
    work_end: '18:00:00',
    work_hours: 8,
    work_days: [1, 2, 3, 4, 5],
    office_days: null,
    late_threshold_minutes: 0,
    day_overrides: null,
    lunch_minutes: 60,
    respects_holidays: true,
    pattern_type: 'custom',
    expected_saturdays_per_month: 0,
    full_day_threshold_minutes: null,
    weekend_full_day_threshold_minutes: null,
    source: 'default',
  };

  const calendar: IProductionCalendarMonth = {
    year: 2026,
    month: 12,
    norm_days: 23,
    norm_hours: 183,
    holidays: [],
    mandatory_holidays: [],
    pre_holidays: ['2026-12-30'],
  };

  it('getDayNormHours: обычный будний день — work_hours без вычета', () => {
    // 2026-12-29 — вторник, обычный будний день
    expect(getDayNormHours(baseSchedule, new Date(2026, 11, 29), calendar)).toBe(8);
  });

  it('getDayNormHours: предпраздничный будень при respects_holidays=true — work_hours - 1', () => {
    // 2026-12-30 — среда, предпразник
    expect(getDayNormHours(baseSchedule, new Date(2026, 11, 30), calendar)).toBe(7);
  });

  it('getDayNormHours: respects_holidays=false — без вычета даже в предпразник', () => {
    const sched = { ...baseSchedule, respects_holidays: false };
    expect(getDayNormHours(sched, new Date(2026, 11, 30), calendar)).toBe(8);
  });

  it('getDayNormHours: предпразник, выпавший на нерабочий день по графику — 0', () => {
    // суббота 2026-01-03 — выходной по 5-дневке
    const sat = { ...calendar, pre_holidays: ['2026-01-03'] };
    expect(getDayNormHours(baseSchedule, new Date(2026, 0, 3), sat)).toBe(0);
  });

  it('getDayNormHours: work_hours < 1 (короткий override) clamp до 0', () => {
    const tiny = { ...baseSchedule, work_hours: 0.5 };
    expect(getDayNormHours(tiny, new Date(2026, 11, 30), calendar)).toBe(0);
  });

  it('countNormHoursForSchedule: вычитает 1ч за каждый предпраздничный будний день', () => {
    // декабрь 2026: 23 будня × 8ч = 184ч; один предпразник 30.12 (среда) → 183
    const total = countNormHoursForSchedule(2026, 12, baseSchedule, calendar);
    const without = countNormHoursForSchedule(2026, 12, baseSchedule, { ...calendar, pre_holidays: [] });
    expect(without - total).toBe(1);
  });

  it('getFullDayThresholdHoursForDate: порог снижается на 1ч в предпразник (fallback от work_hours-lunch)', () => {
    // обычный будень: (8*60 - 60)/60 = 7
    expect(getFullDayThresholdHoursForDate(baseSchedule, new Date(2026, 11, 29), calendar)).toBe(7);
    // предпразник: (8*60 - 60 - 60)/60 = 6
    expect(getFullDayThresholdHoursForDate(baseSchedule, new Date(2026, 11, 30), calendar)).toBe(6);
  });

  it('getFullDayThresholdHoursForDate: явно заданный full_day_threshold_minutes тоже снижается на 60мин в предпразник', () => {
    const sched = { ...baseSchedule, full_day_threshold_minutes: 480 };
    expect(getFullDayThresholdHoursForDate(sched, new Date(2026, 11, 29), calendar)).toBe(8);
    expect(getFullDayThresholdHoursForDate(sched, new Date(2026, 11, 30), calendar)).toBe(7);
  });
});
