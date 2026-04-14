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
  internalPoints: new Set<string>(),
  travelLimitMinutes: 60 as number | null,
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
    gte: (...args: unknown[]) => {
      query.operations.push({ method: 'gte', args });
      return builder;
    },
    lte: (...args: unknown[]) => {
      query.operations.push({ method: 'lte', args });
      return builder;
    },
    order: (...args: unknown[]) => {
      query.operations.push({ method: 'order', args });
      return builder;
    },
    delete: (...args: unknown[]) => {
      query.operations.push({ method: 'delete', args });
      return builder;
    },
    upsert: (...args: unknown[]) => {
      query.operations.push({ method: 'upsert', args });
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

vi.mock('./settings.service.js', () => ({
  settingsService: {
    getSkudTravelConfig: vi.fn(async () => ({ limitMinutes: mockedState.travelLimitMinutes })),
    setSkudTravelConfig: vi.fn(),
  },
}));

import { calculateAndSyncTravelSegments, listTravelRoutes } from './skud-travel.service.js';

describe('skud-travel.service', () => {
  beforeEach(() => {
    mockedState.queryLog.length = 0;
    mockedState.internalPoints = new Set();
    mockedState.travelLimitMinutes = 60;
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

      if (query.table === 'skud_events') {
        return {
          data: [],
          error: null,
        };
      }

      if (query.table === 'skud_travel_segments') {
        return { data: [], error: null };
      }

      throw new Error(`Unexpected query for table ${query.table}`);
    };
  });

  it('builds an auto-approved segment when actual travel fits the configured limit', async () => {
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

      if (query.table === 'skud_events') {
        return {
          data: [
            { employee_id: 7, event_date: '2026-04-05', event_time: '10:00:00', access_point: 'КПП A', direction: 'exit' },
            { employee_id: 7, event_date: '2026-04-05', event_time: '10:45:00', access_point: 'КПП B', direction: 'entry' },
          ],
          error: null,
        };
      }

      if (query.table === 'skud_travel_segments') {
        return { data: [], error: null };
      }

      throw new Error(`Unexpected query for table ${query.table}`);
    };

    const result = await calculateAndSyncTravelSegments({
      employeeIds: [7],
      startDate: '2026-04-01',
      endDate: '2026-04-30',
    });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({
      employee_id: 7,
      work_date: '2026-04-05',
      actual_minutes: 45,
      norm_minutes: 60,
      max_credit_minutes: 60,
      credited_minutes: 0,
      delay_minutes: 0,
      status: 'auto_approved',
    });
    expect(result.summaryByDay.get('7_2026-04-05')).toEqual({
      creditedMinutes: 0,
      delayMinutes: 0,
      segmentsCount: 1,
      problematicSegmentsCount: 0,
      objectProblemSegmentsCount: 0,
    });
  });

  it('returns route limits without applying the legacy 1.5 multiplier', async () => {
    mockedState.resolver = (query) => {
      if (query.table === 'skud_objects') {
        return {
          data: [
            { id: 'obj-a', name: 'Объект A', is_active: true, created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z' },
            { id: 'obj-b', name: 'Объект B', is_active: true, created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z' },
          ],
          error: null,
        };
      }

      if (query.table === 'skud_object_routes') {
        return {
          data: [
            {
              id: 'route-1',
              from_object_id: 'obj-a',
              to_object_id: 'obj-b',
              travel_minutes: 40,
              credit_multiplier: 1.5,
              is_active: true,
              created_at: '2026-04-01T00:00:00Z',
              updated_at: '2026-04-01T00:00:00Z',
            },
          ],
          error: null,
        };
      }

      throw new Error(`Unexpected query for table ${query.table}`);
    };

    await expect(listTravelRoutes()).resolves.toEqual([
      expect.objectContaining({
        id: 'route-1',
        travel_minutes: 40,
        credit_multiplier: 1,
        max_credit_minutes: 40,
      }),
    ]);
  });

  it('marks a segment as delayed when actual travel exceeds the configured limit', async () => {
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

      if (query.table === 'skud_events') {
        return {
          data: [
            { employee_id: 8, event_date: '2026-04-06', event_time: '11:00:00', access_point: 'КПП A', direction: 'exit' },
            { employee_id: 8, event_date: '2026-04-06', event_time: '12:20:00', access_point: 'КПП B', direction: 'entry' },
          ],
          error: null,
        };
      }

      if (query.table === 'skud_travel_segments') {
        return { data: [], error: null };
      }

      throw new Error(`Unexpected query for table ${query.table}`);
    };

    const result = await calculateAndSyncTravelSegments({
      employeeIds: [8],
      startDate: '2026-04-01',
      endDate: '2026-04-30',
    });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({
      actual_minutes: 80,
      norm_minutes: 60,
      credited_minutes: 0,
      delay_minutes: 20,
      status: 'delayed',
    });
    expect(result.summaryByDay.get('8_2026-04-06')).toEqual({
      creditedMinutes: 0,
      delayMinutes: 20,
      segmentsCount: 1,
      problematicSegmentsCount: 1,
      objectProblemSegmentsCount: 0,
    });
  });

  it('marks a segment as needs_object when one of the access points is not mapped to an object', async () => {
    mockedState.resolver = (query) => {
      if (query.table === 'skud_object_access_points') {
        return {
          data: [
            { object_id: 'obj-a', access_point_name: 'КПП A' },
          ],
          error: null,
        };
      }

      if (query.table === 'skud_events') {
        return {
          data: [
            { employee_id: 9, event_date: '2026-04-07', event_time: '08:30:00', access_point: 'КПП A', direction: 'exit' },
            { employee_id: 9, event_date: '2026-04-07', event_time: '09:00:00', access_point: 'КПП Z', direction: 'entry' },
          ],
          error: null,
        };
      }

      if (query.table === 'skud_travel_segments') {
        return { data: [], error: null };
      }

      throw new Error(`Unexpected query for table ${query.table}`);
    };

    const result = await calculateAndSyncTravelSegments({
      employeeIds: [9],
      startDate: '2026-04-01',
      endDate: '2026-04-30',
    });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({
      actual_minutes: 30,
      norm_minutes: null,
      credited_minutes: 0,
      delay_minutes: 0,
      status: 'needs_object',
    });
    expect(result.summaryByDay.get('9_2026-04-07')).toEqual({
      creditedMinutes: 0,
      delayMinutes: 0,
      segmentsCount: 1,
      problematicSegmentsCount: 1,
      objectProblemSegmentsCount: 1,
    });
  });

  it('throws a configuration error when the global travel limit is not set', async () => {
    mockedState.travelLimitMinutes = null;

    await expect(calculateAndSyncTravelSegments({
      employeeIds: [10],
      startDate: '2026-04-01',
      endDate: '2026-04-30',
    })).rejects.toThrow('Не задан единый лимит передвижения');
  });
});
