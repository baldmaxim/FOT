import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { syncLeaveRequestOnDayRemoval } from './leave-request-sync.service.js';

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
