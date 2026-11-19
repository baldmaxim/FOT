import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  fingerprint: 'fp1',
  builds: 0,
  build: null as null | ((month: string) => Promise<unknown>),
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
    employee_id: id, category: id % 2 === 0 ? 'worker' : 'itr', days: [{ date: `${month}-01` }],
  }));
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
    meta: { duplicate_days: 0, object_config_errors: 0, objects_not_frozen: 0 },
  };
};

vi.mock('./staff-month-1c.snapshot.js', () => ({
  buildStaffMonthSnapshot: vi.fn(async (_client: unknown, bounds: { month: string }) => (
    state.build ? state.build(bounds.month) : fakeSnapshot(bounds.month)
  )),
}));

import {
  getStaffMonthSnapshot,
  listStaffMonthEmployees,
  resetStaffMonthSnapshots,
  StaffMonthApiError,
} from './staff-month-1c.service.js';

const FILTERS = { object_key: null, category: null, employee_id: null, days: false };

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
  });
  afterEach(() => {
    vi.useRealTimers();
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
