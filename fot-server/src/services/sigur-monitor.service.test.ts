import { beforeEach, describe, expect, it, vi } from 'vitest';

type TableName = 'sigur_health_checks' | 'sigur_incidents' | 'skud_events' | 'user_profiles';

interface IRow {
  id?: number | string;
  [key: string]: unknown;
}

interface IBuilderState {
  table: TableName;
  mode: 'select' | 'insert' | 'update';
  insertRows?: IRow[];
  updatePatch?: IRow;
  filters: Array<(row: IRow) => boolean>;
  orders: Array<{ field: string; ascending: boolean }>;
  limit?: number;
  range?: { from: number; to: number };
  wantsSingle: boolean;
  wantsCount: boolean;
}

const mockedState = vi.hoisted(() => ({
  nextId: 1,
  tables: {
    sigur_health_checks: [] as IRow[],
    sigur_incidents: [] as IRow[],
    skud_events: [] as IRow[],
    user_profiles: [
      { id: 'admin-1', position_type: 'admin', is_approved: true },
      { id: 'super-admin-1', position_type: 'super_admin', is_approved: true },
    ] as IRow[],
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
}));

function cloneRow<T extends IRow>(row: T): T {
  return JSON.parse(JSON.stringify(row));
}

function normalizeDateValue(value: unknown): number | string {
  if (typeof value !== 'string') return String(value);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : parsed;
}

function sortRows(rows: IRow[], orders: Array<{ field: string; ascending: boolean }>): IRow[] {
  return [...rows].sort((left, right) => {
    for (const order of orders) {
      const leftValue = normalizeDateValue(left[order.field]);
      const rightValue = normalizeDateValue(right[order.field]);
      if (leftValue === rightValue) continue;
      if (leftValue > rightValue) return order.ascending ? 1 : -1;
      return order.ascending ? -1 : 1;
    }
    return 0;
  });
}

function executeBuilder(state: IBuilderState) {
  const rows = mockedState.tables[state.table];

  if (state.mode === 'insert') {
    const inserted = (state.insertRows || []).map(row => {
      const nowIso = typeof row.checked_at === 'string'
        ? String(row.checked_at)
        : typeof row.started_at === 'string'
          ? String(row.started_at)
          : new Date('2026-04-11T00:00:00.000Z').toISOString();

      const nextRow = cloneRow({
        id: mockedState.nextId++,
        created_at: row.created_at || nowIso,
        updated_at: row.updated_at || nowIso,
        ...row,
      });
      rows.push(nextRow);
      return cloneRow(nextRow);
    });

    return Promise.resolve({
      data: state.wantsSingle ? inserted[0] || null : inserted,
      error: null,
      count: inserted.length,
    });
  }

  if (state.mode === 'update') {
    const filtered = rows.filter(row => state.filters.every(filter => filter(row)));
    const updated = filtered.map(row => {
      Object.assign(row, cloneRow(state.updatePatch || {}));
      return cloneRow(row);
    });

    return Promise.resolve({
      data: state.wantsSingle ? updated[0] || null : updated,
      error: null,
      count: updated.length,
    });
  }

  let filtered = rows.filter(row => state.filters.every(filter => filter(row)));
  const total = filtered.length;
  filtered = sortRows(filtered, state.orders);

  if (state.range) {
    filtered = filtered.slice(state.range.from, state.range.to + 1);
  } else if (state.limit !== undefined) {
    filtered = filtered.slice(0, state.limit);
  }

  const payload = filtered.map(cloneRow);
  return Promise.resolve({
    data: state.wantsSingle ? payload[0] || null : payload,
    error: null,
    count: state.wantsCount ? total : null,
  });
}

function createBuilder(table: TableName) {
  const state: IBuilderState = {
    table,
    mode: 'select',
    filters: [],
    orders: [],
    wantsSingle: false,
    wantsCount: false,
  };

  const builder = {
    select: (_fields?: string, options?: { count?: string }) => {
      state.wantsCount = options?.count === 'exact';
      return builder;
    },
    insert: (payload: IRow | IRow[]) => {
      state.mode = 'insert';
      state.insertRows = (Array.isArray(payload) ? payload : [payload]).map(cloneRow);
      return builder;
    },
    update: (patch: IRow) => {
      state.mode = 'update';
      state.updatePatch = cloneRow(patch);
      return builder;
    },
    eq: (field: string, value: unknown) => {
      state.filters.push(row => row[field] === value);
      return builder;
    },
    in: (field: string, values: unknown[]) => {
      state.filters.push(row => values.includes(row[field]));
      return builder;
    },
    gte: (field: string, value: unknown) => {
      state.filters.push(row => normalizeDateValue(row[field]) >= normalizeDateValue(value));
      return builder;
    },
    lte: (field: string, value: unknown) => {
      state.filters.push(row => normalizeDateValue(row[field]) <= normalizeDateValue(value));
      return builder;
    },
    lt: (field: string, value: unknown) => {
      state.filters.push(row => normalizeDateValue(row[field]) < normalizeDateValue(value));
      return builder;
    },
    not: (field: string, operator: string, value: unknown) => {
      if (operator === 'is' && value === null) {
        state.filters.push(row => row[field] !== null && row[field] !== undefined);
      }
      return builder;
    },
    order: (field: string, options?: { ascending?: boolean }) => {
      state.orders.push({ field, ascending: options?.ascending !== false });
      return builder;
    },
    limit: (value: number) => {
      state.limit = value;
      return builder;
    },
    range: (from: number, to: number) => {
      state.range = { from, to };
      return builder;
    },
    single: () => {
      state.wantsSingle = true;
      return executeBuilder(state);
    },
    then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
      executeBuilder(state).then(onFulfilled, onRejected),
  };

  return builder;
}

vi.mock('../config/database.js', () => ({
  supabase: {
    from: vi.fn((table: TableName) => createBuilder(table)),
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

import {
  markPresencePollingCycleFinished,
  markPresencePollingCycleStarted,
  recordSigurMonitorFailure,
  recordSigurMonitorSuccess,
  resetSigurMonitorStateForTests,
  runSigurMonitorCycleNow,
} from './sigur-monitor.service.js';

describe('sigur-monitor.service', () => {
  beforeEach(() => {
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
    expect(mockedState.notificationServiceMock.createMany).toHaveBeenCalledTimes(1);
    const openedNotificationBatch = ((mockedState.notificationServiceMock.createMany.mock.calls as unknown) as Array<[Array<{ type: string }>]>)[0]?.[0];
    expect(openedNotificationBatch?.[0]?.type).toBe('sigur_incident_opened');
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
    expect(mockedState.notificationServiceMock.createMany).toHaveBeenCalledTimes(2);
    const resolvedNotificationBatch = ((mockedState.notificationServiceMock.createMany.mock.calls as unknown) as Array<[Array<{ type: string }>]>)[1]?.[0];
    expect(resolvedNotificationBatch?.[0]?.type).toBe('sigur_incident_resolved');
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
    expect(mockedState.notificationServiceMock.createMany).toHaveBeenCalledTimes(1);
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
    await recordSigurMonitorSuccess({
      source: 'presence_polling',
      checkedAt: new Date('2026-04-11T07:00:00.000Z'),
      eventsLastWindow: 3,
    });

    markPresencePollingCycleStarted(new Date('2026-04-11T07:01:00.000Z'));
    await runSigurMonitorCycleNow(new Date('2026-04-11T07:03:00.000Z'));
    markPresencePollingCycleFinished();

    expect(mockedState.sigurServiceMock.testConnection).not.toHaveBeenCalled();
    expect(mockedState.tables.sigur_health_checks).toHaveLength(1);
    expect(mockedState.tables.sigur_health_checks[0]?.source).toBe('presence_polling');
  });
});
