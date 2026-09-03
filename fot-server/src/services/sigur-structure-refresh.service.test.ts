import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * Точечный refresh зеркала отделов после CRUD в Sigur: конкуренция за
 * structure-sync lock, коалесинг серии правок, целевая деактивация удалённых.
 */

const h = vi.hoisted(() => ({
  execute: vi.fn(),
  query: vi.fn(),
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

vi.mock('../config/postgres.js', () => ({ execute: h.execute, query: h.query }));
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
vi.mock('@sentry/node', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import {
  __resetStructureRefreshStateForTests,
  deactivateMirroredDepartments,
  requestDepartmentsMirrorRefresh,
  runDepartmentsMirrorRefreshNow,
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
  beforeEach(() => {
    // По умолчанию в удалённых отделах никого нет.
    h.query.mockResolvedValue([]);
    h.execute.mockResolvedValue(1);
  });

  it('гасит переданные sigur-id и уведомляет один раз', async () => {
    const deactivated = await deactivateMirroredDepartments([150749, 150750, 150749]);

    expect(deactivated).toBe(1);
    expect(h.execute).toHaveBeenCalledWith(
      expect.stringContaining('SET is_active = false, is_assignable = false'),
      [[150749, 150750]],
    );
    expect(h.notifySigurStructureChanged).toHaveBeenCalledTimes(1);
    expect(h.notifySigurStructureChanged).toHaveBeenCalledWith({ source: 'sigur_delete', scope: 'departments' });
  });

  it('отдел с сотрудниками не гасится, а становится неназначаемым', async () => {
    h.query.mockResolvedValue([
      { sigur_department_id: 150749, name: 'Секретариат', employees: '8' },
    ]);

    const deactivated = await deactivateMirroredDepartments([150749, 150750]);

    // Гасим только пустой 150750, населённый 150749 остаётся видимым.
    expect(h.execute).toHaveBeenCalledWith(
      expect.stringContaining('SET is_assignable = false'),
      [[150749]],
    );
    expect(h.execute).toHaveBeenCalledWith(
      expect.stringContaining('SET is_active = false, is_assignable = false'),
      [[150750]],
    );
    expect(deactivated).toBe(1);
  });

  it('все удалённые отделы населены: ни одного гашения, но уведомление есть', async () => {
    h.query.mockResolvedValue([
      { sigur_department_id: 150749, name: 'Секретариат', employees: '8' },
    ]);

    expect(await deactivateMirroredDepartments([150749])).toBe(0);
    expect(h.execute).toHaveBeenCalledTimes(1); // только is_assignable=false
    expect(h.notifySigurStructureChanged).toHaveBeenCalledTimes(1);
  });

  it('пустой список: ни SQL, ни уведомления', async () => {
    expect(await deactivateMirroredDepartments([])).toBe(0);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.notifySigurStructureChanged).not.toHaveBeenCalled();
  });
});

describe('runDepartmentsMirrorRefreshNow', () => {
  it('резолвится после успешного прогона зеркала', async () => {
    h.syncDepartmentsLogic.mockResolvedValue(SYNC_RESULT);

    await expect(runDepartmentsMirrorRefreshNow('admin_crud')).resolves.toEqual({ ok: true });
    expect(h.syncDepartmentsLogic).toHaveBeenCalledTimes(1);
  });

  it('ждёт СЛЕДУЮЩИЙ прогон: идущий сейчас мог прочитать Sigur до нашей правки', async () => {
    let releaseFirst: (() => void) | null = null;
    h.syncDepartmentsLogic
      .mockImplementationOnce(async () => {
        await new Promise<void>(resolve => { releaseFirst = resolve; });
        return SYNC_RESULT;
      })
      .mockResolvedValue(SYNC_RESULT);

    // Первый прогон стартовал и «завис» — наш запрос не должен закрыться им.
    requestDepartmentsMirrorRefresh('admin_crud');
    await new Promise(resolve => setTimeout(resolve, 5));

    let settled = false;
    const pending = runDepartmentsMirrorRefreshNow('admin_crud').then(result => {
      settled = true;
      return result;
    });

    await new Promise(resolve => setTimeout(resolve, 5));
    expect(settled).toBe(false);

    releaseFirst?.();
    await expect(pending).resolves.toEqual({ ok: true });
    expect(h.syncDepartmentsLogic).toHaveBeenCalledTimes(2);
  });

  it('на не-hub хосте отвечает сразу, не трогая Sigur', async () => {
    h.isSigurRuntimeAllowed.mockReturnValue(false);

    await expect(runDepartmentsMirrorRefreshNow('admin_crud')).resolves.toEqual({
      ok: false,
      reason: 'runtime_guard',
    });
    expect(h.syncDepartmentsLogic).not.toHaveBeenCalled();
  });

  it('неуспешный прогон закрывается таймаутом, а не висит вечно', async () => {
    h.syncDepartmentsLogic.mockRejectedValue(new SyncInProgress('lock busy'));

    await expect(
      runDepartmentsMirrorRefreshNow('admin_crud', undefined, { timeoutMs: 30 }),
    ).resolves.toEqual({ ok: false, reason: 'timeout' });
  });
});
