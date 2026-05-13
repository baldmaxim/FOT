import { beforeEach, describe, expect, it, vi } from 'vitest';

type RowMap = Record<string, unknown>;

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

// presence-polling.service оборачивает горячие RPC и UPSERT'ы в withDbSlot
// (семафор контроля concurrency). В тестах он должен быть прозрачным wrapper'ом.
const dbSlotMock = vi.hoisted(() => ({
  withDbSlot: vi.fn(async <T>(_label: string, fn: () => Promise<T>): Promise<T> => fn()),
  getDbInflight: vi.fn(() => 0),
}));

vi.mock('../config/db-instrumentation.js', () => ({
  withDbSlot: dbSlotMock.withDbSlot,
  getDbInflight: dbSlotMock.getDbInflight,
}));

type RuntimeStateRow = {
  key: string;
  checkpoint_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  meta: Record<string, unknown>;
  updated_at: string;
};

const mockedState = vi.hoisted(() => ({
  envMock: {
    interval: '5000',
  },
  // Контролируемые результаты SQL по типам запросов.
  responses: {
    employees: [] as RowMap[],
    latestStoredEvent: null as RowMap | null,
    /** Очередь результатов upsert-call'ов: каждая запись либо rows[], либо ошибку. */
    upsertQueue: [] as Array<{ ok: true; rows: RowMap[] } | { ok: false; message: string }>,
    /** Очередь результатов summary RPC. */
    summaryQueue: [] as Array<{ ok: true } | { ok: false; message: string }>,
  },
  // Сюда копится фактический payload каждого upsert-вызова.
  upsertPayloadLog: [] as RowMap[][],
  // Сюда — параметры RPC recalc_summary (массив pairs).
  rpcPairsLog: [] as Array<Array<{ emp_id: number; date: string }>>,
  ioMock: {
    emit: vi.fn(),
  },
  sigurServiceMock: {
    isConfigured: vi.fn(() => true),
    getBackgroundConnectionType: vi.fn(() => 'external'),
    getEvents: vi.fn<(...args: unknown[]) => Promise<Array<Record<string, unknown>>>>(async () => []),
    getEventsByLastId: vi.fn<(...args: unknown[]) => Promise<Array<Record<string, unknown>>>>(async () => []),
    // Делегаты для совместимости со старыми тестами: запаковывают результат getEvents/getEventsByLastId
    // в { pass, failures }, чтобы вызовы getEvents.toHaveBeenCalledWith() продолжали работать.
    getEventsWithFailures: vi.fn(async (
      startTime?: string,
      endTime?: string,
      connection?: 'internal' | 'external',
      extraParams?: Record<string, unknown>,
    ) => {
      const args: unknown[] = [startTime, endTime, connection, 'PASS_DETECTED'];
      if (extraParams !== undefined) args.push(extraParams);
      const pass = await (mockedState.sigurServiceMock.getEvents as (...a: unknown[]) => Promise<Array<Record<string, unknown>>>)(...args);
      return { pass, failures: [] as Array<Record<string, unknown>> };
    }),
    getEventsByLastIdWithFailures: vi.fn(async (
      lastEventId: number,
      connection?: 'internal' | 'external',
      pageSize?: number,
    ) => {
      const args: unknown[] = [lastEventId, 'PASS_DETECTED', connection];
      if (pageSize !== undefined) args.push(pageSize);
      const pass = await (mockedState.sigurServiceMock.getEventsByLastId as (...a: unknown[]) => Promise<Array<Record<string, unknown>>>)(...args);
      return { pass, failures: [] as Array<Record<string, unknown>> };
    }),
  },
  sigurMonitorMock: {
    markPresencePollingCycleStarted: vi.fn(),
    markPresencePollingCycleFinished: vi.fn(),
    recordSigurMonitorSuccess: vi.fn(async () => undefined),
    recordSigurMonitorFailure: vi.fn(async () => undefined),
  },
  runtimeStateMock: {
    statesByKey: {} as Record<string, RuntimeStateRow | null>,
    getSigurRuntimeState: vi.fn(async (key: string) => mockedState.runtimeStateMock.statesByKey[key] || null),
    tryAcquireSigurRuntimeLease: vi.fn(async (params: {
      key: string;
      owner: string;
      ttlSeconds: number;
      meta?: Record<string, unknown>;
    }) => {
      const nowIso = new Date().toISOString();
      const current = mockedState.runtimeStateMock.statesByKey[params.key];
      const nextState: RuntimeStateRow = {
        key: params.key,
        checkpoint_at: current?.checkpoint_at || null,
        lease_owner: params.owner,
        lease_expires_at: new Date(Date.now() + (params.ttlSeconds * 1000)).toISOString(),
        heartbeat_at: nowIso,
        meta: {
          ...(current?.meta || {}),
          ...(params.meta || {}),
        },
        updated_at: nowIso,
      };
      mockedState.runtimeStateMock.statesByKey[params.key] = nextState;
      return { acquired: true, row: nextState };
    }),
    mergeSigurRuntimeState: vi.fn(async (params: {
      key: string;
      checkpointAt?: Date | null;
      meta?: Record<string, unknown>;
      owner?: string | null;
    }) => {
      const current = mockedState.runtimeStateMock.statesByKey[params.key];
      const currentCheckpointMs = current?.checkpoint_at ? Date.parse(current.checkpoint_at) : Number.NEGATIVE_INFINITY;
      const nextCheckpointMs = params.checkpointAt ? params.checkpointAt.getTime() : currentCheckpointMs;
      const checkpoint_at = Number.isFinite(Math.max(currentCheckpointMs, nextCheckpointMs))
        ? new Date(Math.max(currentCheckpointMs, nextCheckpointMs)).toISOString()
        : null;
      const nextState: RuntimeStateRow = {
        key: params.key,
        checkpoint_at,
        lease_owner: current?.lease_owner || null,
        lease_expires_at: current?.lease_expires_at || null,
        heartbeat_at: current?.heartbeat_at || null,
        meta: {
          ...(current?.meta || {}),
          ...(params.meta || {}),
        },
        updated_at: new Date('2026-03-27T10:00:00.000Z').toISOString(),
      };
      mockedState.runtimeStateMock.statesByKey[params.key] = nextState;
      return nextState;
    }),
    releaseSigurRuntimeLease: vi.fn(async (params: { key: string; owner: string }) => {
      const current = mockedState.runtimeStateMock.statesByKey[params.key];
      if (!current || current.lease_owner !== params.owner) {
        return false;
      }
      mockedState.runtimeStateMock.statesByKey[params.key] = {
        ...current,
        lease_owner: null,
        lease_expires_at: null,
        heartbeat_at: null,
        updated_at: new Date('2026-03-27T10:00:00.000Z').toISOString(),
      };
      return true;
    }),
    startSigurRuntimeLeaseHeartbeat: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../config/env.js', () => ({
  env: {
    get SIGUR_PRESENCE_POLL_INTERVAL_MS() {
      return mockedState.envMock.interval;
    },
  },
}));

vi.mock('./sigur.service.js', () => ({
  sigurService: mockedState.sigurServiceMock,
}));

vi.mock('../socket/io-instance.js', () => ({
  getIo: () => mockedState.ioMock,
}));

vi.mock('./skud-backfill.service.js', () => ({
  backfillUnmatchedEvents: vi.fn(async () => undefined),
}));

vi.mock('./sigur-monitor.service.js', () => ({
  markPresencePollingCycleStarted: mockedState.sigurMonitorMock.markPresencePollingCycleStarted,
  markPresencePollingCycleFinished: mockedState.sigurMonitorMock.markPresencePollingCycleFinished,
  recordSigurMonitorSuccess: mockedState.sigurMonitorMock.recordSigurMonitorSuccess,
  recordSigurMonitorFailure: mockedState.sigurMonitorMock.recordSigurMonitorFailure,
}));

vi.mock('./sigur-runtime-state.service.js', () => ({
  SIGUR_POLLING_LEASE_TTL_SECONDS: 180,
  SIGUR_POLLING_STATE_KEY: 'sigur_presence_polling',
  SIGUR_STRUCTURE_SYNC_STATE_KEY: 'sigur_structure_sync',
  getSigurRuntimeOwner: (scope: string) => `owner:${scope}`,
  getSigurRuntimeState: mockedState.runtimeStateMock.getSigurRuntimeState,
  tryAcquireSigurRuntimeLease: mockedState.runtimeStateMock.tryAcquireSigurRuntimeLease,
  mergeSigurRuntimeState: mockedState.runtimeStateMock.mergeSigurRuntimeState,
  releaseSigurRuntimeLease: mockedState.runtimeStateMock.releaseSigurRuntimeLease,
  startSigurRuntimeLeaseHeartbeat: mockedState.runtimeStateMock.startSigurRuntimeLeaseHeartbeat,
}));

import {
  acquirePresencePollingLock,
  acquireStructureSyncSchedulerLock,
  POLL_OVERLAP_MS,
  pollEventsOnce,
  releasePresencePollingLock,
  releaseStructureSyncSchedulerLock,
  resetPresencePollingStateForTests,
  resolvePresencePollIntervalMs,
} from './presence-polling.service.js';

function makeEvent(params: {
  timestamp: string;
  employeeId?: number;
  name?: string;
  direction?: 'IN' | 'OUT';
  accessPoint?: string;
}) {
  return {
    eventType: 'PASS_DETECTED',
    timestamp: params.timestamp,
    data: {
      direction: params.direction ?? 'IN',
      employeeId: params.employeeId ?? 101,
      cardKey: 'CARD-1',
    },
    additionalData: {
      accessObject: {
        data: {
          id: params.employeeId ?? 101,
          name: params.name ?? 'Иван Иванов',
        },
      },
      accessPoint: {
        name: params.accessPoint ?? 'КПП-1',
      },
    },
  };
}

// ─── Маршрутизатор pg helpers ──────────────────────────────────────────────
// query() обслуживает:
//   1. SELECT ... FROM employees WHERE is_archived = false → mockedState.responses.employees
//   2. INSERT INTO skud_events ... RETURNING employee_id, event_date → берём из upsertQueue
//   3. SELECT public.batch_recalculate_skud_daily_summary($1::jsonb) → берём из summaryQueue
// queryOne() — SELECT event_date, event_time FROM skud_events ORDER BY ... LIMIT 1.
// execute() — INSERT INTO skud_event_failures (нам не критично что вернёт).
function installPgRouter(): void {
  pgQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    const lower = sql.trim().toLowerCase();

    if (lower.startsWith('select id, full_name, sigur_employee_id from employees')) {
      return mockedState.responses.employees;
    }

    if (lower.startsWith('insert into skud_events')) {
      mockedState.upsertPayloadLog.push(reconstructEventBatch(params || []));
      const next = mockedState.responses.upsertQueue.shift();
      if (!next) {
        // Дефолт: пустой результат (все дубликаты).
        return [];
      }
      if (!next.ok) {
        throw new Error(next.message);
      }
      return next.rows;
    }

    if (lower.startsWith('select public.batch_recalculate_skud_daily_summary')) {
      const pairsJson = params?.[0];
      if (typeof pairsJson === 'string') {
        try {
          mockedState.rpcPairsLog.push(JSON.parse(pairsJson));
        } catch {
          mockedState.rpcPairsLog.push([]);
        }
      }
      const next = mockedState.responses.summaryQueue.shift();
      if (next && !next.ok) {
        throw new Error(next.message);
      }
      return [];
    }

    throw new Error(`Unexpected pg.query SQL: ${sql.slice(0, 120)}`);
  });

  pgQueryOne.mockImplementation(async (sql: string) => {
    const lower = sql.trim().toLowerCase();
    if (lower.startsWith('select event_date, event_time from skud_events')) {
      return mockedState.responses.latestStoredEvent;
    }
    return null;
  });

  pgExecute.mockResolvedValue(0);
}

// EVENT_COLUMNS из presence-polling.service: 9 колонок по событию.
const EVENT_COLUMN_COUNT = 9;
function reconstructEventBatch(params: unknown[]): RowMap[] {
  const cols = [
    'physical_person', 'card_number', 'event_date', 'event_time',
    'event_at', 'access_point', 'direction', 'employee_id', 'dedup_hash',
  ];
  const result: RowMap[] = [];
  for (let i = 0; i + EVENT_COLUMN_COUNT <= params.length; i += EVENT_COLUMN_COUNT) {
    const row: RowMap = {};
    for (let c = 0; c < EVENT_COLUMN_COUNT; c++) {
      row[cols[c]] = params[i + c];
    }
    result.push(row);
  }
  return result;
}

describe('presence-polling.service', () => {
  beforeEach(() => {
    pgQuery.mockReset();
    pgQueryOne.mockReset();
    pgExecute.mockReset();
    pgTx.mockReset();

    mockedState.envMock.interval = '5000';
    mockedState.ioMock.emit.mockClear();
    mockedState.responses.employees = [];
    mockedState.responses.latestStoredEvent = null;
    mockedState.responses.upsertQueue = [];
    mockedState.responses.summaryQueue = [];
    mockedState.upsertPayloadLog = [];
    mockedState.rpcPairsLog = [];
    dbSlotMock.withDbSlot.mockClear();
    dbSlotMock.withDbSlot.mockImplementation(async (_label, fn) => fn());
    dbSlotMock.getDbInflight.mockClear();
    dbSlotMock.getDbInflight.mockReturnValue(0);

    mockedState.sigurServiceMock.isConfigured.mockReturnValue(true);
    mockedState.sigurServiceMock.getBackgroundConnectionType.mockReturnValue('external');
    mockedState.sigurServiceMock.getEvents.mockReset();
    mockedState.sigurServiceMock.getEvents.mockResolvedValue([] as Array<Record<string, unknown>>);
    mockedState.sigurMonitorMock.markPresencePollingCycleStarted.mockClear();
    mockedState.sigurMonitorMock.markPresencePollingCycleFinished.mockClear();
    mockedState.sigurMonitorMock.recordSigurMonitorSuccess.mockClear();
    mockedState.sigurMonitorMock.recordSigurMonitorFailure.mockClear();
    mockedState.runtimeStateMock.statesByKey = {};
    mockedState.runtimeStateMock.getSigurRuntimeState.mockClear();
    mockedState.runtimeStateMock.tryAcquireSigurRuntimeLease.mockClear();
    mockedState.runtimeStateMock.mergeSigurRuntimeState.mockClear();
    mockedState.runtimeStateMock.releaseSigurRuntimeLease.mockClear();
    mockedState.runtimeStateMock.startSigurRuntimeLeaseHeartbeat.mockClear();

    installPgRouter();
    resetPresencePollingStateForTests();
  });

  it('uses 5s as the default poll interval and clamps lower values', () => {
    mockedState.envMock.interval = '5000';
    expect(resolvePresencePollIntervalMs()).toBe(5_000);

    mockedState.envMock.interval = '1000';
    expect(resolvePresencePollIntervalMs()).toBe(5_000);

    mockedState.envMock.interval = '20000';
    expect(resolvePresencePollIntervalMs()).toBe(20_000);
  });

  it('requests missed events from the last stored event on cold start', async () => {
    const now = new Date(2026, 2, 27, 12, 0, 0);

    mockedState.responses.latestStoredEvent = { event_date: '2026-03-27', event_time: '08:10:00' };
    mockedState.responses.employees = [{ id: 1, full_name: 'Иван Иванов', sigur_employee_id: 101 }];
    // 1 событие → 1 успешный upsert с одной inserted row.
    mockedState.responses.upsertQueue = [{
      ok: true,
      rows: [{ employee_id: 1, event_date: '2026-03-27' }],
    }];

    mockedState.sigurServiceMock.getEvents.mockResolvedValue([
      makeEvent({ timestamp: '2026-03-27T08:30:00+03:00' }),
    ] as Array<Record<string, unknown>>);

    await pollEventsOnce(now);

    expect(mockedState.sigurServiceMock.getEvents).toHaveBeenCalledWith(
      '2026-03-27T08:08:00',
      '2026-03-27T08:18:00',
      'external',
      'PASS_DETECTED',
    );
    expect(mockedState.sigurMonitorMock.recordSigurMonitorSuccess).toHaveBeenCalledWith(expect.objectContaining({
      source: 'presence_polling',
      connectionType: 'external',
    }));
    expect(mockedState.ioMock.emit).toHaveBeenCalledTimes(1);
    expect(mockedState.ioMock.emit).toHaveBeenCalledWith('presence_updated', expect.objectContaining({
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      employeeIds: expect.any(Array),
      from: '2026-03-27',
      to: '2026-03-27',
      source: 'polling',
      insertedCount: 1,
      recalculatedCount: 1,
    }));
  });

  it('keeps recovering from the previous day but caps the catch-up window length', async () => {
    const now = new Date(2026, 2, 27, 10, 0, 0);

    mockedState.responses.latestStoredEvent = { event_date: '2026-03-26', event_time: '23:58:00' };
    mockedState.responses.employees = [{ id: 1, full_name: 'Иван Иванов', sigur_employee_id: 101 }];

    await pollEventsOnce(now);

    expect(mockedState.sigurServiceMock.getEvents).toHaveBeenCalledWith(
      '2026-03-26T23:56:00',
      '2026-03-27T00:06:00',
      'external',
      'PASS_DETECTED',
    );
  });

  it('advances the shared checkpoint even when the cycle returns no events', async () => {
    const firstNow = new Date(2026, 2, 27, 10, 0, 0);
    const secondNow = new Date(2026, 2, 27, 10, 5, 0);

    mockedState.responses.latestStoredEvent = { event_date: '2026-03-27', event_time: '08:00:00' };
    mockedState.responses.employees = [{ id: 1, full_name: 'Иван Иванов', sigur_employee_id: 101 }];

    await pollEventsOnce(firstNow);
    await pollEventsOnce(secondNow);

    expect(mockedState.sigurServiceMock.getEvents).toHaveBeenNthCalledWith(
      1,
      '2026-03-27T07:58:00',
      '2026-03-27T08:08:00',
      'external',
      'PASS_DETECTED',
    );
    expect(mockedState.sigurServiceMock.getEvents).toHaveBeenNthCalledWith(
      2,
      '2026-03-27T08:06:00',
      '2026-03-27T08:16:00',
      'external',
      'PASS_DETECTED',
    );
    expect(mockedState.runtimeStateMock.mergeSigurRuntimeState).toHaveBeenCalledWith(expect.objectContaining({
      key: 'sigur_presence_polling',
      checkpointAt: expect.any(Date),
      owner: 'owner:sigur_presence_polling',
    }));
    expect(mockedState.ioMock.emit).not.toHaveBeenCalled();
  });

  it('does not advance the checkpoint when persisting events fails', async () => {
    const firstNow = new Date(2026, 2, 27, 10, 0, 0);
    const secondNow = new Date(2026, 2, 27, 10, 5, 0);

    mockedState.responses.latestStoredEvent = { event_date: '2026-03-27', event_time: '09:00:00' };
    mockedState.responses.employees = [{ id: 1, full_name: 'Иван Иванов', sigur_employee_id: 101 }];
    // upsert первого цикла фейлится "temporary insert failure" (НЕ transient: retry не делаем).
    mockedState.responses.upsertQueue = [
      { ok: false, message: 'temporary insert failure' },
    ];

    mockedState.sigurServiceMock.getEvents.mockResolvedValue([
      makeEvent({ timestamp: '2026-03-27T09:15:00+03:00' }),
    ] as Array<Record<string, unknown>>);

    await pollEventsOnce(firstNow);
    expect(mockedState.runtimeStateMock.mergeSigurRuntimeState).toHaveBeenCalledTimes(1);
    expect(mockedState.runtimeStateMock.mergeSigurRuntimeState).toHaveBeenNthCalledWith(1, expect.objectContaining({
      key: 'sigur_presence_polling',
      owner: 'owner:sigur_presence_polling',
      meta: expect.objectContaining({
        lastError: 'Failed to persist Sigur events: temporary insert failure',
      }),
    }));
    expect(mockedState.ioMock.emit).not.toHaveBeenCalled();
    mockedState.ioMock.emit.mockClear();

    // Второй цикл: upsert проходит (1 insertedRow).
    mockedState.responses.upsertQueue = [{
      ok: true,
      rows: [{ employee_id: 1, event_date: '2026-03-27' }],
    }];

    await pollEventsOnce(secondNow);

    expect(mockedState.sigurServiceMock.getEvents).toHaveBeenNthCalledWith(
      1,
      '2026-03-27T08:58:00',
      '2026-03-27T09:08:00',
      'external',
      'PASS_DETECTED',
    );
    expect(mockedState.sigurServiceMock.getEvents).toHaveBeenNthCalledWith(
      2,
      '2026-03-27T08:58:00',
      '2026-03-27T09:08:00',
      'external',
      'PASS_DETECTED',
    );
    expect(mockedState.sigurMonitorMock.recordSigurMonitorFailure).toHaveBeenCalledWith(expect.objectContaining({
      source: 'presence_polling',
      errorMessage: 'Failed to persist Sigur events: temporary insert failure',
    }));
    expect(mockedState.ioMock.emit).toHaveBeenCalledTimes(1);
  });

  it('falls back to the start of the current day when the database has no events', async () => {
    const now = new Date(2026, 2, 27, 9, 30, 0);

    mockedState.responses.latestStoredEvent = null;
    mockedState.responses.employees = [];

    await pollEventsOnce(now);

    expect(mockedState.sigurServiceMock.getEvents).toHaveBeenCalledWith(
      '2026-03-27T00:00:00',
      '2026-03-27T00:10:00',
      'external',
      'PASS_DETECTED',
    );
  });

  it('stores unmatched events instead of dropping them', async () => {
    const now = new Date(2026, 2, 27, 10, 0, 0);

    mockedState.responses.latestStoredEvent = { event_date: '2026-03-27', event_time: '09:00:00' };
    mockedState.responses.employees = [];
    mockedState.responses.upsertQueue = [{ ok: true, rows: [] }];

    mockedState.sigurServiceMock.getEvents.mockResolvedValue([
      makeEvent({ timestamp: '2026-03-27T09:15:00+03:00', employeeId: 999, name: 'Неизвестный Сотрудник' }),
    ] as Array<Record<string, unknown>>);

    await pollEventsOnce(now);

    // Должен быть ровно один upsert с одним event'ом, у которого employee_id=null.
    expect(mockedState.upsertPayloadLog).toHaveLength(1);
    const payload = mockedState.upsertPayloadLog[0];
    expect(payload).toHaveLength(1);
    expect(payload[0].employee_id).toBeNull();
    expect(payload[0].physical_person).toBe('Неизвестный Сотрудник');
    expect(payload[0].event_at).toBe('2026-03-27T09:15:00+03:00');
    // Без матча → нет insertedSummaryKeys → нет вызова recalc RPC.
    expect(mockedState.rpcPairsLog).toHaveLength(0);
  });

  it('forwards all events to upsert and relies on DB dedup (no pre-check query)', async () => {
    // После оптимизации egress пред-запрос существующих dedup_hash удалён.
    // Теперь все события из окна overlap отправляются в upsert, а Postgres
    // отсекает дубликаты через UNIQUE (dedup_hash, event_date) + ON CONFLICT DO NOTHING.
    const now = new Date(2026, 2, 27, 10, 0, 0);

    mockedState.responses.latestStoredEvent = { event_date: '2026-03-27', event_time: '09:00:00' };
    mockedState.responses.employees = [{ id: 1, full_name: 'Иван Иванов', sigur_employee_id: 101 }];
    mockedState.responses.upsertQueue = [{
      ok: true,
      rows: [
        { employee_id: 1, event_date: '2026-03-27' },
        { employee_id: 1, event_date: '2026-03-27' },
      ],
    }];

    mockedState.sigurServiceMock.getEvents.mockResolvedValue([
      makeEvent({ timestamp: '2026-03-27T09:00:00+03:00' }),
      makeEvent({ timestamp: '2026-03-27T09:15:00+03:00' }),
    ] as Array<Record<string, unknown>>);

    await pollEventsOnce(now);

    // Оба события уезжают в upsert; дубликат отсечёт Postgres.
    expect(mockedState.upsertPayloadLog).toHaveLength(1);
    const payload = mockedState.upsertPayloadLog[0];
    expect(payload).toHaveLength(2);
    expect(payload.map(p => p.event_time).sort()).toEqual(['09:00:00', '09:15:00']);
    expect(POLL_OVERLAP_MS).toBeGreaterThan(0);

    // Пред-select по dedup_hash больше не вызывается. Гарантия: pgQuery позвали только для
    // employees + INSERT skud_events + RPC summary.
    const dedupHashCalls = pgQuery.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.toLowerCase().includes('dedup_hash')
      && sql.toLowerCase().startsWith('select'),
    );
    expect(dedupHashCalls).toHaveLength(0);
  });

  it('does not emit realtime updates when the DB ignores overlap duplicates', async () => {
    const now = new Date(2026, 2, 27, 10, 0, 0);

    mockedState.responses.latestStoredEvent = { event_date: '2026-03-27', event_time: '09:00:00' };
    mockedState.responses.employees = [{ id: 1, full_name: 'Иван Иванов', sigur_employee_id: 101 }];
    // upsert ничего не вставил (всё дубликаты).
    mockedState.responses.upsertQueue = [{ ok: true, rows: [] }];

    mockedState.sigurServiceMock.getEvents.mockResolvedValue([
      makeEvent({ timestamp: '2026-03-27T09:00:00+03:00' }),
    ] as Array<Record<string, unknown>>);

    await pollEventsOnce(now);

    // Realtime не срабатывает: totalInserted=0.
    expect(mockedState.ioMock.emit).not.toHaveBeenCalled();

    // Recalc RPC всё равно вызывается — страховка от Bug A (recalc, упавший в предыдущем тике).
    expect(mockedState.rpcPairsLog.length).toBeGreaterThanOrEqual(1);
    expect(mockedState.rpcPairsLog[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ emp_id: 1, date: '2026-03-27' }),
    ]));
    expect(mockedState.sigurMonitorMock.recordSigurMonitorSuccess).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({
        inserted: 0,
        duplicates: 1,
      }),
    }));
  });

  it('passes the actual background connection to the failure hook', async () => {
    const now = new Date(2026, 2, 27, 10, 0, 0);

    mockedState.responses.latestStoredEvent = { event_date: '2026-03-27', event_time: '09:00:00' };

    mockedState.sigurServiceMock.getEvents.mockRejectedValueOnce(new Error('connect ETIMEDOUT external-host:9500'));

    await pollEventsOnce(now);

    expect(mockedState.sigurMonitorMock.recordSigurMonitorFailure).toHaveBeenCalledWith(expect.objectContaining({
      source: 'presence_polling',
      connectionType: 'external',
      errorMessage: 'connect ETIMEDOUT external-host:9500',
    }));
  });

  it('retries the upsert on transient pg errors and succeeds on the second attempt', async () => {
    vi.useFakeTimers();
    try {
      const now = new Date(2026, 2, 27, 10, 0, 0);

      mockedState.responses.latestStoredEvent = { event_date: '2026-03-27', event_time: '09:00:00' };
      mockedState.responses.employees = [{ id: 1, full_name: 'Иван Иванов', sigur_employee_id: 101 }];
      mockedState.responses.upsertQueue = [
        // 1-я попытка: 502 → retry.
        { ok: false, message: '<!DOCTYPE html><html>502 Bad Gateway</html>' },
        // 2-я попытка: успех.
        { ok: true, rows: [{ employee_id: 1, event_date: '2026-03-27' }] },
      ];

      mockedState.sigurServiceMock.getEvents.mockResolvedValue([
        makeEvent({ timestamp: '2026-03-27T09:15:00+03:00' }),
      ] as Array<Record<string, unknown>>);

      const cyclePromise = pollEventsOnce(now);
      await vi.runAllTimersAsync();
      await cyclePromise;

      expect(mockedState.upsertPayloadLog.length).toBe(2);
      expect(mockedState.sigurMonitorMock.recordSigurMonitorFailure).not.toHaveBeenCalled();
      expect(mockedState.sigurMonitorMock.recordSigurMonitorSuccess).toHaveBeenCalledWith(expect.objectContaining({
        meta: expect.objectContaining({ inserted: 1, persistenceErrors: 0, summaryError: null }),
      }));
      expect(mockedState.runtimeStateMock.mergeSigurRuntimeState).toHaveBeenCalledWith(expect.objectContaining({
        checkpointAt: expect.any(Date),
        meta: expect.objectContaining({ lastError: null }),
      }));
      expect(mockedState.ioMock.emit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT advance the checkpoint when ALL upsert retries fail with statement timeout', async () => {
    vi.useFakeTimers();
    try {
      const now = new Date(2026, 2, 27, 10, 0, 0);

      mockedState.responses.latestStoredEvent = { event_date: '2026-03-27', event_time: '09:00:00' };
      mockedState.responses.employees = [{ id: 1, full_name: 'Иван Иванов', sigur_employee_id: 101 }];
      // 1 первичная + 2 retry = 3 attempts, все падают.
      mockedState.responses.upsertQueue = [
        { ok: false, message: 'canceling statement due to statement timeout' },
        { ok: false, message: 'canceling statement due to statement timeout' },
        { ok: false, message: 'canceling statement due to statement timeout' },
      ];

      mockedState.sigurServiceMock.getEvents.mockResolvedValue([
        makeEvent({ timestamp: '2026-03-27T09:15:00+03:00' }),
      ] as Array<Record<string, unknown>>);

      const cyclePromise = pollEventsOnce(now);
      await vi.runAllTimersAsync();
      await cyclePromise;

      expect(mockedState.upsertPayloadLog.length).toBe(3);
      expect(mockedState.runtimeStateMock.mergeSigurRuntimeState).toHaveBeenCalledTimes(1);
      const mergeCall = mockedState.runtimeStateMock.mergeSigurRuntimeState.mock.calls[0][0] as unknown as {
        checkpointAt?: Date;
        meta: { lastError: string };
      };
      expect(mergeCall.checkpointAt).toBeUndefined();
      expect(mergeCall.meta.lastError).toContain('statement timeout');
      expect(mockedState.sigurMonitorMock.recordSigurMonitorFailure).toHaveBeenCalledWith(expect.objectContaining({
        errorMessage: expect.stringContaining('statement timeout'),
      }));
      expect(mockedState.sigurMonitorMock.recordSigurMonitorSuccess).not.toHaveBeenCalled();
      expect(mockedState.ioMock.emit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('advances the checkpoint to the last successful event when a later batch fails with timeout', async () => {
    vi.useFakeTimers();
    try {
      const now = new Date(2026, 2, 27, 10, 0, 0);

      mockedState.responses.latestStoredEvent = { event_date: '2026-03-27', event_time: '09:00:00' };
      mockedState.responses.employees = [{ id: 1, full_name: 'Иван Иванов', sigur_employee_id: 101 }];
      // 1-й батч (200 событий) — успех; 2-й батч (50 событий) — все 3 попытки timeout.
      mockedState.responses.upsertQueue = [
        { ok: true, rows: [] }, // батч 1
        { ok: false, message: 'canceling statement due to statement timeout' },
        { ok: false, message: 'canceling statement due to statement timeout' },
        { ok: false, message: 'canceling statement due to statement timeout' },
      ];

      const events: Array<Record<string, unknown>> = [];
      // 250 событий = 200 (батч 1, успех) + 50 (батч 2, fail после retries).
      for (let i = 0; i < 250; i++) {
        const minute = String(Math.floor(i / 60)).padStart(2, '0');
        const second = String(i % 60).padStart(2, '0');
        events.push(makeEvent({
          timestamp: `2026-03-27T09:${minute}:${second}+03:00`,
          name: `Сотрудник${i}`,
          employeeId: 200 + i,
        }));
      }
      mockedState.sigurServiceMock.getEvents.mockResolvedValue(events);

      const cyclePromise = pollEventsOnce(now);
      await vi.runAllTimersAsync();
      await cyclePromise;

      expect(mockedState.upsertPayloadLog.length).toBe(4);
      expect(mockedState.runtimeStateMock.mergeSigurRuntimeState).toHaveBeenCalledTimes(1);
      const mergeCall = mockedState.runtimeStateMock.mergeSigurRuntimeState.mock.calls[0][0] as unknown as {
        checkpointAt?: Date;
        meta: { lastError: string };
      };
      // Checkpoint должен быть выставлен — до event_at последнего события 1-го батча минус 10s.
      // 200-е событие: i=199 → minute=Math.floor(199/60)=3, second=199%60=19 → 09:03:19 MSK → 06:03:19 UTC
      expect(mergeCall.checkpointAt).toBeInstanceOf(Date);
      const checkpointMs = mergeCall.checkpointAt!.getTime();
      const expectedMaxMs = Date.parse('2026-03-27T09:03:19+03:00');
      expect(checkpointMs).toBe(expectedMaxMs - 10_000);
      expect(mergeCall.meta.lastError).toContain('statement timeout');
      expect(mockedState.sigurMonitorMock.recordSigurMonitorFailure).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries the summary RPC on transient pg responses and records partial failure', async () => {
    vi.useFakeTimers();
    try {
      const now = new Date(2026, 2, 27, 10, 0, 0);

      mockedState.responses.latestStoredEvent = { event_date: '2026-03-27', event_time: '09:00:00' };
      mockedState.responses.employees = [{ id: 1, full_name: 'Иван Иванов', sigur_employee_id: 101 }];
      mockedState.responses.upsertQueue = [{ ok: true, rows: [{ employee_id: 1, event_date: '2026-03-27' }] }];
      // 1 первичная + 2 retry = 3 attempts, все падают на <!DOCTYPE.
      mockedState.responses.summaryQueue = [
        { ok: false, message: '<!DOCTYPE html><html><head><title>502</title></head></html>' },
        { ok: false, message: '<!DOCTYPE html><html><head><title>502</title></head></html>' },
        { ok: false, message: '<!DOCTYPE html><html><head><title>502</title></head></html>' },
      ];

      mockedState.sigurServiceMock.getEvents.mockResolvedValue([
        makeEvent({ timestamp: '2026-03-27T09:15:00+03:00' }),
      ] as Array<Record<string, unknown>>);

      const cyclePromise = pollEventsOnce(now);
      await vi.runAllTimersAsync();
      await cyclePromise;

      expect(mockedState.rpcPairsLog.length).toBe(3);
      expect(mockedState.runtimeStateMock.mergeSigurRuntimeState).toHaveBeenCalledTimes(1);
      const mergeCall = mockedState.runtimeStateMock.mergeSigurRuntimeState.mock.calls[0][0] as unknown as {
        checkpointAt?: Date;
        meta: { lastError: string };
      };
      // Inserted ОК → есть lastSuccessfulEventAt → checkpointAt выставляется (— 10s overlap).
      expect(mergeCall.checkpointAt).toBeInstanceOf(Date);
      expect(mergeCall.meta.lastError.toLowerCase()).toContain('<!doctype');
      expect(mockedState.sigurMonitorMock.recordSigurMonitorFailure).toHaveBeenCalled();
      expect(mockedState.sigurMonitorMock.recordSigurMonitorSuccess).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('chunks summary recalc RPC into batches of at most 100 pairs', async () => {
    const now = new Date(2026, 2, 27, 10, 0, 0);

    // 250 событий = 250 уникальных (employee_id, date) пар.
    const employees: Array<{ id: number; full_name: string; sigur_employee_id: number }> = [];
    for (let i = 0; i < 250; i++) {
      employees.push({ id: 1000 + i, full_name: `Сотрудник${i}`, sigur_employee_id: 200 + i });
    }
    mockedState.responses.latestStoredEvent = { event_date: '2026-03-27', event_time: '09:00:00' };
    mockedState.responses.employees = employees;
    // 2 батча по 200/50 событий (presence-polling BATCH_SIZE=200), оба возвращают inserted rows.
    mockedState.responses.upsertQueue = [
      { ok: true, rows: Array.from({ length: 200 }, (_, i) => ({ employee_id: 1000 + i, event_date: '2026-03-27' })) },
      { ok: true, rows: Array.from({ length: 50 }, (_, i) => ({ employee_id: 1200 + i, event_date: '2026-03-27' })) },
    ];

    const events: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 250; i++) {
      const minute = String(Math.floor(i / 60)).padStart(2, '0');
      const second = String(i % 60).padStart(2, '0');
      events.push(makeEvent({
        timestamp: `2026-03-27T09:${minute}:${second}+03:00`,
        name: `Сотрудник${i}`,
        employeeId: 200 + i,
      }));
    }
    mockedState.sigurServiceMock.getEvents.mockResolvedValue(events);

    vi.useFakeTimers();
    try {
      const cyclePromise = pollEventsOnce(now);
      await vi.runAllTimersAsync();
      await cyclePromise;
    } finally {
      vi.useRealTimers();
    }

    // 250 пар → 3 чанка (100 + 100 + 50).
    expect(mockedState.rpcPairsLog).toHaveLength(3);
    for (const chunk of mockedState.rpcPairsLog) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
    const totalPairs = mockedState.rpcPairsLog.reduce((sum, chunk) => sum + chunk.length, 0);
    expect(totalPairs).toBe(250);
  });

  it('uses a dedicated lease for the background structure scheduler', async () => {
    await acquireStructureSyncSchedulerLock();
    await releaseStructureSyncSchedulerLock();

    expect(mockedState.runtimeStateMock.tryAcquireSigurRuntimeLease).toHaveBeenCalledWith(expect.objectContaining({
      key: 'sigur_structure_sync',
      owner: 'owner:sigur_structure_sync',
    }));
    expect(mockedState.runtimeStateMock.releaseSigurRuntimeLease).toHaveBeenCalledWith({
      key: 'sigur_structure_sync',
      owner: 'owner:sigur_structure_sync',
    });
  });

  it('waits for the background structure lease before starting a manual sync', async () => {
    vi.useFakeTimers();

    try {
      const activeStructureLease: RuntimeStateRow = {
        key: 'sigur_structure_sync',
        checkpoint_at: null,
        lease_owner: 'owner:background-structure',
        lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
        heartbeat_at: new Date().toISOString(),
        meta: { leaseMode: 'background_structure_sync' },
        updated_at: new Date().toISOString(),
      };
      let structureChecks = 0;

      mockedState.runtimeStateMock.getSigurRuntimeState.mockImplementation(async (key: string) => {
        if (key === 'sigur_structure_sync') {
          structureChecks += 1;
          return structureChecks < 3 ? activeStructureLease : null;
        }
        return mockedState.runtimeStateMock.statesByKey[key] || null;
      });

      const lockPromise = acquirePresencePollingLock();
      await vi.advanceTimersByTimeAsync(2_100);
      await lockPromise;

      expect(structureChecks).toBe(3);
      expect(mockedState.runtimeStateMock.tryAcquireSigurRuntimeLease).toHaveBeenNthCalledWith(1, expect.objectContaining({
        key: 'sigur_exclusive_sync',
      }));
      expect(mockedState.runtimeStateMock.tryAcquireSigurRuntimeLease).toHaveBeenNthCalledWith(2, expect.objectContaining({
        key: 'sigur_presence_polling',
      }));

      await releasePresencePollingLock();
    } finally {
      resetPresencePollingStateForTests();
      vi.useRealTimers();
    }
  });
});
