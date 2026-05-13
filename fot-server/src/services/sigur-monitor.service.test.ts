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

type RowMap = Record<string, unknown>;

const mockedState = vi.hoisted(() => ({
  nextId: 1,
  tables: {
    sigur_health_checks: [] as RowMap[],
    sigur_incidents: [] as RowMap[],
    skud_events: [] as RowMap[],
  },
  settings: {
    enabled: true,
    failureThreshold: 2,
    recoveryThreshold: 2,
    silenceWindowMinutes: 15,
    baselineLookbackDays: 28,
    baselineMinEvents: 5,
    alertCooldownMinutes: 60,
    timezone: 'Europe/Moscow',
  },
  notificationServiceMock: {
    createMany: vi.fn(async () => undefined),
  },
  sigurServiceMock: {
    isConfigured: vi.fn(() => true),
    getBackgroundConnectionType: vi.fn(() => 'external'),
    testConnection: vi.fn(async () => ({
      success: true,
      message: 'ok',
      connection: 'external',
    })),
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
    tryAcquireSigurRuntimeLease: vi.fn(async () => ({ acquired: true, row: null })),
    releaseSigurRuntimeLease: vi.fn(async () => true),
    startSigurRuntimeLeaseHeartbeat: vi.fn(() => vi.fn()),
  },
}));

vi.mock('./notification.service.js', () => ({
  notificationService: mockedState.notificationServiceMock,
}));

vi.mock('./settings.service.js', () => ({
  settingsService: {
    getSigurMonitorConfig: vi.fn(async () => mockedState.settings),
  },
}));

vi.mock('./sigur.service.js', () => ({
  sigurService: mockedState.sigurServiceMock,
}));

vi.mock('./sigur-runtime-state.service.js', () => ({
  SIGUR_MONITOR_LEASE_TTL_SECONDS: 180,
  SIGUR_MONITOR_STATE_KEY: 'sigur_monitor',
  SIGUR_POLLING_STATE_KEY: 'sigur_presence_polling',
  getSigurRuntimeOwner: (scope: string) => `owner:${scope}`,
  getSigurRuntimeState: mockedState.runtimeStateMock.getSigurRuntimeState,
  tryAcquireSigurRuntimeLease: mockedState.runtimeStateMock.tryAcquireSigurRuntimeLease,
  releaseSigurRuntimeLease: mockedState.runtimeStateMock.releaseSigurRuntimeLease,
  startSigurRuntimeLeaseHeartbeat: mockedState.runtimeStateMock.startSigurRuntimeLeaseHeartbeat,
}));

import {
  recordSigurMonitorFailure,
  recordSigurMonitorSuccess,
  resetSigurMonitorStateForTests,
  runSigurMonitorCycleNow,
} from './sigur-monitor.service.js';

/**
 * Парсит набор SET-присваиваний из UPDATE-выражения (`a = $1, b = $2::jsonb, ...`)
 * и возвращает Record<column, paramIndex(1-based)>.
 */
function parseUpdateSetClause(sql: string): Record<string, number> {
  const match = sql.match(/SET\s+(.+?)\s+WHERE/is);
  if (!match) return {};
  const assignments = match[1].split(',');
  const result: Record<string, number> = {};
  for (const assignment of assignments) {
    const m = assignment.trim().match(/^(\w+)\s*=\s*\$(\d+)/);
    if (m) {
      result[m[1]] = parseInt(m[2], 10);
    }
  }
  return result;
}

// ─── Mock-роутер pg-helpers ─────────────────────────────────────────────────
function installPgRouter(): void {
  // queryOne: SELECT/INSERT/UPDATE с RETURNING/LIMIT 1.
  pgQueryOne.mockImplementation(async (sql: string, params?: unknown[]) => {
    const lower = sql.trim().toLowerCase();

    // SELECT * FROM sigur_incidents WHERE status = 'open' ...
    if (lower.startsWith("select * from sigur_incidents where status = 'open'")) {
      const open = mockedState.tables.sigur_incidents
        .filter(row => row.status === 'open')
        .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
      return open[0] || null;
    }

    // SELECT * FROM sigur_incidents WHERE id = $1
    if (lower.startsWith('select * from sigur_incidents where id =')) {
      const id = params?.[0];
      return mockedState.tables.sigur_incidents.find(row => row.id === id) || null;
    }

    // SELECT * FROM sigur_health_checks WHERE status = 'success' ...
    if (lower.startsWith("select * from sigur_health_checks where status = 'success'")) {
      const success = mockedState.tables.sigur_health_checks
        .filter(row => row.status === 'success')
        .sort((a, b) => String(b.checked_at).localeCompare(String(a.checked_at)));
      return success[0] || null;
    }

    // SELECT event_date, event_time FROM skud_events ORDER BY ... LIMIT 1
    if (lower.startsWith('select event_date, event_time from skud_events')) {
      const sorted = [...mockedState.tables.skud_events].sort((a, b) => {
        const dateCmp = String(b.event_date).localeCompare(String(a.event_date));
        if (dateCmp !== 0) return dateCmp;
        return String(b.event_time).localeCompare(String(a.event_time));
      });
      return sorted[0] || null;
    }

    // INSERT INTO sigur_health_checks (...) RETURNING *
    if (lower.startsWith('insert into sigur_health_checks')) {
      // Параметры: checked_at, source, status, connection_type, response_ms,
      // events_last_window, baseline_events, consecutive_failures, error_message, meta_json.
      const [
        checked_at, source, status, connection_type, response_ms,
        events_last_window, baseline_events, consecutive_failures, error_message, meta_json,
      ] = (params || []) as unknown[];
      const nowIso = String(checked_at || new Date().toISOString());
      const row: RowMap = {
        id: mockedState.nextId++,
        checked_at: nowIso,
        source,
        status,
        connection_type,
        response_ms,
        events_last_window,
        baseline_events,
        consecutive_failures,
        error_message,
        meta: typeof meta_json === 'string' ? JSON.parse(meta_json) : (meta_json ?? {}),
        created_at: nowIso,
        updated_at: nowIso,
      };
      mockedState.tables.sigur_health_checks.push(row);
      return row;
    }

    // INSERT INTO sigur_incidents (...) RETURNING *
    if (lower.startsWith('insert into sigur_incidents')) {
      const [
        status, severity, detected_by, started_at, resolved_at, last_success_at,
        affected_from, affected_to, connection_type, error_message, meta_json,
      ] = (params || []) as unknown[];
      const nowIso = String(started_at || new Date().toISOString());
      const row: RowMap = {
        id: mockedState.nextId++,
        status,
        severity,
        detected_by,
        started_at,
        resolved_at,
        last_success_at,
        affected_from,
        affected_to,
        connection_type,
        error_message,
        meta: typeof meta_json === 'string' ? JSON.parse(meta_json) : (meta_json ?? {}),
        created_at: nowIso,
        updated_at: nowIso,
      };
      mockedState.tables.sigur_incidents.push(row);
      return row;
    }

    // UPDATE sigur_incidents SET ... WHERE id = $N RETURNING *
    if (lower.startsWith('update sigur_incidents set')) {
      const setMap = parseUpdateSetClause(sql);
      const whereIdMatch = sql.match(/WHERE\s+id\s*=\s*\$(\d+)/i);
      if (!whereIdMatch || !params) return null;
      const idParamIndex = parseInt(whereIdMatch[1], 10) - 1;
      const id = params[idParamIndex];
      const row = mockedState.tables.sigur_incidents.find(r => r.id === id);
      if (!row) return null;
      for (const [col, idx] of Object.entries(setMap)) {
        const raw = params[idx - 1];
        if (col === 'meta') {
          row[col] = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {});
        } else {
          row[col] = raw;
        }
      }
      return row;
    }

    return null;
  });

  // query: коллекции
  pgQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    const lower = sql.trim().toLowerCase();

    // SELECT * FROM sigur_health_checks ORDER BY checked_at DESC LIMIT $1
    if (lower.startsWith('select * from sigur_health_checks order by')) {
      const limit = Number(params?.[0]) || 10;
      return [...mockedState.tables.sigur_health_checks]
        .sort((a, b) => String(b.checked_at).localeCompare(String(a.checked_at)))
        .slice(0, limit);
    }

    // SELECT event_date FROM skud_events WHERE event_date = ANY(...) AND event_time >= ... AND event_time < ...
    if (lower.startsWith('select event_date from skud_events')) {
      const dates = (params?.[0] as string[]) || [];
      const startTime = String(params?.[1] || '');
      const endTime = String(params?.[2] || '');
      return mockedState.tables.skud_events.filter(row => {
        const date = String(row.event_date);
        const time = String(row.event_time);
        return dates.includes(date) && time >= startTime && time < endTime;
      }).map(row => ({ event_date: row.event_date }));
    }

    return [];
  });

  pgExecute.mockResolvedValue(0);
  pgTx.mockImplementation(async (fn) => fn({ query: vi.fn() } as never));
}

describe('sigur-monitor.service', () => {
  beforeEach(() => {
    pgQuery.mockReset();
    pgQueryOne.mockReset();
    pgExecute.mockReset();
    pgTx.mockReset();
    mockedState.nextId = 1;
    mockedState.tables.sigur_health_checks = [];
    mockedState.tables.sigur_incidents = [];
    mockedState.tables.skud_events = [];
    mockedState.notificationServiceMock.createMany.mockClear();
    mockedState.sigurServiceMock.isConfigured.mockReturnValue(true);
    mockedState.sigurServiceMock.getBackgroundConnectionType.mockReturnValue('external');
    mockedState.sigurServiceMock.testConnection.mockClear();
    mockedState.sigurServiceMock.testConnection.mockResolvedValue({
      success: true,
      message: 'ok',
      connection: 'external',
    });
    mockedState.runtimeStateMock.pollingState = null;
    mockedState.runtimeStateMock.getSigurRuntimeState.mockClear();
    mockedState.runtimeStateMock.tryAcquireSigurRuntimeLease.mockClear();
    mockedState.runtimeStateMock.releaseSigurRuntimeLease.mockClear();
    mockedState.runtimeStateMock.startSigurRuntimeLeaseHeartbeat.mockClear();
    mockedState.settings = {
      enabled: true,
      failureThreshold: 2,
      recoveryThreshold: 2,
      silenceWindowMinutes: 15,
      baselineLookbackDays: 28,
      baselineMinEvents: 5,
      alertCooldownMinutes: 60,
      timezone: 'Europe/Moscow',
    };

    installPgRouter();
    resetSigurMonitorStateForTests();
  });

  it('opens a critical incident after the configured failure threshold', async () => {
    const first = new Date('2026-04-11T07:00:00.000Z');
    const second = new Date('2026-04-11T07:01:00.000Z');

    await recordSigurMonitorFailure({
      source: 'presence_polling',
      checkedAt: first,
      errorMessage: 'Sigur timeout',
      responseMs: 500,
    });

    expect(mockedState.tables.sigur_incidents).toHaveLength(0);

    await recordSigurMonitorFailure({
      source: 'presence_polling',
      checkedAt: second,
      errorMessage: 'Sigur timeout',
      responseMs: 700,
    });

    expect(mockedState.tables.sigur_incidents).toHaveLength(1);
    expect(mockedState.tables.sigur_health_checks).toHaveLength(2);
    expect(mockedState.tables.sigur_incidents[0].status).toBe('open');
    expect(mockedState.tables.sigur_incidents[0].severity).toBe('critical');
    expect(mockedState.tables.sigur_incidents[0].detected_by).toBe('presence_polling');
    expect(mockedState.notificationServiceMock.createMany).not.toHaveBeenCalled();
  });

  it('resolves a critical incident after the configured recovery threshold', async () => {
    await recordSigurMonitorFailure({
      source: 'presence_polling',
      checkedAt: new Date('2026-04-11T07:00:00.000Z'),
      errorMessage: 'Sigur timeout',
    });
    await recordSigurMonitorFailure({
      source: 'presence_polling',
      checkedAt: new Date('2026-04-11T07:01:00.000Z'),
      errorMessage: 'Sigur timeout',
    });

    await recordSigurMonitorSuccess({
      source: 'monitor_probe',
      checkedAt: new Date('2026-04-11T07:02:00.000Z'),
      eventsLastWindow: 0,
      responseMs: 120,
    });

    expect(mockedState.tables.sigur_incidents[0].status).toBe('open');

    await recordSigurMonitorSuccess({
      source: 'monitor_probe',
      checkedAt: new Date('2026-04-11T07:03:00.000Z'),
      eventsLastWindow: 0,
      responseMs: 90,
    });

    expect(mockedState.tables.sigur_incidents[0].status).toBe('resolved');
    expect(mockedState.tables.sigur_incidents[0].resolved_at).toBe('2026-04-11T07:03:00.000Z');
    expect(mockedState.notificationServiceMock.createMany).not.toHaveBeenCalled();
  });

  it('does not open a silence incident when historical baseline is below threshold', async () => {
    await recordSigurMonitorSuccess({
      source: 'presence_polling',
      checkedAt: new Date('2026-04-11T06:55:00.000Z'),
      eventsLastWindow: 4,
    });
    await recordSigurMonitorSuccess({
      source: 'presence_polling',
      checkedAt: new Date('2026-04-11T07:39:00.000Z'),
      eventsLastWindow: 0,
    });

    await runSigurMonitorCycleNow(new Date('2026-04-11T07:40:00.000Z'));

    expect(mockedState.tables.sigur_incidents).toHaveLength(0);
    expect(mockedState.notificationServiceMock.createMany).not.toHaveBeenCalled();
  });

  it('opens a silence incident when the baseline is high and events disappear', async () => {
    const historicalDates = ['2026-04-03', '2026-03-27', '2026-03-20', '2026-03-13'];
    mockedState.tables.skud_events = historicalDates.flatMap((date, index) => (
      Array.from({ length: 6 }, (_, offset) => ({
        id: 100 + index * 10 + offset,
        event_date: date,
        event_time: `10:${String(30 + offset).padStart(2, '0')}:00`,
      }))
    ));

    await recordSigurMonitorSuccess({
      source: 'presence_polling',
      checkedAt: new Date('2026-04-10T07:00:00.000Z'),
      eventsLastWindow: 12,
    });
    await recordSigurMonitorSuccess({
      source: 'presence_polling',
      checkedAt: new Date('2026-04-10T07:39:00.000Z'),
      eventsLastWindow: 0,
    });

    await runSigurMonitorCycleNow(new Date('2026-04-10T07:40:00.000Z'));

    expect(mockedState.tables.sigur_incidents).toHaveLength(1);
    expect(mockedState.tables.sigur_incidents[0].severity).toBe('warning');
    expect(mockedState.tables.sigur_incidents[0].detected_by).toBe('silence_detector');
    expect(mockedState.tables.sigur_health_checks.at(-1)?.status).toBe('silence');
    expect(mockedState.notificationServiceMock.createMany).not.toHaveBeenCalled();
  });

  it('uses the external background channel for direct probes', async () => {
    await runSigurMonitorCycleNow(new Date('2026-04-11T07:03:00.000Z'));

    expect(mockedState.sigurServiceMock.testConnection).toHaveBeenCalledWith('external');
    expect(mockedState.tables.sigur_health_checks.at(-1)).toMatchObject({
      source: 'monitor_probe',
      status: 'success',
      connection_type: 'external',
    });
  });

  it('skips direct probe while presence polling cycle is still in flight', async () => {
    mockedState.runtimeStateMock.pollingState = {
      key: 'sigur_presence_polling',
      checkpoint_at: '2026-04-11T07:00:00.000Z',
      lease_owner: 'owner:sigur_presence_polling',
      lease_expires_at: '2026-04-11T07:04:00.000Z',
      heartbeat_at: '2026-04-11T07:01:30.000Z',
      updated_at: '2026-04-11T07:01:30.000Z',
      meta: {
        inFlightStartedAt: '2026-04-11T07:01:00.000Z',
        lastSignalAt: '2026-04-11T07:00:00.000Z',
        lastSuccessAt: '2026-04-11T07:00:00.000Z',
        lastEventFlowAt: '2026-04-11T07:00:00.000Z',
      },
    };

    await recordSigurMonitorSuccess({
      source: 'presence_polling',
      checkedAt: new Date('2026-04-11T07:00:00.000Z'),
      eventsLastWindow: 3,
    });

    await runSigurMonitorCycleNow(new Date('2026-04-11T07:03:00.000Z'));

    expect(mockedState.sigurServiceMock.testConnection).not.toHaveBeenCalled();
    expect(mockedState.tables.sigur_health_checks).toHaveLength(1);
    expect(mockedState.tables.sigur_health_checks[0]?.source).toBe('presence_polling');
  });

  it('does not open a silence incident while presence polling is still in flight', async () => {
    const historicalDates = ['2026-04-03', '2026-03-27', '2026-03-20', '2026-03-13'];
    mockedState.tables.skud_events = historicalDates.flatMap((date, index) => (
      Array.from({ length: 6 }, (_, offset) => ({
        id: 200 + index * 10 + offset,
        event_date: date,
        event_time: `10:${String(30 + offset).padStart(2, '0')}:00`,
      }))
    ));
    mockedState.runtimeStateMock.pollingState = {
      key: 'sigur_presence_polling',
      checkpoint_at: '2026-04-10T07:39:00.000Z',
      lease_owner: 'owner:sigur_presence_polling',
      lease_expires_at: '2026-04-10T07:42:00.000Z',
      heartbeat_at: '2026-04-10T07:40:30.000Z',
      updated_at: '2026-04-10T07:40:30.000Z',
      meta: {
        inFlightStartedAt: '2026-04-10T07:40:00.000Z',
        lastSignalAt: '2026-04-10T07:39:00.000Z',
        lastSuccessAt: '2026-04-10T07:39:00.000Z',
        lastEventFlowAt: '2026-04-10T07:00:00.000Z',
      },
    };

    await recordSigurMonitorSuccess({
      source: 'presence_polling',
      checkedAt: new Date('2026-04-10T07:39:00.000Z'),
      eventsLastWindow: 0,
    });

    await runSigurMonitorCycleNow(new Date('2026-04-10T07:40:00.000Z'));

    expect(mockedState.sigurServiceMock.testConnection).not.toHaveBeenCalled();
    expect(mockedState.tables.sigur_incidents).toHaveLength(0);
    expect(mockedState.tables.sigur_health_checks).toHaveLength(1);
    expect(mockedState.tables.sigur_health_checks[0]?.source).toBe('presence_polling');
  });

  it('does not open a silence incident while polling is chunking through backlog', async () => {
    const historicalDates = ['2026-04-03', '2026-03-27', '2026-03-20', '2026-03-13'];
    mockedState.tables.skud_events = historicalDates.flatMap((date, index) => (
      Array.from({ length: 6 }, (_, offset) => ({
        id: 300 + index * 10 + offset,
        event_date: date,
        event_time: `16:${String(15 + offset).padStart(2, '0')}:00`,
      }))
    ));
    mockedState.runtimeStateMock.pollingState = {
      key: 'sigur_presence_polling',
      checkpoint_at: '2026-04-14T12:39:20.000Z',
      lease_owner: null,
      lease_expires_at: null,
      heartbeat_at: null,
      updated_at: '2026-04-14T13:29:04.524Z',
      meta: {
        lastSignalAt: '2026-04-14T13:29:04.524Z',
        lastSuccessAt: '2026-04-14T13:29:04.524Z',
        lastEventFlowAt: '2026-04-14T11:39:17.000Z',
        lastCycle: {
          windowTruncated: true,
        },
      },
    };

    await recordSigurMonitorSuccess({
      source: 'presence_polling',
      checkedAt: new Date('2026-04-14T13:29:04.524Z'),
      eventsLastWindow: 253,
      meta: {
        latestObservedEventAt: '2026-04-14T11:39:17.000Z',
      },
    });

    await runSigurMonitorCycleNow(new Date('2026-04-14T13:29:07.457Z'));

    expect(mockedState.tables.sigur_incidents).toHaveLength(0);
    expect(mockedState.tables.sigur_health_checks).toHaveLength(1);
    expect(mockedState.tables.sigur_health_checks[0]?.source).toBe('presence_polling');
  });
});
