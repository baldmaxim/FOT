import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const mockedState = vi.hoisted(() => ({
  internalPoints: new Set<string>(),
  travelLimitMinutes: 60 as number | null,
  tables: {
    skud_object_access_points: [] as Array<{ object_id: string; access_point_name: string }>,
    skud_objects: [] as Array<Record<string, unknown>>,
    skud_object_routes: [] as Array<Record<string, unknown>>,
    skud_events: [] as Array<Record<string, unknown>>,
    /** Сегменты ранее принятых решений (status IN ('approved','rejected')) */
    skud_travel_segments_decided: [] as Array<Record<string, unknown>>,
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

// Маршрутизатор SQL → таблица. Сервис формирует параметризованные SELECT'ы
// (`SELECT ... FROM skud_events WHERE ...`), поэтому ловим по подстроке `FROM <table>`.
function routeQuery(sql: string): unknown[] {
  const lower = sql.toLowerCase();
  if (lower.includes('from skud_object_access_points')) {
    return mockedState.tables.skud_object_access_points;
  }
  if (lower.includes('from skud_objects')) {
    return mockedState.tables.skud_objects;
  }
  if (lower.includes('from skud_object_routes')) {
    return mockedState.tables.skud_object_routes;
  }
  if (lower.includes('from skud_events')) {
    return mockedState.tables.skud_events;
  }
  if (lower.includes('from skud_travel_segments')) {
    // fetchExistingDecidedSegments фильтрует по status = ANY($4::text[]).
    // Возвращаем только заранее заданные approved/rejected записи.
    return mockedState.tables.skud_travel_segments_decided;
  }
  throw new Error(`Unexpected SQL in pgQuery: ${sql}`);
}

describe('skud-travel.service', () => {
  beforeEach(() => {
    pgQuery.mockReset();
    pgQueryOne.mockReset();
    pgExecute.mockReset();
    pgTx.mockReset();

    mockedState.internalPoints = new Set();
    mockedState.travelLimitMinutes = 60;
    mockedState.tables.skud_object_access_points = [
      { object_id: 'obj-a', access_point_name: 'КПП A' },
      { object_id: 'obj-b', access_point_name: 'КПП B' },
    ];
    mockedState.tables.skud_objects = [];
    mockedState.tables.skud_object_routes = [];
    mockedState.tables.skud_events = [];
    mockedState.tables.skud_travel_segments_decided = [];

    pgQuery.mockImplementation(async (sql: string) => routeQuery(sql));
    // syncSegmentsToDatabase делает execute('DELETE ...') и execute('INSERT ...'), нам неважно что.
    pgExecute.mockResolvedValue(0);
  });

  it('builds an auto-approved segment when actual travel fits the configured limit', async () => {
    mockedState.tables.skud_events = [
      { employee_id: 7, event_date: '2026-04-05', event_time: '10:00:00', access_point: 'КПП A', direction: 'exit' },
      { employee_id: 7, event_date: '2026-04-05', event_time: '10:45:00', access_point: 'КПП B', direction: 'entry' },
    ];

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
    mockedState.tables.skud_objects = [
      { id: 'obj-a', name: 'Объект A', is_active: true, created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z' },
      { id: 'obj-b', name: 'Объект B', is_active: true, created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z' },
    ];
    mockedState.tables.skud_object_routes = [
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
    ];

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
    mockedState.tables.skud_events = [
      { employee_id: 8, event_date: '2026-04-06', event_time: '11:00:00', access_point: 'КПП A', direction: 'exit' },
      { employee_id: 8, event_date: '2026-04-06', event_time: '12:20:00', access_point: 'КПП B', direction: 'entry' },
    ];

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
    mockedState.tables.skud_object_access_points = [
      { object_id: 'obj-a', access_point_name: 'КПП A' },
    ];
    mockedState.tables.skud_events = [
      { employee_id: 9, event_date: '2026-04-07', event_time: '08:30:00', access_point: 'КПП A', direction: 'exit' },
      { employee_id: 9, event_date: '2026-04-07', event_time: '09:00:00', access_point: 'КПП Z', direction: 'entry' },
    ];

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
    mockedState.tables.skud_events = [
      { employee_id: 11, event_date: '2026-04-08', event_time: '10:00:00', access_point: 'КПП A', direction: 'exit' },
      { employee_id: 11, event_date: '2026-04-08', event_time: '11:30:00', access_point: 'КПП B', direction: 'entry' },
    ];
    mockedState.tables.skud_travel_segments_decided = [{
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
    }];

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
    mockedState.tables.skud_events = [
      { employee_id: 12, event_date: '2026-04-09', event_time: '10:00:00', access_point: 'КПП A', direction: 'exit' },
      { employee_id: 12, event_date: '2026-04-09', event_time: '12:00:00', access_point: 'КПП B', direction: 'entry' },
    ];
    mockedState.tables.skud_travel_segments_decided = [{
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
    }];

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
    mockedState.tables.skud_object_access_points = [
      { object_id: 'obj-office', access_point_name: 'Офис' },
      { object_id: 'obj-bor', access_point_name: 'Борисовские пруды' },
    ];
    mockedState.tables.skud_events = [
      { employee_id: 13, event_date: '2026-04-29', event_time: '08:23:00', access_point: 'Офис', direction: 'entry' },
      { employee_id: 13, event_date: '2026-04-29', event_time: '12:39:00', access_point: 'Офис', direction: 'exit' },
      { employee_id: 13, event_date: '2026-04-29', event_time: '14:43:00', access_point: 'Борисовские пруды', direction: 'exit' },
      { employee_id: 13, event_date: '2026-04-29', event_time: '14:46:00', access_point: 'Борисовские пруды', direction: 'entry' },
      { employee_id: 13, event_date: '2026-04-29', event_time: '17:35:00', access_point: 'Борисовские пруды', direction: 'exit' },
    ];

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
