import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
}));

import { snapshotApprovalEmployees } from './timesheet-approval-employees-snapshot.service.js';

interface IFakeClient {
  query: ReturnType<typeof vi.fn>;
}

const makeClient = (employeeRows: Array<{ id: number; full_name: string }>): IFakeClient => {
  const fn = vi.fn(async (sql: string) => {
    if (sql.startsWith('DELETE')) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('SELECT id, full_name FROM employees')) {
      return { rows: employeeRows, rowCount: employeeRows.length };
    }
    if (sql.startsWith('INSERT INTO timesheet_approval_employees')) {
      return { rows: [], rowCount: employeeRows.length };
    }
    return { rows: [], rowCount: 0 };
  });
  return { query: fn };
};

describe('snapshotApprovalEmployees', () => {
  it('перезаписывает снимок по явному списку employeeIds', async () => {
    const client = makeClient([
      { id: 10, full_name: 'Иванов' },
      { id: 20, full_name: 'Петров' },
    ]);

    const count = await snapshotApprovalEmployees(
      client as unknown as Parameters<typeof snapshotApprovalEmployees>[0],
      42,
      [10, 20],
    );

    expect(count).toBe(2);
    // DELETE + SELECT + INSERT
    expect(client.query).toHaveBeenCalledTimes(3);
    const insertCall = client.query.mock.calls.find(c => String(c[0]).startsWith('INSERT'));
    expect(insertCall?.[1]?.[0]).toBe(42);
    expect(insertCall?.[1]?.[1]).toEqual([10, 20]);
    expect(insertCall?.[1]?.[2]).toEqual(['Иванов', 'Петров']);
  });

  it('пустой список — только DELETE, без SELECT/INSERT', async () => {
    const client = makeClient([]);
    const count = await snapshotApprovalEmployees(
      client as unknown as Parameters<typeof snapshotApprovalEmployees>[0],
      42,
      [],
    );
    expect(count).toBe(0);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(String(client.query.mock.calls[0][0])).toMatch(/^DELETE/);
  });

  it('если employees-таблица пуста для переданных id — возвращает 0', async () => {
    const client = makeClient([]);
    const count = await snapshotApprovalEmployees(
      client as unknown as Parameters<typeof snapshotApprovalEmployees>[0],
      42,
      [999],
    );
    expect(count).toBe(0);
    // DELETE + SELECT (нашли 0) — без INSERT
    expect(client.query).toHaveBeenCalledTimes(2);
  });
});
