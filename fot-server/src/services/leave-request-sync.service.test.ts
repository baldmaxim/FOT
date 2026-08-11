import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

const { pgTx, txClient } = vi.hoisted(() => {
  const txClient = { query: vi.fn() };
  return {
    // withTransaction исполняет колбэк с tx-клиентом и возвращает его результат.
    pgTx: vi.fn(async (fn: (c: typeof txClient) => Promise<unknown>) => fn(txClient)),
    txClient,
  };
});

vi.mock('../config/postgres.js', () => ({ withTransaction: pgTx }));

const { snapshotDeptMock, approvalLockMock } = vi.hoisted(() => ({
  snapshotDeptMock: vi.fn(async (): Promise<string | null> => 'dep-1'),
  approvalLockMock: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock('./timesheet-department-assignments.service.js', () => ({
  getEmployeeAssignmentSnapshotDepartment: snapshotDeptMock,
  findApprovalLockForDate: approvalLockMock,
}));

import { syncLeaveRequestOnDayRemoval, syncLeaveRequestReason } from './leave-request-sync.service.js';

/** Фейковый PoolClient: query по очереди отдаёт заранее заданные ответы и пишет историю вызовов. */
function makeClient(responses: Array<{ rows: unknown[] }>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let i = 0;
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return responses[i++] ?? { rows: [] };
  });
  return { client: { query } as unknown as PoolClient, calls, query };
}

const findUpdate = (calls: Array<{ sql: string; params: unknown[] }>) =>
  calls.find(c => /UPDATE leave_requests/i.test(c.sql));

describe('syncLeaveRequestOnDayRemoval', () => {
  it('заявление не найдено → null, без UPDATE', async () => {
    const { client, calls } = makeClient([{ rows: [] }]);
    const res = await syncLeaveRequestOnDayRemoval(client, 42);
    expect(res).toBeNull();
    expect(findUpdate(calls)).toBeUndefined();
  });

  it('дней не осталось → заявление cancelled', async () => {
    const { client, calls } = makeClient([
      { rows: [{ employee_id: 7 }] }, // SELECT leave_requests
      { rows: [] },                   // SELECT remaining adjustments
    ]);
    const res = await syncLeaveRequestOnDayRemoval(client, 42);
    expect(res).toEqual({ employeeId: 7, cancelled: true });
    const upd = findUpdate(calls);
    expect(upd?.sql).toMatch(/status = 'cancelled'/);
    expect(upd?.params).toEqual([42]);
  });

  it('остались дни → selected_dates + start/end по min/max', async () => {
    const { client, calls } = makeClient([
      { rows: [{ employee_id: 9 }] },
      { rows: [{ work_date: '2026-06-03' }, { work_date: '2026-06-05' }] },
    ]);
    const res = await syncLeaveRequestOnDayRemoval(client, 100);
    expect(res).toEqual({ employeeId: 9, cancelled: false });
    const upd = findUpdate(calls);
    expect(upd?.sql).toMatch(/selected_dates = \$2::date\[\]/);
    expect(upd?.params).toEqual([100, ['2026-06-03', '2026-06-05'], '2026-06-03', '2026-06-05']);
  });

  it('обрезает timestamp в work_date до ISO-даты', async () => {
    const { client, calls } = makeClient([
      { rows: [{ employee_id: 1 }] },
      { rows: [{ work_date: '2026-06-10T00:00:00.000Z' }] },
    ]);
    await syncLeaveRequestOnDayRemoval(client, 1);
    const upd = findUpdate(calls);
    expect(upd?.params).toEqual([1, ['2026-06-10'], '2026-06-10', '2026-06-10']);
  });
});

describe('syncLeaveRequestReason (контракт guarded/unguarded)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    snapshotDeptMock.mockResolvedValue('dep-1');
    approvalLockMock.mockResolvedValue(null);
  });

  it('guarded: несовпадение expectedRequestType → false, adjustments не тронуты', async () => {
    txClient.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // UPDATE мимо: тип сменён

    const result = await syncLeaveRequestReason(708, 'текст', 'vacation');

    expect(result).toBe(false);
    expect(txClient.query).toHaveBeenCalledTimes(1);
    const [sql, params] = txClient.query.mock.calls[0];
    expect(String(sql)).toContain('request_type = $3');
    expect(params).toEqual([708, 'текст', 'vacation']);
  });

  it('guarded: совпадение типа → синхронизирует adjustments и возвращает true', async () => {
    txClient.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE leave_requests (условный)
      .mockResolvedValueOnce({ rows: [{ id: 5, employee_id: 247, work_date: '2026-06-01' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE attendance_adjustments

    const result = await syncLeaveRequestReason(708, 'текст', 'vacation');

    expect(result).toBe(true);
    const adjUpdate = txClient.query.mock.calls.find(c => String(c[0]).includes('UPDATE attendance_adjustments'));
    expect(adjUpdate?.[1]).toEqual([5, 'текст']);
  });

  it('unguarded (двухаргументный вызов из табеля): прежнее поведение — синк идёт даже при rowCount=0', async () => {
    txClient.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // UPDATE leave_requests без условия по типу
      .mockResolvedValueOnce({ rows: [{ id: 5, employee_id: 247, work_date: '2026-06-01' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await syncLeaveRequestReason(708, 'текст');

    expect(result).toBe(true);
    const [sql, params] = txClient.query.mock.calls[0];
    expect(String(sql)).not.toContain('request_type');
    expect(params).toEqual([708, 'текст']);
    expect(txClient.query.mock.calls.some(c => String(c[0]).includes('UPDATE attendance_adjustments'))).toBe(true);
  });

  it('день, запертый согласованием периода, остаётся замороженным (guarded-путь не меняет правило)', async () => {
    approvalLockMock.mockResolvedValueOnce({ status: 'approved' });
    txClient.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 5, employee_id: 247, work_date: '2026-06-01' }], rowCount: 1 });

    const result = await syncLeaveRequestReason(708, 'текст', 'vacation');

    expect(result).toBe(true);
    expect(txClient.query.mock.calls.some(c => String(c[0]).includes('UPDATE attendance_adjustments'))).toBe(false);
  });
});
