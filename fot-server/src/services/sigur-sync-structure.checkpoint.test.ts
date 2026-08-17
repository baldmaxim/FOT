import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Прогон РЕАЛЬНОГО syncDepartmentsLogic на моках БД и Sigur: проверяем, что
 * checkpoint onMirrorCommitted стоит сразу после коммита зеркала (до reconciliation,
 * которая тянет всех сотрудников Sigur — до нескольких минут на холодном кэше),
 * и что mirror_only вообще не ходит за сотрудниками.
 *
 * Мокать сам syncDepartmentsLogic здесь нельзя — тогда тест не проверяет
 * расположение checkpoint внутри функции.
 */

const h = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
  isConfigured: vi.fn(),
  getEmployeesCached: vi.fn(),
  getDepartmentsRaw: vi.fn(),
  invalidateOrgStructureCaches: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: h.queryOne,
  withTransaction: h.withTransaction,
}));
vi.mock('./sigur.service.js', () => ({
  sigurService: { isConfigured: h.isConfigured, getEmployeesCached: h.getEmployeesCached },
}));
vi.mock('./employee-mapper.service.js', () => ({
  invalidateOrgStructureCaches: h.invalidateOrgStructureCaches,
}));
vi.mock('./sigur-sync-shared.js', async () => {
  const actual = await vi.importActual<typeof import('./sigur-sync-shared.js')>('./sigur-sync-shared.js');
  return {
    ...actual,
    getDepartmentsRaw: h.getDepartmentsRaw,
    getWhitelistedDepartmentIdsCached: vi.fn(async () => null),
    logSampleAndWarn: vi.fn(),
  };
});

import { syncDepartmentsLogic } from './sigur-sync-structure.service.js';

const ROOT_UUID = 'root-object-uuid';

beforeEach(() => {
  vi.clearAllMocks();

  h.isConfigured.mockResolvedValue(true);
  // Один новый отдел под виртуальным корнем Sigur.
  h.getDepartmentsRaw.mockResolvedValue([{ id: 150749, name: 'Отдел экономики строительства', parentId: 0 }]);
  // Зеркало пустое → создаётся корень «Объект», затем отдел.
  h.query.mockResolvedValue([]);
  h.queryOne.mockResolvedValue({ id: ROOT_UUID });
  h.withTransaction.mockImplementation(async (cb: (client: unknown) => Promise<unknown>) =>
    cb({ query: vi.fn(async () => ({ rows: [{ id: 'dept-uuid' }], rowCount: 1 })) }),
  );
});

describe('syncDepartmentsLogic — checkpoint зеркала', () => {
  it('вызывает onMirrorCommitted до среза сотрудников Sigur (холодный кэш)', async () => {
    let releaseEmployees: (value: Record<string, unknown>[]) => void = () => {};
    const employeesPromise = new Promise<Record<string, unknown>[]>((resolve) => {
      releaseEmployees = resolve;
    });
    h.getEmployeesCached.mockReturnValue(employeesPromise);

    const onMirrorCommitted = vi.fn();
    const syncPromise = syncDepartmentsLogic(undefined, {}, { onMirrorCommitted });

    // Даём микротаскам дойти до reconciliation: хук уже отработал, сотрудники — ещё нет.
    await vi.waitFor(() => expect(onMirrorCommitted).toHaveBeenCalledTimes(1));
    expect(h.getEmployeesCached).toHaveBeenCalledTimes(1);

    releaseEmployees([{ id: 1, departmentId: 150749 }]);
    await syncPromise;
  });

  it('mirror_only: не ходит за сотрудниками и не деактивирует', async () => {
    const onMirrorCommitted = vi.fn();
    const result = await syncDepartmentsLogic(undefined, {}, { mode: 'mirror_only', onMirrorCommitted });

    expect(onMirrorCommitted).toHaveBeenCalledTimes(1);
    expect(h.getEmployeesCached).not.toHaveBeenCalled();
    expect(result.deactivated).toBe(0);
    expect(result.keptByEmployeeRefs).toBe(0);
    expect(result.imported).toBeGreaterThan(0);
    // Транзакция зеркала — ровно одна: ни деактивации, ни consolidate.
    expect(h.withTransaction).toHaveBeenCalledTimes(1);
    expect(h.invalidateOrgStructureCaches).toHaveBeenCalled();
  });
});
