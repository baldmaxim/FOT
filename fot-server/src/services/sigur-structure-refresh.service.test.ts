import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * Точечный refresh зеркала отделов после CRUD в Sigur: конкуренция за
 * structure-sync lock, коалесинг серии правок, целевая деактивация удалённых.
 */

const h = vi.hoisted(() => ({
  execute: vi.fn(),
  syncDepartmentsLogic: vi.fn(),
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  invalidateCache: vi.fn(),
  invalidateOrgStructureCaches: vi.fn(),
  invalidateAccessibleScopeCache: vi.fn(),
  notifySigurStructureChanged: vi.fn(),
  invalidateDepartmentCache: vi.fn(),
  isSigurRuntimeAllowed: vi.fn(() => true),
}));

class SyncInProgress extends Error {
  readonly code = 'SYNC_IN_PROGRESS';
}

vi.mock('../config/postgres.js', () => ({ execute: h.execute }));
vi.mock('./sigur-sync-structure.service.js', () => ({ syncDepartmentsLogic: h.syncDepartmentsLogic }));
vi.mock('./presence-polling.service.js', () => ({
  acquireStructureSyncSchedulerLock: h.acquireLock,
  releaseStructureSyncSchedulerLock: h.releaseLock,
}));
vi.mock('../middleware/cacheResponse.js', () => ({ invalidateCache: h.invalidateCache }));
vi.mock('./employee-mapper.service.js', () => ({
  invalidateOrgStructureCaches: h.invalidateOrgStructureCaches,
}));
vi.mock('./data-scope.service.js', () => ({
  invalidateAccessibleScopeCache: h.invalidateAccessibleScopeCache,
}));
vi.mock('./skud-realtime.service.js', () => ({
  notifySigurStructureChanged: h.notifySigurStructureChanged,
}));
vi.mock('./sigur.service.js', () => ({
  sigurService: { invalidateDepartmentCache: h.invalidateDepartmentCache },
}));
vi.mock('./sigur-runtime-guard.service.js', () => ({
  isSigurRuntimeAllowed: h.isSigurRuntimeAllowed,
  logSigurRuntimeGuardSkip: vi.fn(),
}));

import {
  __resetStructureRefreshStateForTests,
  deactivateMirroredDepartments,
  requestDepartmentsMirrorRefresh,
} from './sigur-structure-refresh.service.js';

const SYNC_RESULT = { imported: 1, updated: 0, filtered: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  __resetStructureRefreshStateForTests();
  h.isSigurRuntimeAllowed.mockReturnValue(true);
  h.acquireLock.mockResolvedValue(undefined);
  h.releaseLock.mockResolvedValue(undefined);
  h.syncDepartmentsLogic.mockResolvedValue(SYNC_RESULT);
  h.execute.mockResolvedValue(1);
});

afterEach(() => {
  __resetStructureRefreshStateForTests();
  vi.useRealTimers();
});

describe('requestDepartmentsMirrorRefresh', () => {
  it('синкает зеркало в режиме mirror_only с переданным connection и сбрасывает снимок отделов', async () => {
    requestDepartmentsMirrorRefresh('admin_crud', 'internal');
    await vi.waitFor(() => expect(h.syncDepartmentsLogic).toHaveBeenCalledTimes(1));

    expect(h.syncDepartmentsLogic).toHaveBeenCalledWith('internal', {}, { mode: 'mirror_only' });
    // Снимок отделов Sigur мог быть снят до мутации — сбрасываем ДО синка.
    expect(h.invalidateDepartmentCache.mock.invocationCallOrder[0])
      .toBeLessThan(h.syncDepartmentsLogic.mock.invocationCallOrder[0]);
    await vi.waitFor(() => expect(h.notifySigurStructureChanged).toHaveBeenCalledWith({
      source: 'admin_crud',
      scope: 'departments',
    }));
    expect(h.invalidateCache).toHaveBeenCalledWith('structure:tree');
    expect(h.invalidateAccessibleScopeCache).toHaveBeenCalled();
    expect(h.releaseLock).toHaveBeenCalledTimes(1);
  });

  // vi.waitFor при включённых fake timers сам прокручивает таймеры и «съедает»
  // отложенный retry — в этих кейсах ждём только явным advanceTimersByTimeAsync.
  it('lock занят: синк не идёт, lock не освобождается, повтор по таймеру проходит', async () => {
    vi.useFakeTimers();
    h.acquireLock.mockRejectedValueOnce(new SyncInProgress('Синхронизация структуры уже выполняется.'));

    requestDepartmentsMirrorRefresh('admin_crud');
    await vi.advanceTimersByTimeAsync(0);

    expect(h.acquireLock).toHaveBeenCalledTimes(1);
    expect(h.syncDepartmentsLogic).not.toHaveBeenCalled();
    // release только при успешном acquire — иначе снимаем чужой lease.
    expect(h.releaseLock).not.toHaveBeenCalled();
    expect(h.notifySigurStructureChanged).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.syncDepartmentsLogic).toHaveBeenCalledTimes(1);
    expect(h.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('новая правка отменяет отложенный retry и пробует сразу', async () => {
    vi.useFakeTimers();
    h.acquireLock.mockRejectedValueOnce(new SyncInProgress());

    requestDepartmentsMirrorRefresh('admin_crud');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.syncDepartmentsLogic).not.toHaveBeenCalled();

    requestDepartmentsMirrorRefresh('admin_crud');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.syncDepartmentsLogic).toHaveBeenCalledTimes(1);

    // Отменённый таймер не должен дать лишний прогон.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.syncDepartmentsLogic).toHaveBeenCalledTimes(1);
  });

  it('серия правок во время работы даёт ровно один догоняющий прогон', async () => {
    let releaseSync: () => void = () => {};
    h.syncDepartmentsLogic.mockImplementationOnce(() => new Promise((resolve) => {
      releaseSync = () => resolve(SYNC_RESULT);
    }));

    requestDepartmentsMirrorRefresh('admin_crud');
    await vi.waitFor(() => expect(h.syncDepartmentsLogic).toHaveBeenCalledTimes(1));

    requestDepartmentsMirrorRefresh('admin_crud');
    requestDepartmentsMirrorRefresh('admin_crud');
    releaseSync();

    await vi.waitFor(() => expect(h.syncDepartmentsLogic).toHaveBeenCalledTimes(2));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.syncDepartmentsLogic).toHaveBeenCalledTimes(2);
  });

  it('на не-hub хосте молчит', async () => {
    h.isSigurRuntimeAllowed.mockReturnValue(false);
    requestDepartmentsMirrorRefresh('admin_crud');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(h.acquireLock).not.toHaveBeenCalled();
    expect(h.syncDepartmentsLogic).not.toHaveBeenCalled();
  });
});

describe('deactivateMirroredDepartments', () => {
  it('гасит переданные sigur-id и уведомляет один раз', async () => {
    const deactivated = await deactivateMirroredDepartments([150749, 150750, 150749]);

    expect(deactivated).toBe(1);
    expect(h.execute).toHaveBeenCalledWith(
      'UPDATE org_departments SET is_active = false WHERE sigur_department_id = ANY($1::int[])',
      [[150749, 150750]],
    );
    expect(h.notifySigurStructureChanged).toHaveBeenCalledTimes(1);
    expect(h.notifySigurStructureChanged).toHaveBeenCalledWith({ source: 'sigur_delete', scope: 'departments' });
  });

  it('пустой список: ни SQL, ни уведомления', async () => {
    expect(await deactivateMirroredDepartments([])).toBe(0);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.notifySigurStructureChanged).not.toHaveBeenCalled();
  });
});
