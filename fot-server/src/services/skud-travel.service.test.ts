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

import { calculateAndSyncTravelSegments } from './skud-travel.service.js';
import { listTravelRoutes } from './skud-travel-routes.service.js';

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
      // Внутри лимита — фактическое время полностью идёт в зачёт.
      credited_minutes: 45,
      delay_minutes: 0,
      status: 'auto_approved',
    });
    expect(result.summaryByDay.get('7_2026-04-05')).toEqual({
      creditedMinutes: 45,
      delayMinutes: 0,
      segmentsCount: 1,
      problematicSegmentsCount: 0,
      pendingSegmentsCount: 0,
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

  it('marks a segment as pending and credits only the limit when actual travel exceeds it', async () => {
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
      // Превышение лимита: лимитная часть зачитывается автоматически, превышение ждёт решения.
      credited_minutes: 60,
      delay_minutes: 20,
      status: 'pending',
    });
    expect(result.summaryByDay.get('8_2026-04-06')).toEqual({
      creditedMinutes: 60,
      delayMinutes: 20,
      segmentsCount: 1,
      problematicSegmentsCount: 1,
      pendingSegmentsCount: 1,
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
      pendingSegmentsCount: 0,
      objectProblemSegmentsCount: 1,
    });
  });

  it('preserves approved status and credited minutes across resync', async () => {
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
            { employee_id: 11, event_date: '2026-04-08', event_time: '10:00:00', access_point: 'КПП A', direction: 'exit' },
            { employee_id: 11, event_date: '2026-04-08', event_time: '11:30:00', access_point: 'КПП B', direction: 'entry' },
          ],
          error: null,
        };
      }

      if (query.table === 'skud_travel_segments') {
        // Запрос ранее принятых решений: фильтр по status IN (approved, rejected)
        const hasApprovedRejectedFilter = query.operations.some(op => (
          op.method === 'in'
          && op.args[0] === 'status'
          && Array.isArray(op.args[1])
          && (op.args[1] as string[]).includes('approved')
        ));
        if (hasApprovedRejectedFilter) {
          return {
            data: [{
              id: 'seg-1',
              employee_id: 11,
              work_date: '2026-04-08',
              from_object_id: 'obj-a',
              to_object_id: 'obj-b',
              from_access_point_name: 'КПП A',
              to_access_point_name: 'КПП B',
              exit_time: '10:00:00',
              entry_time: '11:30:00',
              actual_minutes: 90,
              norm_minutes: 60,
              max_credit_minutes: 60,
              credited_minutes: 90,
              delay_minutes: 30,
              status: 'approved',
              approved_by: 'user-9',
              approved_at: '2026-04-08T11:35:00Z',
              approval_comment: 'Пробка',
              created_at: '2026-04-08T11:30:00Z',
              updated_at: '2026-04-08T11:35:00Z',
            }],
            error: null,
          };
        }
        return { data: [], error: null };
      }

      throw new Error(`Unexpected query for table ${query.table}`);
    };

    const result = await calculateAndSyncTravelSegments({
      employeeIds: [11],
      startDate: '2026-04-01',
      endDate: '2026-04-30',
    });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({
      employee_id: 11,
      work_date: '2026-04-08',
      actual_minutes: 90,
      norm_minutes: 60,
      delay_minutes: 30,
      // Решение approved сохранилось через пересчёт: credited = actual_minutes
      credited_minutes: 90,
      status: 'approved',
      approved_by: 'user-9',
      approval_comment: 'Пробка',
    });
    expect(result.summaryByDay.get('11_2026-04-08')).toEqual({
      creditedMinutes: 90,
      delayMinutes: 30,
      segmentsCount: 1,
      // approved уже не считается проблемным.
      problematicSegmentsCount: 0,
      pendingSegmentsCount: 0,
      objectProblemSegmentsCount: 0,
    });
  });

  it('preserves rejected status and credits only the limit across resync', async () => {
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
            { employee_id: 12, event_date: '2026-04-09', event_time: '10:00:00', access_point: 'КПП A', direction: 'exit' },
            { employee_id: 12, event_date: '2026-04-09', event_time: '12:00:00', access_point: 'КПП B', direction: 'entry' },
          ],
          error: null,
        };
      }

      if (query.table === 'skud_travel_segments') {
        const hasApprovedRejectedFilter = query.operations.some(op => (
          op.method === 'in'
          && op.args[0] === 'status'
          && Array.isArray(op.args[1])
          && (op.args[1] as string[]).includes('rejected')
        ));
        if (hasApprovedRejectedFilter) {
          return {
            data: [{
              id: 'seg-2',
              employee_id: 12,
              work_date: '2026-04-09',
              from_object_id: 'obj-a',
              to_object_id: 'obj-b',
              from_access_point_name: 'КПП A',
              to_access_point_name: 'КПП B',
              exit_time: '10:00:00',
              entry_time: '12:00:00',
              actual_minutes: 120,
              norm_minutes: 60,
              max_credit_minutes: 60,
              credited_minutes: 60,
              delay_minutes: 60,
              status: 'rejected',
              approved_by: 'user-9',
              approved_at: '2026-04-09T12:05:00Z',
              approval_comment: null,
              created_at: '2026-04-09T12:00:00Z',
              updated_at: '2026-04-09T12:05:00Z',
            }],
            error: null,
          };
        }
        return { data: [], error: null };
      }

      throw new Error(`Unexpected query for table ${query.table}`);
    };

    const result = await calculateAndSyncTravelSegments({
      employeeIds: [12],
      startDate: '2026-04-01',
      endDate: '2026-04-30',
    });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({
      actual_minutes: 120,
      norm_minutes: 60,
      delay_minutes: 60,
      // Reject: засчитывается только лимитная часть, превышение отбрасывается.
      credited_minutes: 60,
      status: 'rejected',
    });
  });

  it('skips a stray duplicate exit at the destination and still detects the travel from origin', async () => {
    // Реальный кейс: сотрудник в 12:39 вышел из Офис, в 14:43 случайно приложил карту
    // на «выход» вместо «входа» на Борисовских прудах, в 14:46 вошёл нормально.
    // Раньше парный поиск ломался (exit→exit→entry дают пары exit/exit и same-object exit/entry).
    mockedState.travelLimitMinutes = 90;
    mockedState.resolver = (query) => {
      if (query.table === 'skud_object_access_points') {
        return {
          data: [
            { object_id: 'obj-office', access_point_name: 'Офис' },
            { object_id: 'obj-bor', access_point_name: 'Борисовские пруды' },
          ],
          error: null,
        };
      }

      if (query.table === 'skud_events') {
        return {
          data: [
            { employee_id: 13, event_date: '2026-04-29', event_time: '08:23:00', access_point: 'Офис', direction: 'entry' },
            { employee_id: 13, event_date: '2026-04-29', event_time: '12:39:00', access_point: 'Офис', direction: 'exit' },
            { employee_id: 13, event_date: '2026-04-29', event_time: '14:43:00', access_point: 'Борисовские пруды', direction: 'exit' },
            { employee_id: 13, event_date: '2026-04-29', event_time: '14:46:00', access_point: 'Борисовские пруды', direction: 'entry' },
            { employee_id: 13, event_date: '2026-04-29', event_time: '17:35:00', access_point: 'Борисовские пруды', direction: 'exit' },
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
      employeeIds: [13],
      startDate: '2026-04-01',
      endDate: '2026-04-30',
    });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({
      employee_id: 13,
      work_date: '2026-04-29',
      from_access_point_name: 'Офис',
      to_access_point_name: 'Борисовские пруды',
      exit_time: '12:39:00',
      entry_time: '14:46:00',
      // 12:39 -> 14:46 = 2ч 7м = 127 мин при лимите 90 мин -> превышение 37 мин.
      actual_minutes: 127,
      norm_minutes: 90,
      delay_minutes: 37,
      credited_minutes: 90,
      status: 'pending',
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
