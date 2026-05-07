import { beforeEach, describe, expect, it, vi } from 'vitest';

type QueryOperation = {
  method: string;
  args: unknown[];
};

type QueryRecord = {
  table: string;
  operations: QueryOperation[];
};

type QueryResponse = {
  data?: unknown;
  error?: { message: string } | null;
};

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
  queryLog: [] as QueryRecord[],
  envMock: {
    interval: '15000',
  },
  queryResolver: (() => ({ data: [], error: null })) as (query: QueryRecord) => QueryResponse | Promise<QueryResponse>,
  ioMock: {
    emit: vi.fn(),
  },
  supabaseMock: {
    from: vi.fn(),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  },
  sigurServiceMock: {
    isConfigured: vi.fn(() => true),
    getBackgroundConnectionType: vi.fn(() => 'external'),
    getEvents: vi.fn<(...args: unknown[]) => Promise<Array<Record<string, unknown>>>>(async () => []),
    getEventsByLastId: vi.fn<(...args: unknown[]) => Promise<Array<Record<string, unknown>>>>(async () => []),
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
    not: (...args: unknown[]) => {
      query.operations.push({ method: 'not', args });
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
    gte: (...args: unknown[]) => {
      query.operations.push({ method: 'gte', args });
      return builder;
    },
    lte: (...args: unknown[]) => {
      query.operations.push({ method: 'lte', args });
      return builder;
    },
    upsert: (...args: unknown[]) => {
      query.operations.push({ method: 'upsert', args });
      return builder;
    },
    then: (onFulfilled: (value: QueryResponse) => unknown, onRejected?: (reason: unknown) => unknown) => {
      const response = mockedState.queryResolver(query);
      return Promise.resolve(response).then(value => {
        const upsert = findOperation(query, 'upsert');
        const selectsInsertedRows = !!upsert && !!findOperation(query, 'select', 'employee_id,event_date');
        if (
          selectsInsertedRows
          && value.error == null
          && value.data == null
          && Array.isArray(upsert.args[0])
        ) {
          return {
            ...value,
            data: (upsert.args[0] as Array<{ employee_id: number | null; event_date: string | null }>)
              .map(row => ({ employee_id: row.employee_id, event_date: row.event_date })),
          };
        }
        return value;
      }).then(onFulfilled, onRejected);
    },
  };

  return builder;
}

mockedState.supabaseMock.from.mockImplementation((table: string) => createBuilder(table));

vi.mock('../config/database.js', () => ({
  supabase: mockedState.supabaseMock,
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

function findOperation(query: QueryRecord, method: string, firstArg?: unknown): QueryOperation | undefined {
  return query.operations.find(op => op.method === method && (firstArg === undefined || op.args[0] === firstArg));
}

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

describe('presence-polling.service', () => {
  beforeEach(() => {
    mockedState.queryLog.length = 0;
    mockedState.envMock.interval = '5000';
    mockedState.ioMock.emit.mockClear();
    mockedState.queryResolver = () => ({ data: [], error: null });
    mockedState.supabaseMock.from.mockClear();
    mockedState.supabaseMock.from.mockImplementation((table: string) => createBuilder(table));
    mockedState.supabaseMock.rpc.mockClear();
    mockedState.supabaseMock.rpc.mockResolvedValue({ data: null, error: null });
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

    mockedState.queryResolver = (query) => {
      if (query.table === 'skud_events' && findOperation(query, 'select', 'event_date, event_time')) {
        return { data: [{ event_date: '2026-03-27', event_time: '08:10:00' }], error: null };
      }
      if (query.table === 'employees') {
        return {
          data: [{ id: 1, full_name: 'Иван Иванов', sigur_employee_id: 101 }],
          error: null,
        };
      }

      if (query.table === 'skud_events' && findOperation(query, 'select', 'dedup_hash')) {
        return { data: [], error: null };
      }
      if (query.table === 'skud_events' && findOperation(query, 'upsert')) {
        return { data: null, error: null };
      }
      throw new Error(`Unexpected query: ${query.table}`);
    };

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

    mockedState.queryResolver = (query) => {
      if (query.table === 'skud_events' && findOperation(query, 'select', 'event_date, event_time')) {
        return { data: [{ event_date: '2026-03-26', event_time: '23:58:00' }], error: null };
      }
      if (query.table === 'employees') {
        return {
          data: [{ id: 1, full_name: 'Иван Иванов', sigur_employee_id: 101 }],
          error: null,
        };
      }

      if (query.table === 'skud_events' && findOperation(query, 'select', 'dedup_hash')) {
        return { data: [], error: null };
      }
      if (query.table === 'skud_events' && findOperation(query, 'upsert')) {
        return { data: null, error: null };
      }
      throw new Error(`Unexpected query: ${query.table}`);
    };

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

    mockedState.queryResolver = (query) => {
      if (query.table === 'skud_events' && findOperation(query, 'select', 'event_date, event_time')) {
        return { data: [{ event_date: '2026-03-27', event_time: '08:00:00' }], error: null };
      }
      if (query.table === 'employees') {
        return {
          data: [{ id: 1, full_name: 'Иван Иванов', sigur_employee_id: 101 }],
          error: null,
        };
      }

      if (query.table === 'skud_events' && findOperation(query, 'select', 'dedup_hash')) {
        return { data: [], error: null };
      }
      throw new Error(`Unexpected query: ${query.table}`);
    };

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
    let upsertCalls = 0;

    mockedState.queryResolver = (query) => {
      if (query.table === 'skud_events' && findOperation(query, 'select', 'event_date, event_time')) {
        return { data: [{ event_date: '2026-03-27', event_time: '09:00:00' }], error: null };
      }
      if (query.table === 'employees') {
        return {
          data: [{ id: 1, full_name: 'Иван Иванов', sigur_employee_id: 101 }],
          error: null,
        };
      }
      if (query.table === 'skud_events' && findOperation(query, 'upsert')) {
        upsertCalls += 1;
        if (upsertCalls === 1) {
          return { data: null, error: { message: 'temporary insert failure' } };
        }
        return { data: null, error: null };
      }
      throw new Error(`Unexpected query: ${query.table}`);
    };

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

    mockedState.queryResolver = (query) => {
      if (query.table === 'skud_events' && findOperation(query, 'select', 'event_date, event_time')) {
        return { data: [], error: null };
      }
      if (query.table === 'employees') {
        return { data: [], error: null };
      }

      if (query.table === 'skud_events' && findOperation(query, 'select', 'dedup_hash')) {
        return { data: [], error: null };
      }
      throw new Error(`Unexpected query: ${query.table}`);
    };

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

    mockedState.queryResolver = (query) => {
      if (query.table === 'skud_events' && findOperation(query, 'select', 'event_date, event_time')) {
        return { data: [{ event_date: '2026-03-27', event_time: '09:00:00' }], error: null };
      }
      if (query.table === 'employees') {
        return { data: [], error: null };
      }

      if (query.table === 'skud_events' && findOperation(query, 'select', 'dedup_hash')) {
        return { data: [], error: null };
      }
      if (query.table === 'skud_events' && findOperation(query, 'upsert')) {
        return { data: null, error: null };
      }
      throw new Error(`Unexpected query: ${query.table}`);
    };

    mockedState.sigurServiceMock.getEvents.mockResolvedValue([
      makeEvent({ timestamp: '2026-03-27T09:15:00+03:00', employeeId: 999, name: 'Неизвестный Сотрудник' }),
    ] as Array<Record<string, unknown>>);

    await pollEventsOnce(now);

    const upsertQuery = mockedState.queryLog.find(query => query.table === 'skud_events' && findOperation(query, 'upsert'));
    const payload = upsertQuery?.operations.find(op => op.method === 'upsert')?.args[0] as Array<{
      employee_id: number | null;
      physical_person: string;
      event_at: string;
    }>;

    expect(payload).toHaveLength(1);
    expect(payload[0]?.employee_id).toBeNull();
    expect(payload[0]?.physical_person).toBe('Неизвестный Сотрудник');
    expect(payload[0]?.event_at).toBe('2026-03-27T09:15:00+03:00');
    expect(mockedState.supabaseMock.rpc).not.toHaveBeenCalled();
  });

  it('forwards all events to upsert and relies on DB dedup (no pre-check query)', async () => {
    // После оптимизации egress пред-запрос существующих dedup_hash удалён.
    // Теперь все события из окна overlap отправляются в upsert, а Postgres
    // отсекает дубликаты через UNIQUE (dedup_hash, event_date) +
    // ignoreDuplicates: true. Это снижает ingress-трафик из Supabase.
    const now = new Date(2026, 2, 27, 10, 0, 0);

    mockedState.queryResolver = (query) => {
      if (query.table === 'skud_events' && findOperation(query, 'select', 'event_date, event_time')) {
        return { data: [{ event_date: '2026-03-27', event_time: '09:00:00' }], error: null };
      }
      if (query.table === 'employees') {
        return {
          data: [{ id: 1, full_name: 'Иван Иванов', sigur_employee_id: 101 }],
          error: null,
        };
      }
      if (query.table === 'skud_events' && findOperation(query, 'upsert')) {
        return { data: null, error: null };
      }
      throw new Error(`Unexpected query: ${query.table}`);
    };

    mockedState.sigurServiceMock.getEvents.mockResolvedValue([
      makeEvent({ timestamp: '2026-03-27T09:00:00+03:00' }),
      makeEvent({ timestamp: '2026-03-27T09:15:00+03:00' }),
    ] as Array<Record<string, unknown>>);

    await pollEventsOnce(now);

    const upsertQuery = mockedState.queryLog.find(query => query.table === 'skud_events' && findOperation(query, 'upsert'));
    const payload = upsertQuery?.operations.find(op => op.method === 'upsert')?.args[0] as Array<{ event_time: string }>;

    // Оба события уезжают в upsert; дубликат отсечёт Postgres
    expect(payload).toHaveLength(2);
    expect(payload.map(p => p.event_time).sort()).toEqual(['09:00:00', '09:15:00']);
    expect(POLL_OVERLAP_MS).toBeGreaterThan(0);

    // Гарантия: пред-select по dedup_hash больше не вызывается
    const preCheck = mockedState.queryLog.find(query =>
      query.table === 'skud_events' && findOperation(query, 'select', 'dedup_hash'),
    );
    expect(preCheck).toBeUndefined();
  });

  it('does not emit realtime updates when the DB ignores overlap duplicates', async () => {
    const now = new Date(2026, 2, 27, 10, 0, 0);

    mockedState.queryResolver = (query) => {
      if (query.table === 'skud_events' && findOperation(query, 'select', 'event_date, event_time')) {
        return { data: [{ event_date: '2026-03-27', event_time: '09:00:00' }], error: null };
      }
      if (query.table === 'employees') {
        return {
          data: [{ id: 1, full_name: 'Иван Иванов', sigur_employee_id: 101 }],
          error: null,
        };
      }
      if (query.table === 'skud_events' && findOperation(query, 'upsert')) {
        return { data: [], error: null };
      }
      throw new Error(`Unexpected query: ${query.table}`);
    };

    mockedState.sigurServiceMock.getEvents.mockResolvedValue([
      makeEvent({ timestamp: '2026-03-27T09:00:00+03:00' }),
    ] as Array<Record<string, unknown>>);

    await pollEventsOnce(now);

    expect(mockedState.supabaseMock.rpc).not.toHaveBeenCalled();
    expect(mockedState.ioMock.emit).not.toHaveBeenCalled();
    expect(mockedState.sigurMonitorMock.recordSigurMonitorSuccess).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({
        inserted: 0,
        duplicates: 1,
        summaries: 0,
      }),
    }));
  });

  it('passes the actual background connection to the failure hook', async () => {
    const now = new Date(2026, 2, 27, 10, 0, 0);

    mockedState.queryResolver = (query) => {
      if (query.table === 'skud_events' && findOperation(query, 'select', 'event_date, event_time')) {
        return { data: [{ event_date: '2026-03-27', event_time: '09:00:00' }], error: null };
      }
      throw new Error(`Unexpected query: ${query.table}`);
    };

    mockedState.sigurServiceMock.getEvents.mockRejectedValueOnce(new Error('connect ETIMEDOUT external-host:9500'));

    await pollEventsOnce(now);

    expect(mockedState.sigurMonitorMock.recordSigurMonitorFailure).toHaveBeenCalledWith(expect.objectContaining({
      source: 'presence_polling',
      connectionType: 'external',
      errorMessage: 'connect ETIMEDOUT external-host:9500',
    }));
  });

  it('retries the upsert on transient Supabase errors and succeeds on the second attempt', async () => {
    vi.useFakeTimers();
    try {
      const now = new Date(2026, 2, 27, 10, 0, 0);
      let upsertCalls = 0;

      mockedState.queryResolver = (query) => {
        if (query.table === 'skud_events' && findOperation(query, 'select', 'event_date, event_time')) {
          return { data: [{ event_date: '2026-03-27', event_time: '09:00:00' }], error: null };
        }
        if (query.table === 'employees') {
          return { data: [{ id: 1, full_name: 'Иван Иванов', sigur_employee_id: 101 }], error: null };
        }
        if (query.table === 'skud_events' && findOperation(query, 'upsert')) {
          upsertCalls += 1;
          if (upsertCalls === 1) {
            return { data: null, error: { message: '<!DOCTYPE html><html>502 Bad Gateway</html>' } };
          }
          return { data: null, error: null };
        }
        throw new Error(`Unexpected query: ${query.table}`);
      };

      mockedState.sigurServiceMock.getEvents.mockResolvedValue([
        makeEvent({ timestamp: '2026-03-27T09:15:00+03:00' }),
      ] as Array<Record<string, unknown>>);

      const cyclePromise = pollEventsOnce(now);
      await vi.runAllTimersAsync();
      await cyclePromise;

      expect(upsertCalls).toBe(2);
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
      let upsertCalls = 0;

      mockedState.queryResolver = (query) => {
        if (query.table === 'skud_events' && findOperation(query, 'select', 'event_date, event_time')) {
          return { data: [{ event_date: '2026-03-27', event_time: '09:00:00' }], error: null };
        }
        if (query.table === 'employees') {
          return { data: [{ id: 1, full_name: 'Иван Иванов', sigur_employee_id: 101 }], error: null };
        }
        if (query.table === 'skud_events' && findOperation(query, 'upsert')) {
          upsertCalls += 1;
          return { data: null, error: { message: 'canceling statement due to statement timeout' } };
        }
        throw new Error(`Unexpected query: ${query.table}`);
      };

      mockedState.sigurServiceMock.getEvents.mockResolvedValue([
        makeEvent({ timestamp: '2026-03-27T09:15:00+03:00' }),
      ] as Array<Record<string, unknown>>);

      const cyclePromise = pollEventsOnce(now);
      await vi.runAllTimersAsync();
      await cyclePromise;

      // 1 первичная + 2 retry = 3 attempts
      expect(upsertCalls).toBe(3);
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
      let upsertCalls = 0;

      mockedState.queryResolver = (query) => {
        if (query.table === 'skud_events' && findOperation(query, 'select', 'event_date, event_time')) {
          return { data: [{ event_date: '2026-03-27', event_time: '09:00:00' }], error: null };
        }
        if (query.table === 'employees') {
          return { data: [{ id: 1, full_name: 'Иван Иванов', sigur_employee_id: 101 }], error: null };
        }
        if (query.table === 'skud_events' && findOperation(query, 'upsert')) {
          upsertCalls += 1;
          // 1-й батч (200 событий) — ОК; все попытки 2-го батча (50 событий) — timeout
          if (upsertCalls === 1) return { data: null, error: null };
          return { data: null, error: { message: 'canceling statement due to statement timeout' } };
        }
        throw new Error(`Unexpected query: ${query.table}`);
      };

      const events: Array<Record<string, unknown>> = [];
      // 250 событий = 200 (батч 1, успех) + 50 (батч 2, fail после retries)
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

      // 1 успешный + 1 первичный fail + 2 retry на 2-м батче = 4
      expect(upsertCalls).toBe(4);
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

  it('retries the summary RPC on <!DOCTYPE html> Supabase responses and records partial failure', async () => {
    vi.useFakeTimers();
    try {
      const now = new Date(2026, 2, 27, 10, 0, 0);

      mockedState.queryResolver = (query) => {
        if (query.table === 'skud_events' && findOperation(query, 'select', 'event_date, event_time')) {
          return { data: [{ event_date: '2026-03-27', event_time: '09:00:00' }], error: null };
        }
        if (query.table === 'employees') {
          return { data: [{ id: 1, full_name: 'Иван Иванов', sigur_employee_id: 101 }], error: null };
        }
        if (query.table === 'skud_events' && findOperation(query, 'upsert')) {
          return { data: null, error: null };
        }
        throw new Error(`Unexpected query: ${query.table}`);
      };

      let rpcCalls = 0;
      (mockedState.supabaseMock.rpc as unknown as { mockImplementation: (impl: (...args: unknown[]) => Promise<unknown>) => void }).mockImplementation(async () => {
        rpcCalls += 1;
        return { data: null, error: { message: '<!DOCTYPE html><html><head><title>502</title></head></html>' } };
      });

      mockedState.sigurServiceMock.getEvents.mockResolvedValue([
        makeEvent({ timestamp: '2026-03-27T09:15:00+03:00' }),
      ] as Array<Record<string, unknown>>);

      const cyclePromise = pollEventsOnce(now);
      await vi.runAllTimersAsync();
      await cyclePromise;

      // 1 первичная + 2 retry = 3 attempts
      expect(rpcCalls).toBe(3);
      expect(mockedState.runtimeStateMock.mergeSigurRuntimeState).toHaveBeenCalledTimes(1);
      const mergeCall = mockedState.runtimeStateMock.mergeSigurRuntimeState.mock.calls[0][0] as unknown as {
        checkpointAt?: Date;
        meta: { lastError: string };
      };
      // Inserted ОК → есть lastSuccessfulEventAt → checkpointAt выставляется (— 10s overlap)
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

    // 250 событий = 250 уникальных (employee_id, date) пар (employee_id зашит в sigur_employee_id)
    const employees: Array<{ id: number; full_name: string; sigur_employee_id: number }> = [];
    for (let i = 0; i < 250; i++) {
      employees.push({ id: 1000 + i, full_name: `Сотрудник${i}`, sigur_employee_id: 200 + i });
    }

    mockedState.queryResolver = (query) => {
      if (query.table === 'skud_events' && findOperation(query, 'select', 'event_date, event_time')) {
        return { data: [{ event_date: '2026-03-27', event_time: '09:00:00' }], error: null };
      }
      if (query.table === 'employees') {
        return { data: employees, error: null };
      }
      if (query.table === 'skud_events' && findOperation(query, 'upsert')) {
        return { data: null, error: null };
      }
      throw new Error(`Unexpected query: ${query.table}`);
    };

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

    // 250 пар → 3 чанка (100 + 100 + 50)
    expect(mockedState.supabaseMock.rpc).toHaveBeenCalledTimes(3);
    const rpcCalls = (mockedState.supabaseMock.rpc as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    for (const call of rpcCalls) {
      const args = call[1] as { p_pairs: unknown[] };
      expect(args.p_pairs.length).toBeLessThanOrEqual(100);
    }
    const totalPairs = rpcCalls.reduce((sum: number, call: unknown[]) => {
      return sum + ((call[1] as { p_pairs: unknown[] }).p_pairs.length);
    }, 0);
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
