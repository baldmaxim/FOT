import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  fingerprint: 'fp1',
  builds: 0,
  build: null as null | ((month: string) => Promise<unknown>),
  storedBuild: null as null | { fingerprint: string | null; builtAt: string | null; startedAt: string | null },
  /** Половины, переданные в запись состояний последней сборкой. */
  persistedHalves: [] as number[],
  exportInfo: { states: new Map(), acks: new Map() } as { states: Map<number, unknown>; acks: Map<number, unknown> },
  secondHalfStarted: true,
}));

vi.mock('../config/postgres.js', () => ({
  getPool: () => ({}),
  withReadOnlySnapshot: async <T>(fn: (client: unknown) => Promise<T>): Promise<T> => fn({}),
}));

vi.mock('./staff-month-1c.load.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./staff-month-1c.load.js')>()),
  loadClosedFingerprint: vi.fn(async () => state.fingerprint),
}));

const fakeSnapshot = (month: string) => {
  state.builds += 1;
  const rows = [3, 5, 8, 13, 21].map(id => ({
    employee_id: id, category: id % 2 === 0 ? 'worker' : 'itr', preliminary: false, days: [{ date: `${month}-01` }],
  }));
  const half = (number: 1 | 2, ids: number[], started = true) => ({
    bounds: { half: number, from: `${month}-${number === 1 ? '01' : '16'}`, to: `${month}-${number === 1 ? '15' : '31'}`, until: `${month}-15`, started, ended: true },
    rows: started ? rows.filter(row => ids.includes(row.employee_id)).map(row => ({ ...row, preliminary: row.employee_id === 13 })) : [],
    index: new Map(ids.map(id => [id, { mainKey: id === 5 ? 'obj-a' : 'office', factByObject: new Map<string, number>() }])),
    brigades: [],
    objects: [],
    preliminary: false,
  });
  return {
    id: `snap-${state.builds}`,
    month,
    bounds: { month, start: `${month}-01`, end: `${month}-31`, until: `${month}-31`, open: false },
    generatedAt: new Date().toISOString(),
    fingerprint: state.fingerprint,
    hasLive: false,
    preliminary: false,
    rows,
    index: new Map(rows.map(row => [row.employee_id, { mainKey: 'office', factByObject: new Map<string, number>() }])),
    brigades: [],
    objects: [],
    // 21 принят во второй половине: в первой его нет.
    halves: { 1: half(1, [3, 5, 8, 13]), 2: half(2, [3, 5, 8, 13, 21], state.secondHalfStarted) },
    meta: { duplicate_days: 0, object_config_errors: 0, objects_not_frozen: 0 },
  };
};

vi.mock('./staff-month-1c.export-state.js', () => ({
  loadStaffMonthBuild: vi.fn(async () => state.storedBuild),
  markStaffMonthBuildStarted: vi.fn(async () => undefined),
  persistStaffMonthStates: vi.fn(async (_month: string, halves: Map<number, Array<{ employeeId: number }>>) => {
    state.persistedHalves = [...halves.keys()];
    return new Map([...halves].map(([half, rows]) => [half, new Map(rows.map(row => [
      row.employeeId, { revision: half * 10, present: true, preliminary: false, contentHash: 'h' },
    ]))]));
  }),
  loadStaffMonthExportInfo: vi.fn(async () => state.exportInfo),
}));

vi.mock('./staff-month-1c.snapshot.js', () => ({
  buildStaffMonthSnapshot: vi.fn(async (_client: unknown, bounds: { month: string }) => (
    state.build ? state.build(bounds.month) : fakeSnapshot(bounds.month)
  )),
}));

import {
  getStaffMonthSnapshot,
  listStaffMonthEmployees,
  refreshStaffMonth,
  resetStaffMonthSnapshots,
  StaffMonthApiError,
} from './staff-month-1c.service.js';

const FILTERS = { half: null, object_key: null, category: null, employee_id: null, days: false, export_state: null };

const walk = async (month: string, limit: number, filters = FILTERS): Promise<{ ids: number[]; snapshots: Set<string> }> => {
  const ids: number[] = [];
  const snapshots = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const page = await listStaffMonthEmployees({ month, filters, limit, cursor, snapshotId: null });
    ids.push(...page.rows.map(row => row.employee_id));
    snapshots.add(page.snapshot.id);
    if (!page.nextCursor) return { ids, snapshots };
    cursor = page.nextCursor;
  }
};

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'ok';
  } catch (err) {
    return err instanceof StaffMonthApiError ? err.code : `other: ${String(err)}`;
  }
};

describe('staff-month-1c.service — снимки и курсор', () => {
  beforeEach(() => {
    resetStaffMonthSnapshots();
    state.fingerprint = 'fp1';
    state.builds = 0;
    state.build = null;
    state.storedBuild = null;
    state.persistedHalves = [];
    state.exportInfo = { states: new Map(), acks: new Map() };
    state.secondHalfStarted = true;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('фоновое обновление: первая сборка, без изменений — нет, после 04:00 — да, незавершённая попытка — не чаще часа', async () => {
    const now = new Date('2026-11-20T10:00:00Z');
    const night = '2026-11-20T01:00:00Z';
    expect(await refreshStaffMonth('2026-10', night, now)).toBe(true);
    expect(state.builds).toBe(1);

    state.storedBuild = { fingerprint: 'fp1', builtAt: '2026-11-20T05:00:00Z', startedAt: '2026-11-20T04:59:00Z' };
    expect(await refreshStaffMonth('2026-10', night, now)).toBe(false); // рестарт днём — без пересборки
    state.fingerprint = 'fp2';
    expect(await refreshStaffMonth('2026-10', night, now)).toBe(true); // табель закрыли
    state.storedBuild = { fingerprint: 'fp2', builtAt: '2026-11-19T22:00:00Z', startedAt: '2026-11-19T21:59:00Z' };
    expect(await refreshStaffMonth('2026-10', night, now)).toBe(true); // ночная сборка ещё не было

    // Прошлая фоновая сборка начата 20 минут назад и не завершилась (рестарт по памяти) — не повторять.
    state.storedBuild = { fingerprint: 'fp1', builtAt: '2026-11-19T22:00:00Z', startedAt: '2026-11-20T09:40:00Z' };
    expect(await refreshStaffMonth('2026-10', night, now)).toBe(false);
    // Прошло больше часа — повторить.
    state.storedBuild = { fingerprint: 'fp1', builtAt: '2026-11-19T22:00:00Z', startedAt: '2026-11-20T08:40:00Z' };
    expect(await refreshStaffMonth('2026-10', night, now)).toBe(true);
  });

  it('обход по курсору: все строки один раз, один снимок; без days=1 дней в ответе нет', async () => {
    const result = await walk('2026-10', 2);
    expect(result.ids).toEqual([3, 5, 8, 13, 21]);
    expect(result.snapshots.size).toBe(1);
    const page = await listStaffMonthEmployees({ month: '2026-10', filters: FILTERS, limit: 1, cursor: null, snapshotId: null });
    expect('days' in page.rows[0]).toBe(false);
    const withDays = await listStaffMonthEmployees({ month: '2026-10', filters: { ...FILTERS, days: true }, limit: 1, cursor: null, snapshotId: null });
    expect(withDays.rows[0].days).toHaveLength(1);
    expect(state.builds).toBe(1);
  });

  it('курсор с другим фильтром или месяцем — invalid_cursor', async () => {
    const first = await listStaffMonthEmployees({ month: '2026-10', filters: FILTERS, limit: 2, cursor: null, snapshotId: null });
    expect(await codeOf(listStaffMonthEmployees({
      month: '2026-10', filters: { ...FILTERS, category: 'worker' }, limit: 2, cursor: first.nextCursor, snapshotId: null,
    }))).toBe('invalid_cursor');
    expect(await codeOf(listStaffMonthEmployees({
      month: '2026-09', filters: FILTERS, limit: 2, cursor: first.nextCursor, snapshotId: null,
    }))).toBe('invalid_cursor');
  });

  it('новая редакция → новый снимок для нового обхода, старый курсор дочитывает старый', async () => {
    const first = await listStaffMonthEmployees({ month: '2026-10', filters: FILTERS, limit: 2, cursor: null, snapshotId: null });
    state.fingerprint = 'fp2';
    const fresh = await listStaffMonthEmployees({ month: '2026-10', filters: FILTERS, limit: 2, cursor: null, snapshotId: null });
    expect(fresh.snapshot.id).not.toBe(first.snapshot.id);
    const next = await listStaffMonthEmployees({ month: '2026-10', filters: FILTERS, limit: 2, cursor: first.nextCursor, snapshotId: null });
    expect(next.snapshot.id).toBe(first.snapshot.id);
    expect(next.rows.map(row => row.employee_id)).toEqual([8, 13]);
  });

  it('пятый снимок вытесняет самый давний → 409 snapshot_expired', async () => {
    const first = await listStaffMonthEmployees({ month: '2026-06', filters: FILTERS, limit: 2, cursor: null, snapshotId: null });
    for (const month of ['2026-07', '2026-08', '2026-09', '2026-10']) await getStaffMonthSnapshot(month, null);
    expect(await codeOf(listStaffMonthEmployees({
      month: '2026-06', filters: FILTERS, limit: 2, cursor: first.nextCursor, snapshotId: null,
    }))).toBe('snapshot_expired');
    expect(await codeOf(getStaffMonthSnapshot('2026-06', first.snapshot.id))).toBe('snapshot_expired');
  });

  it('снимок без обращений 30 минут удаляется → 409', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-19T10:00:00Z'));
    const snapshot = await getStaffMonthSnapshot('2026-10', null);
    vi.setSystemTime(new Date('2026-11-19T10:31:00Z'));
    expect(await codeOf(getStaffMonthSnapshot('2026-10', snapshot.id))).toBe('snapshot_expired');
  });

  it('месяц целиком — без статусов; export_state без половины — 400', async () => {
    const page = await listStaffMonthEmployees({ month: '2026-10', filters: FILTERS, limit: 10, cursor: null, snapshotId: null });
    expect(page.view).toBeNull();
    expect(page.exportCounts).toBeNull();
    expect('export_state' in page.rows[0]).toBe(false);
    expect(await codeOf(listStaffMonthEmployees({
      month: '2026-10', filters: { ...FILTERS, export_state: ['ready'] }, limit: 10, cursor: null, snapshotId: null,
    }))).toBe('invalid_filter');
  });

  it('половина: состав половины, статусы и ревизии своей половины, отбор по объекту — по индексу половины', async () => {
    const first = await listStaffMonthEmployees({ month: '2026-10', filters: { ...FILTERS, half: 1 }, limit: 10, cursor: null, snapshotId: null });
    expect(first.rows.map(row => row.employee_id)).toEqual([3, 5, 8, 13]);
    expect(first.rows[0]).toMatchObject({ present: true, state_revision: 10, content_hash: expect.stringMatching(/^[0-9a-f]{64}$/), export_state: 'ready', ready_for_export: true });
    expect(first.rows[3]).toMatchObject({ export_state: 'not_ready', ready_for_export: false });
    expect(first.exportCounts).toEqual({ not_ready: 1, ready: 3, exported: 0, changed: 0 });
    expect(first.periodReady).toBe(false);
    const second = await listStaffMonthEmployees({ month: '2026-10', filters: { ...FILTERS, half: 2 }, limit: 10, cursor: null, snapshotId: null });
    expect(second.rows.map(row => row.employee_id)).toEqual([3, 5, 8, 13, 21]);
    expect(second.rows[0]).toMatchObject({ state_revision: 20 });
    expect(state.persistedHalves).toEqual([1, 2]);
    const byObject = await listStaffMonthEmployees({
      month: '2026-10', filters: { ...FILTERS, half: 1, object_key: 'obj-a' }, limit: 10, cursor: null, snapshotId: null,
    });
    expect(byObject.rows.map(row => row.employee_id)).toEqual([5]);
  });

  it('половина: надгробие выгруженного — только в «что забрать» (changed) без отбора по объекту', async () => {
    state.exportInfo = {
      states: new Map([[99, { revision: 4, present: false, preliminary: false, contentHash: null }]]),
      acks: new Map([[99, { revision: 3, ackedAt: '2026-11-01T10:00:00Z', documentRef: 'ЗУП-1' }]]),
    };
    const page = await listStaffMonthEmployees({
      month: '2026-10', filters: { ...FILTERS, half: 1, export_state: ['ready', 'changed'] }, limit: 10, cursor: null, snapshotId: null,
    });
    expect(page.rows.map(row => row.employee_id)).toEqual([3, 5, 8, 99]);
    expect(page.rows[3]).toMatchObject({ present: false, state_revision: 4, content_hash: null, export_state: 'changed' });
    expect(page.exportCounts?.changed).toBe(1);
    const withObject = await listStaffMonthEmployees({
      month: '2026-10', filters: { ...FILTERS, half: 1, export_state: ['changed'], object_key: 'office' }, limit: 10, cursor: null, snapshotId: null,
    });
    expect(withObject.rows).toEqual([]);
  });

  it('курсор другой половины — invalid_cursor; не начавшаяся половина не пишется и отдаёт half_not_started', async () => {
    const first = await listStaffMonthEmployees({ month: '2026-10', filters: { ...FILTERS, half: 1 }, limit: 2, cursor: null, snapshotId: null });
    expect(await codeOf(listStaffMonthEmployees({
      month: '2026-10', filters: { ...FILTERS, half: 2 }, limit: 2, cursor: first.nextCursor, snapshotId: null,
    }))).toBe('invalid_cursor');
    expect(await codeOf(listStaffMonthEmployees({
      month: '2026-10', filters: FILTERS, limit: 2, cursor: first.nextCursor, snapshotId: null,
    }))).toBe('invalid_cursor');

    resetStaffMonthSnapshots();
    state.secondHalfStarted = false;
    await getStaffMonthSnapshot('2026-11', null);
    expect(state.persistedHalves).toEqual([1]);
    expect(await codeOf(listStaffMonthEmployees({
      month: '2026-11', filters: { ...FILTERS, half: 2 }, limit: 2, cursor: null, snapshotId: null,
    }))).toBe('half_not_started');
  });

  it('сборка дольше 25 с — 503 snapshot_building, потом готовый снимок; ошибка сборки — calculation_failed', async () => {
    vi.useFakeTimers();
    let release: (() => void) | null = null;
    state.build = month => new Promise(resolve => { release = () => resolve(fakeSnapshot(month)); });
    const waiting = codeOf(getStaffMonthSnapshot('2026-10', null));
    await vi.advanceTimersByTimeAsync(25_001);
    expect(await waiting).toBe('snapshot_building');
    release!();
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    state.build = null;
    const ready = await getStaffMonthSnapshot('2026-10', null);
    expect(ready.id).toBe('snap-1');
    expect(state.builds).toBe(1);

    state.fingerprint = 'fp-broken';
    state.build = async () => { throw new Error('boom'); };
    expect(await codeOf(getStaffMonthSnapshot('2026-10', null))).toBe('calculation_failed');
  });
});
