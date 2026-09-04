import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Фильтр синхронизации отделов: атомарность, идемпотентность и защита отделов,
 * в которых числятся сотрудники (вместе с их предками — иначе дерево рвётся).
 */

const h = vi.hoisted(() => ({
  withTransaction: vi.fn(),
  invalidateSyncFilterCache: vi.fn(),
  invalidateDeptTreeCache: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({ withTransaction: h.withTransaction }));
vi.mock('./skud-shared.service.js', () => ({
  invalidateSyncFilterCache: h.invalidateSyncFilterCache,
  invalidateDeptTreeCache: h.invalidateDeptTreeCache,
}));
vi.mock('@sentry/node', () => ({ captureMessage: h.captureMessage, captureException: vi.fn() }));

import {
  dedupeSyncFilterRows,
  EmptySyncFilterError,
  reconcileDepartmentsActivity,
  saveSyncFilterWithReconciliation,
} from './sigur-sync-filter.service.js';

interface IFakeDept {
  id: string;
  sigur_department_id: number | null;
  parent_id: string | null;
  name: string;
  is_active: boolean;
  is_assignable: boolean;
}

interface IUpdateCall {
  column: string;
  ids: string[];
  value: boolean;
}

/**
 * Мини-заглушка PoolClient: отвечает на три запроса реконсиляции и записывает
 * UPDATE-и, чтобы проверить, кого гасим и кому меняем назначаемость.
 */
function createClient(depts: IFakeDept[], employeesByDept: Record<string, number> = {}) {
  const updates: IUpdateCall[] = [];
  const filterRows: Array<{ sigur_department_id: number; sigur_department_name: string | null }> = [];

  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM org_departments')) {
      return { rows: depts, rowCount: depts.length };
    }
    if (sql.includes('FROM employees')) {
      return {
        rows: Object.entries(employeesByDept).map(([id, count]) => ({
          org_department_id: id,
          employees: String(count),
        })),
        rowCount: Object.keys(employeesByDept).length,
      };
    }
    if (sql.startsWith('UPDATE org_departments')) {
      const column = sql.includes('is_active') ? 'is_active' : 'is_assignable';
      const ids = (params?.[0] as string[]) ?? [];
      const value = params?.[1] as boolean;
      // Считаем изменившимися только те строки, где значение реально другое.
      const changed = ids.filter(id => {
        const dept = depts.find(item => item.id === id);
        if (!dept) return false;
        const current = column === 'is_active' ? dept.is_active : dept.is_assignable;
        return current !== value;
      });
      if (changed.length > 0) updates.push({ column, ids: changed, value });
      return { rows: [], rowCount: changed.length };
    }
    if (sql.includes('count(*)::text AS count')) {
      return { rows: [{ count: String(filterRows.length) }], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO skud_sync_department_filter')) {
      const rows: Array<{ inserted: boolean }> = [];
      for (let i = 0; i < (params?.length ?? 0); i += 2) {
        const sigurId = params?.[i] as number;
        const name = params?.[i + 1] as string | null;
        const existing = filterRows.find(row => row.sigur_department_id === sigurId);
        if (!existing) {
          filterRows.push({ sigur_department_id: sigurId, sigur_department_name: name });
          rows.push({ inserted: true });
        } else if (existing.sigur_department_name !== name) {
          existing.sigur_department_name = name;
          rows.push({ inserted: false });
        }
      }
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith('DELETE FROM skud_sync_department_filter')) {
      const keep = new Set((params?.[0] as number[]) ?? []);
      const before = filterRows.length;
      for (let i = filterRows.length - 1; i >= 0; i--) {
        if (!keep.has(filterRows[i].sigur_department_id)) filterRows.splice(i, 1);
      }
      return { rows: [], rowCount: before - filterRows.length };
    }
    return { rows: [], rowCount: 0 };
  });

  return { client: { query } as never, updates, filterRows, query };
}

const dept = (
  id: string,
  sigurId: number | null,
  parentId: string | null,
  overrides: Partial<IFakeDept> = {},
): IFakeDept => ({
  id,
  sigur_department_id: sigurId,
  parent_id: parentId,
  name: `dept-${id}`,
  is_active: true,
  is_assignable: true,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.withTransaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn(currentClient));
});

let currentClient: unknown = null;

describe('dedupeSyncFilterRows', () => {
  it('схлопывает дубли по sigur_department_id, последнее имя выигрывает', () => {
    const rows = dedupeSyncFilterRows([
      { sigur_department_id: 1, sigur_department_name: 'Старое' },
      { sigur_department_id: 1, sigur_department_name: 'Новое' },
      { sigur_department_id: 2, sigur_department_name: null },
    ]);

    expect(rows).toEqual([
      { sigur_department_id: 1, sigur_department_name: 'Новое' },
      { sigur_department_id: 2, sigur_department_name: null },
    ]);
  });
});

describe('reconcileDepartmentsActivity', () => {
  it('потомок whitelisted-узла остаётся активным и назначаемым', async () => {
    const depts = [
      dept('root', 100, null),
      dept('child', 101, 'root', { is_active: false, is_assignable: false }),
    ];
    const { client, updates } = createClient(depts);

    const result = await reconcileDepartmentsActivity(client, [100], new Set([100, 101]));

    expect(updates).toContainEqual({ column: 'is_active', ids: ['child'], value: true });
    expect(updates).toContainEqual({ column: 'is_assignable', ids: ['child'], value: true });
    expect(result.warnings).toHaveLength(0);
    expect(result.deferredActivation).toBe(0);
  });

  it('отдел, которого нет в снимке Sigur, не включается даже внутри whitelist (фантом)', async () => {
    const depts = [
      dept('root', 100, null),
      dept('phantom', 101, 'root', { is_active: false, is_assignable: false }),
    ];
    const { client, updates } = createClient(depts);

    const result = await reconcileDepartmentsActivity(client, [100], new Set([100]));

    expect(updates.find(u => u.column === 'is_active' && u.value === true)).toBeUndefined();
    expect(result.activated).toBe(0);
    expect(result.deferredActivation).toBe(0);
  });

  it('фантом с сотрудниками тоже не воскрешается — только предупреждение', async () => {
    const depts = [
      dept('root', 100, null),
      dept('phantom', 200, null, { is_active: false, is_assignable: false }),
    ];
    const { client, updates } = createClient(depts, { phantom: 4 });

    const result = await reconcileDepartmentsActivity(client, [100], new Set([100]));

    expect(updates.find(u => u.column === 'is_active')).toBeUndefined();
    expect(result.activated).toBe(0);
    expect(h.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('нет в снимке Sigur'),
      expect.anything(),
    );
  });

  it('без снимка Sigur включение откладывается, гашение идёт как обычно', async () => {
    const depts = [
      dept('root', 100, null),
      dept('child', 101, 'root', { is_active: false, is_assignable: false }),
      dept('empty', 300, null),
    ];
    const { client, updates } = createClient(depts);

    const result = await reconcileDepartmentsActivity(client, [100], null);

    expect(updates.find(u => u.column === 'is_active' && u.value === true)).toBeUndefined();
    expect(updates).toContainEqual({ column: 'is_active', ids: ['empty'], value: false });
    expect(result.deferredActivation).toBe(1);
  });

  it('отдел с сотрудниками не гасится, но становится неназначаемым', async () => {
    const depts = [dept('root', 100, null), dept('outside', 200, null)];
    const { client, updates } = createClient(depts, { outside: 8 });

    const result = await reconcileDepartmentsActivity(client, [100], new Set([100, 200]));

    expect(updates.find(u => u.column === 'is_active' && u.value === false)).toBeUndefined();
    expect(updates).toContainEqual({ column: 'is_assignable', ids: ['outside'], value: false });
    expect(result.warnings).toEqual([
      { department_id: 'outside', name: 'dept-outside', employees: 8 },
    ]);
  });

  it('предок населённого отдела тоже не гасится — иначе дерево рвётся', async () => {
    const depts = [
      dept('root', 100, null),
      dept('parent', 200, null),
      dept('populated', 201, 'parent'),
    ];
    const { client, updates } = createClient(depts, { populated: 3 });

    await reconcileDepartmentsActivity(client, [100], new Set([100, 200, 201]));

    const deactivated = updates.filter(u => u.column === 'is_active' && u.value === false);
    expect(deactivated).toHaveLength(0);
    expect(updates).toContainEqual({
      column: 'is_assignable',
      ids: expect.arrayContaining(['parent', 'populated']),
      value: false,
    });
  });

  it('пустой отдел вне whitelist гасится, повтор ничего не меняет', async () => {
    const depts = [dept('root', 100, null), dept('empty', 300, null)];
    const first = createClient(depts);
    await reconcileDepartmentsActivity(first.client, [100], new Set([100, 300]));
    expect(first.updates).toContainEqual({ column: 'is_active', ids: ['empty'], value: false });

    // Повторный прогон по уже приведённому состоянию.
    const settled = [
      dept('root', 100, null),
      dept('empty', 300, null, { is_active: false, is_assignable: false }),
    ];
    const second = createClient(settled);
    await reconcileDepartmentsActivity(second.client, [100], new Set([100, 300]));
    expect(second.updates).toHaveLength(0);
  });

  it('ручные отделы без sigur_department_id не трогаются', async () => {
    const depts = [dept('root', 100, null), dept('manual', null, null)];
    const { client, updates } = createClient(depts);

    await reconcileDepartmentsActivity(client, [100], new Set([100]));

    expect(updates.every(update => !update.ids.includes('manual'))).toBe(true);
  });
});

describe('saveSyncFilterWithReconciliation', () => {
  it('повторное сохранение того же набора не меняет ни строки', async () => {
    const depts = [dept('root', 100, null)];
    const shared = createClient(depts);
    currentClient = shared.client;

    const first = await saveSyncFilterWithReconciliation(
      [{ sigur_department_id: 100, sigur_department_name: 'СУ-10' }],
      { source: 'test' },
    );
    expect(first.inserted).toBe(1);

    const second = await saveSyncFilterWithReconciliation(
      [{ sigur_department_id: 100, sigur_department_name: 'СУ-10' }],
      { source: 'test' },
    );

    expect(second).toMatchObject({ inserted: 0, updated: 0, deleted: 0 });
  });

  it('пустой набор при непустом фильтре отклоняется без записи', async () => {
    const depts = [dept('root', 100, null)];
    const shared = createClient(depts);
    currentClient = shared.client;

    await saveSyncFilterWithReconciliation(
      [{ sigur_department_id: 100, sigur_department_name: 'СУ-10' }],
      { source: 'test' },
    );

    await expect(
      saveSyncFilterWithReconciliation([], { source: 'test' }),
    ).rejects.toBeInstanceOf(EmptySyncFilterError);

    expect(shared.filterRows).toHaveLength(1);
  });

  it('дубли во входе не роняют INSERT и дают одну строку', async () => {
    const depts = [dept('root', 100, null)];
    const shared = createClient(depts);
    currentClient = shared.client;

    const result = await saveSyncFilterWithReconciliation(
      [
        { sigur_department_id: 100, sigur_department_name: 'СУ-10' },
        { sigur_department_id: 100, sigur_department_name: 'СУ-10' },
      ],
      { source: 'test' },
    );

    expect(result.inserted).toBe(1);
    expect(shared.filterRows).toHaveLength(1);
  });

  it('кэши сбрасываются только после коммита', async () => {
    const depts = [dept('root', 100, null)];
    currentClient = createClient(depts).client;
    h.withTransaction.mockRejectedValueOnce(new Error('db down'));

    await expect(
      saveSyncFilterWithReconciliation(
        [{ sigur_department_id: 100, sigur_department_name: 'СУ-10' }],
        { source: 'test' },
      ),
    ).rejects.toThrow('db down');

    expect(h.invalidateSyncFilterCache).not.toHaveBeenCalled();
    expect(h.invalidateDeptTreeCache).not.toHaveBeenCalled();
  });

  it('без reconcile пишутся только строки фильтра — активность отделов не трогается', async () => {
    const depts = [
      dept('root', 100, null),
      dept('child', 101, 'root', { is_active: false, is_assignable: false }),
    ];
    const shared = createClient(depts);
    currentClient = shared.client;

    const result = await saveSyncFilterWithReconciliation(
      [{ sigur_department_id: 100, sigur_department_name: 'СУ-10' }],
      { source: 'sigur-remap', allowEmpty: true },
    );

    expect(shared.updates).toHaveLength(0);
    expect(result).toMatchObject({ inserted: 1, activated: 0, deactivated: 0, deferredActivation: 0 });
    expect(h.invalidateSyncFilterCache).toHaveBeenCalledTimes(1);
    expect(h.invalidateDeptTreeCache).not.toHaveBeenCalled();
  });

  it('с reconcile включается только то, что есть в снимке Sigur', async () => {
    const depts = [
      dept('root', 100, null),
      dept('child', 101, 'root', { is_active: false, is_assignable: false }),
      dept('phantom', 102, 'root', { is_active: false, is_assignable: false }),
    ];
    const shared = createClient(depts);
    currentClient = shared.client;

    const result = await saveSyncFilterWithReconciliation(
      [{ sigur_department_id: 100, sigur_department_name: 'СУ-10' }],
      { source: 'user:test', reconcile: { aliveSigurIds: new Set([100, 101]) } },
    );

    expect(shared.updates).toContainEqual({ column: 'is_active', ids: ['child'], value: true });
    expect(result.activated).toBe(1);
    expect(h.invalidateDeptTreeCache).toHaveBeenCalledTimes(1);
  });
});
