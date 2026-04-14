import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  internalPoints: new Set<string>(),
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

vi.mock('./skud-shared.service.js', () => ({
  getInternalAccessPoints: vi.fn(async () => mockedState.internalPoints),
}));

import {
  buildObjectAttendanceData,
  UNKNOWN_OBJECT_NAME,
} from './timesheet-object.service.js';

describe('timesheet-object.service', () => {
  beforeEach(() => {
    mockedState.queryLog.length = 0;
    mockedState.internalPoints = new Set();
    mockedState.resolver = (query) => {
      if (query.table === 'skud_object_access_points') {
        return {
          data: [
            { object_id: 'obj-a', access_point_name: 'КПП A' },
            { object_id: 'obj-b', access_point_name: 'КПП B' },
          ],
          error: null,
        };
      }
      if (query.table === 'skud_objects') {
        return {
          data: [
            { id: 'obj-a', name: 'Объект A' },
            { id: 'obj-b', name: 'Объект B' },
          ],
          error: null,
        };
      }
      if (query.table === 'skud_events') {
        return { data: [], error: null };
      }
      throw new Error(`Unexpected query for table ${query.table}`);
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('groups repeated visits to the same object and exposes only multi-object employees for disclosure', async () => {
    mockedState.resolver = (query) => {
      if (query.table === 'skud_object_access_points') {
        return {
          data: [
            { object_id: 'obj-a', access_point_name: 'КПП A' },
            { object_id: 'obj-b', access_point_name: 'КПП B' },
          ],
          error: null,
        };
      }
      if (query.table === 'skud_objects') {
        return {
          data: [
            { id: 'obj-a', name: 'Объект A' },
            { id: 'obj-b', name: 'Объект B' },
          ],
          error: null,
        };
      }
      if (query.table === 'skud_events') {
        return {
          data: [
            { employee_id: 1, event_date: '2026-04-10', event_time: '09:00:00', access_point: 'КПП A', direction: 'entry' },
            { employee_id: 1, event_date: '2026-04-10', event_time: '12:00:00', access_point: 'КПП A', direction: 'exit' },
            { employee_id: 1, event_date: '2026-04-10', event_time: '12:30:00', access_point: 'КПП B', direction: 'entry' },
            { employee_id: 1, event_date: '2026-04-10', event_time: '15:00:00', access_point: 'КПП B', direction: 'exit' },
            { employee_id: 1, event_date: '2026-04-10', event_time: '15:30:00', access_point: 'КПП A', direction: 'entry' },
            { employee_id: 1, event_date: '2026-04-10', event_time: '18:00:00', access_point: 'КПП A', direction: 'exit' },
          ],
          error: null,
        };
      }
      throw new Error(`Unexpected query for table ${query.table}`);
    };

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-04-10',
      endDate: '2026-04-10',
      todayStr: '2026-04-10',
      adjustments: [],
    });

    expect(result.objectEntries).toEqual([
      expect.objectContaining({
        employee_id: 1,
        work_date: '2026-04-10',
        object_id: 'obj-a',
        object_name: 'Объект A',
        hours_worked: 5.5,
      }),
      expect.objectContaining({
        employee_id: 1,
        work_date: '2026-04-10',
        object_id: 'obj-b',
        object_name: 'Объект B',
        hours_worked: 2.5,
      }),
    ]);
    expect(result.employeeDistinctObjectKeys.get(1)).toEqual(new Set(['obj-a', 'obj-b']));
  });

  it('marks unknown access points as synthetic object and keeps open current interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 11, 11, 30, 0));

    mockedState.resolver = (query) => {
      if (query.table === 'skud_object_access_points') {
        return {
          data: [{ object_id: 'obj-a', access_point_name: 'КПП A' }],
          error: null,
        };
      }
      if (query.table === 'skud_objects') {
        return {
          data: [{ id: 'obj-a', name: 'Объект A' }],
          error: null,
        };
      }
      if (query.table === 'skud_events') {
        return {
          data: [
            { employee_id: 1, event_date: '2026-04-11', event_time: '06:00:00', access_point: 'КПП X', direction: 'entry' },
            { employee_id: 1, event_date: '2026-04-11', event_time: '08:00:00', access_point: 'КПП X', direction: 'exit' },
            { employee_id: 1, event_date: '2026-04-11', event_time: '09:00:00', access_point: 'КПП A', direction: 'entry' },
          ],
          error: null,
        };
      }
      throw new Error(`Unexpected query for table ${query.table}`);
    };

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-04-11',
      endDate: '2026-04-11',
      todayStr: '2026-04-11',
      adjustments: [],
    });

    expect(result.objectEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        object_name: 'Объект A',
        hours_worked: 2.5,
      }),
      expect.objectContaining({
        object_name: UNKNOWN_OBJECT_NAME,
        hours_worked: 2,
      }),
    ]));
    expect(result.objectEntries).toHaveLength(2);
  });

  it('overrides only the targeted object when manual object adjustment exists', async () => {
    mockedState.resolver = (query) => {
      if (query.table === 'skud_object_access_points') {
        return {
          data: [
            { object_id: 'obj-a', access_point_name: 'КПП A' },
            { object_id: 'obj-b', access_point_name: 'КПП B' },
          ],
          error: null,
        };
      }
      if (query.table === 'skud_objects') {
        return {
          data: [
            { id: 'obj-a', name: 'Объект A' },
            { id: 'obj-b', name: 'Объект B' },
          ],
          error: null,
        };
      }
      if (query.table === 'skud_events') {
        return {
          data: [
            { employee_id: 1, event_date: '2026-04-12', event_time: '09:00:00', access_point: 'КПП A', direction: 'entry' },
            { employee_id: 1, event_date: '2026-04-12', event_time: '12:00:00', access_point: 'КПП A', direction: 'exit' },
            { employee_id: 1, event_date: '2026-04-12', event_time: '12:30:00', access_point: 'КПП B', direction: 'entry' },
            { employee_id: 1, event_date: '2026-04-12', event_time: '15:30:00', access_point: 'КПП B', direction: 'exit' },
          ],
          error: null,
        };
      }
      throw new Error(`Unexpected query for table ${query.table}`);
    };

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-04-12',
      endDate: '2026-04-12',
      todayStr: '2026-04-12',
      adjustments: [
        {
          id: 55,
          employee_id: 1,
          work_date: '2026-04-12',
          hours_override: 4,
          source_type: 'manual_object',
          source_id: 'obj-b',
          reason: 'Руководитель поправил часы',
          updated_at: '2026-04-12T12:00:00.000Z',
          metadata: {
            object_id: 'obj-b',
            object_name: 'Объект B',
          },
        },
      ],
    });

    expect(result.objectEntries).toEqual([
      expect.objectContaining({
        object_name: 'Объект A',
        hours_worked: 3,
        is_correction: false,
      }),
      expect.objectContaining({
        adjustment_id: 55,
        object_name: 'Объект B',
        base_hours_worked: 3,
        hours_worked: 4,
        is_correction: true,
      }),
    ]);
  });

  it('blocks object disclosure when a split day has legacy day-level adjustment', async () => {
    mockedState.resolver = (query) => {
      if (query.table === 'skud_object_access_points') {
        return {
          data: [
            { object_id: 'obj-a', access_point_name: 'КПП A' },
            { object_id: 'obj-b', access_point_name: 'КПП B' },
          ],
          error: null,
        };
      }
      if (query.table === 'skud_objects') {
        return {
          data: [
            { id: 'obj-a', name: 'Объект A' },
            { id: 'obj-b', name: 'Объект B' },
          ],
          error: null,
        };
      }
      if (query.table === 'skud_events') {
        return {
          data: [
            { employee_id: 1, event_date: '2026-04-13', event_time: '09:00:00', access_point: 'КПП A', direction: 'entry' },
            { employee_id: 1, event_date: '2026-04-13', event_time: '12:00:00', access_point: 'КПП A', direction: 'exit' },
            { employee_id: 1, event_date: '2026-04-13', event_time: '12:30:00', access_point: 'КПП B', direction: 'entry' },
            { employee_id: 1, event_date: '2026-04-13', event_time: '15:30:00', access_point: 'КПП B', direction: 'exit' },
          ],
          error: null,
        };
      }
      throw new Error(`Unexpected query for table ${query.table}`);
    };

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-04-13',
      endDate: '2026-04-13',
      todayStr: '2026-04-13',
      adjustments: [
        {
          id: 77,
          employee_id: 1,
          work_date: '2026-04-13',
          hours_override: 8,
          source_type: 'manual',
          source_id: 'manual',
          reason: 'Старая дневная корректировка',
          updated_at: '2026-04-13T10:00:00.000Z',
          metadata: {},
        },
      ],
    });

    expect(result.objectEntries).toEqual([]);
    expect(result.legacyBlockedDays.get('1_2026-04-13')).toBeTruthy();
  });
});
