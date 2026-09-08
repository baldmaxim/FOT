import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  restoreFromSnapshot,
  revokeDepartmentAccessWithSnapshot,
  revokeDirectReportsWithSnapshot,
} from './lifecycle-revocations.service.js';

/**
 * Клиент-заглушка: маршрутизирует запросы по фрагменту SQL и копит вызовы,
 * чтобы проверять не только результат, но и что именно ушло в базу.
 */
const makeClient = (route: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount: number } | undefined) => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return route(sql, params) ?? { rows: [], rowCount: 0 };
  });
  return { client: { query } as never, calls };
};

describe('lifecycle-revocations: снятие полномочий со снимком', () => {
  beforeEach(() => vi.clearAllMocks());

  it('доступы к отделам: каждая снятая строка попадает в снимок', async () => {
    const { client, calls } = makeClient((sql) => {
      if (sql.includes('UPDATE employee_department_access')) {
        return {
          rows: [
            { id: 'acc-1', department_id: 'dept-1', source: 'manual_admin_ui' },
            { id: 'acc-2', department_id: 'dept-2', source: 'sigur_sync' },
          ],
          rowCount: 2,
        };
      }
      return undefined;
    });

    const revoked = await revokeDepartmentAccessWithSnapshot(client, 'op-1', 77);

    expect(revoked).toBe(2);
    const snapshots = calls.filter(c => c.sql.includes('INSERT INTO employee_lifecycle_revocations'));
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].params[2]).toBe('acc-1');
    expect(JSON.parse(String(snapshots[0].params[3])).department_id).toBe('dept-1');
    // Повтор операции по lease не должен плодить дубли снимка.
    expect(snapshots[0].sql).toContain('ON CONFLICT');
  });

  it('подчинённые: снимаются только там, где уволенный был руководителем', async () => {
    const { client, calls } = makeClient((sql) => {
      if (sql.includes('UPDATE employee_direct_reports')) {
        return {
          rows: [
            { id: 'dr-1', subordinate_employee_id: 1684, note: null },
            { id: 'dr-2', subordinate_employee_id: 1697, note: 'рук.строй' },
          ],
          rowCount: 2,
        };
      }
      return undefined;
    });

    const orphaned = await revokeDirectReportsWithSnapshot(client, 'op-1', 1656);

    expect(orphaned).toEqual([1684, 1697]);
    const update = calls.find(c => c.sql.includes('UPDATE employee_direct_reports'))!;
    // Сторону подчинённого не трогаем: уволенный подчинённый остаётся у живого руководителя.
    expect(update.sql).toContain('manager_employee_id = $1');
    expect(update.sql).not.toContain('subordinate_employee_id = $1');
    expect(calls.filter(c => c.sql.includes('INSERT INTO employee_lifecycle_revocations'))).toHaveLength(2);
  });

  it('нечего снимать → снимок пустой', async () => {
    const { client, calls } = makeClient(() => undefined);

    expect(await revokeDepartmentAccessWithSnapshot(client, 'op-1', 77)).toBe(0);
    expect(await revokeDirectReportsWithSnapshot(client, 'op-1', 77)).toEqual([]);
    expect(calls.some(c => c.sql.includes('INSERT INTO employee_lifecycle_revocations'))).toBe(false);
  });
});

describe('lifecycle-revocations: восстановление по снимку', () => {
  beforeEach(() => vi.clearAllMocks());

  const snapshotRows = [
    { kind: 'department_access', row_id: 'acc-1', payload: { department_id: 'dept-1' } },
    { kind: 'direct_report', row_id: 'dr-1', payload: { subordinate_employee_id: 1684 } },
  ];

  it('возвращает доступы и подчинённых, снятых этим увольнением', async () => {
    const { client, calls } = makeClient((sql) => {
      if (sql.includes('FROM employee_lifecycle_revocations')) return { rows: snapshotRows, rowCount: 2 };
      if (sql.includes('SELECT manager_employee_id')) return { rows: [], rowCount: 0 };
      if (sql.includes('UPDATE employee_department_access')) return { rows: [], rowCount: 1 };
      if (sql.includes('UPDATE employee_direct_reports')) return { rows: [], rowCount: 1 };
      return undefined;
    });

    const result = await restoreFromSnapshot(client, 'op-1', 1656);

    expect(result.departmentAccessRestored).toBe(1);
    expect(result.directReportsRestored).toBe(1);
    expect(result.conflicts).toEqual([]);
    // Возврат идемпотентен: обновляем только погашенные строки.
    expect(calls.find(c => c.sql.includes('UPDATE employee_department_access'))!.sql).toContain('is_active = false');
  });

  it('подчинённого уже отдали другому руководителю → конфликт, связь не перетирается', async () => {
    const { client, calls } = makeClient((sql) => {
      if (sql.includes('FROM employee_lifecycle_revocations')) {
        return { rows: [snapshotRows[1]], rowCount: 1 };
      }
      if (sql.includes('SELECT manager_employee_id')) return { rows: [{ manager_employee_id: 999 }], rowCount: 1 };
      return undefined;
    });

    const result = await restoreFromSnapshot(client, 'op-1', 1656);

    expect(result.directReportsRestored).toBe(0);
    expect(result.conflicts).toEqual([
      { kind: 'direct_report', subordinateEmployeeId: 1684, currentManagerEmployeeId: 999 },
    ]);
    expect(calls.some(c => c.sql.includes('UPDATE employee_direct_reports'))).toBe(false);
  });

  it('подчинённый уже вернулся к тому же руководителю → ни возврата, ни конфликта', async () => {
    const { client, calls } = makeClient((sql) => {
      if (sql.includes('FROM employee_lifecycle_revocations')) return { rows: [snapshotRows[1]], rowCount: 1 };
      if (sql.includes('SELECT manager_employee_id')) return { rows: [{ manager_employee_id: 1656 }], rowCount: 1 };
      return undefined;
    });

    const result = await restoreFromSnapshot(client, 'op-1', 1656);

    expect(result.directReportsRestored).toBe(0);
    expect(result.conflicts).toEqual([]);
    expect(calls.some(c => c.sql.includes('UPDATE employee_direct_reports'))).toBe(false);
  });

  it('пустой снимок → ничего не восстанавливаем', async () => {
    const { client } = makeClient(() => undefined);
    const result = await restoreFromSnapshot(client, 'op-1', 1656);
    expect(result).toEqual({ departmentAccessRestored: 0, directReportsRestored: 0, conflicts: [] });
  });
});
