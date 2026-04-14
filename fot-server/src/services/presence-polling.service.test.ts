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

const mockedState = vi.hoisted(() => ({
  queryLog: [] as QueryRecord[],
  queryResolver: (() => ({ data: [], error: null })) as (query: QueryRecord) => QueryResponse | Promise<QueryResponse>,
  supabaseMock: {
    from: vi.fn(),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  },
  sigurServiceMock: {
    isConfigured: vi.fn(() => true),
    getBackgroundConnectionType: vi.fn(() => 'external'),
    getEvents: vi.fn<(...args: unknown[]) => Promise<Array<Record<string, unknown>>>>(async () => []),
  },
  sigurMonitorMock: {
    markPresencePollingCycleStarted: vi.fn(),
    markPresencePollingCycleFinished: vi.fn(),
    recordSigurMonitorSuccess: vi.fn(async () => undefined),
    recordSigurMonitorFailure: vi.fn(async () => undefined),
  },
  runtimeStateMock: {
    pollingState: null as null | {
      key: string;
      checkpoint_at: string | null;
      lease_owner: string | null;
      lease_expires_at: string | null;
      heartbeat_at: string | null;
      meta: Record<string, unknown>;
      updated_at: string;
    },
    getSigurRuntimeState: vi.fn(async () => mockedState.runtimeStateMock.pollingState),
    tryAcquireSigurRuntimeLease: vi.fn(async () => ({ acquired: true, row: mockedState.runtimeStateMock.pollingState })),
    mergeSigurRuntimeState: vi.fn(async (params: {
      key: string;
      checkpointAt?: Date | null;
      meta?: Record<string, unknown>;
      owner?: string | null;
    }) => {
      const current = mockedState.runtimeStateMock.pollingState;
      const currentCheckpointMs = current?.checkpoint_at ? Date.parse(current.checkpoint_at) : Number.NEGATIVE_INFINITY;
      const nextCheckpointMs = params.checkpointAt ? params.checkpointAt.getTime() : currentCheckpointMs;
      const checkpoint_at = Number.isFinite(Math.max(currentCheckpointMs, nextCheckpointMs))
        ? new Date(Math.max(currentCheckpointMs, nextCheckpointMs)).toISOString()
        : null;
      mockedState.runtimeStateMock.pollingState = {
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
      return mockedState.runtimeStateMock.pollingState;
    }),
    releaseSigurRuntimeLease: vi.fn(async () => true),
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
      return Promise.resolve(mockedState.queryResolver(query));
    },
    then: (onFulfilled: (value: QueryResponse) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(mockedState.queryResolver(query)).then(onFulfilled, onRejected),
  };

  return builder;
}

mockedState.supabaseMock.from.mockImplementation((table: string) => createBuilder(table));

vi.mock('../config/database.js', () => ({
  supabase: mockedState.supabaseMock,
}));

vi.mock('./sigur.service.js', () => ({
  sigurService: mockedState.sigurServiceMock,
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
  POLL_OVERLAP_MS,
  pollEventsOnce,
  resetPresencePollingStateForTests,
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
    mockedState.runtimeStateMock.pollingState = null;
    mockedState.runtimeStateMock.getSigurRuntimeState.mockClear();
    mockedState.runtimeStateMock.tryAcquireSigurRuntimeLease.mockClear();
    mockedState.runtimeStateMock.mergeSigurRuntimeState.mockClear();
    mockedState.runtimeStateMock.releaseSigurRuntimeLease.mockClear();
    mockedState.runtimeStateMock.startSigurRuntimeLeaseHeartbeat.mockClear();
    resetPresencePollingStateForTests();
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
});
