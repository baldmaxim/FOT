import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * Порядок инвалидаций в плановом цикле структуры:
 *  - дерево отделов публикуется сразу после коммита зеркала (onMirrorCommitted),
 *    не дожидаясь синка позиций/сотрудников (reconciliation тянет всех
 *    сотрудников Sigur — минуты на холодном кэше);
 *  - structure:positions сбрасывается только ПОСЛЕ синка должностей, иначе старый
 *    ответ закэшировался бы заново на 15 минут.
 */

// hoisted: RUN_STARTUP_SYNC вычисляется на этапе загрузки модуля планировщика,
// то есть до тела этого файла (ESM-импорты исполняются первыми).
vi.hoisted(() => {
  process.env.SIGUR_STRUCTURE_SYNC_ON_STARTUP = 'true';
});

const h = vi.hoisted(() => ({
  isConfigured: vi.fn(),
  getBackgroundConnectionType: vi.fn(),
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  syncDepartments: vi.fn(),
  syncPositions: vi.fn(),
  seedPositions: vi.fn(),
  syncEmployees: vi.fn(),
  invalidateOrgStructureCaches: vi.fn(),
  invalidateCache: vi.fn(),
  notify: vi.fn(),
  mirrorNotify: vi.fn(),
}));

vi.mock('./sigur.service.js', () => ({
  sigurService: {
    isConfigured: h.isConfigured,
    getBackgroundConnectionType: h.getBackgroundConnectionType,
  },
}));
vi.mock('./presence-polling.service.js', () => ({
  acquireStructureSyncSchedulerLock: h.acquireLock,
  releaseStructureSyncSchedulerLock: h.releaseLock,
  ManualSyncInProgressError: class ManualSyncInProgressError extends Error {},
}));
vi.mock('./sigur-sync.service.js', () => ({
  syncDepartmentsLogic: h.syncDepartments,
  syncPositionsFromSigurLogic: h.syncPositions,
  seedPositionsLogic: h.seedPositions,
  syncEmployeesLogic: h.syncEmployees,
}));
vi.mock('./employee-mapper.service.js', () => ({
  invalidateOrgStructureCaches: h.invalidateOrgStructureCaches,
}));
vi.mock('../middleware/cacheResponse.js', () => ({ invalidateCache: h.invalidateCache }));
vi.mock('./skud-realtime.service.js', () => ({ notifySigurStructureChanged: h.notify }));
vi.mock('./sigur-structure-refresh.service.js', () => ({
  invalidateStructureTreeAndNotify: h.mirrorNotify,
}));
vi.mock('./sigur-runtime-guard.service.js', () => ({
  isSigurRuntimeAllowed: () => true,
  logSigurRuntimeGuardSkip: vi.fn(),
}));
vi.mock('../utils/sentry-cron.js', () => ({
  runWithCronMonitor: async (_name: string, fn: () => Promise<unknown>) => fn(),
}));

import { startStructureSyncScheduler, stopStructureSyncScheduler } from './sigur-structure-scheduler.service.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  h.isConfigured.mockResolvedValue(true);
  h.getBackgroundConnectionType.mockResolvedValue('external');
  h.acquireLock.mockResolvedValue(undefined);
  h.releaseLock.mockResolvedValue(undefined);
  h.syncDepartments.mockImplementation(async (
    _connection: unknown,
    _context: unknown,
    options?: { onMirrorCommitted?: () => void | Promise<void> },
  ) => {
    await options?.onMirrorCommitted?.();
    return { imported: 1 };
  });
  h.syncPositions.mockResolvedValue({});
  h.seedPositions.mockResolvedValue({ created: 0 });
  h.syncEmployees.mockResolvedValue({});
});

afterEach(() => {
  stopStructureSyncScheduler();
  vi.useRealTimers();
});

describe('плановый цикл структуры', () => {
  it('дерево публикуется до синка позиций, structure:positions — только после', async () => {
    await startStructureSyncScheduler();
    await vi.advanceTimersByTimeAsync(31_000);

    expect(h.syncDepartments).toHaveBeenCalledTimes(1);
    expect(h.mirrorNotify).toHaveBeenCalledWith('scheduler_mirror');
    // Ранний checkpoint отработал раньше синка должностей.
    expect(h.mirrorNotify.mock.invocationCallOrder[0])
      .toBeLessThan(h.syncPositions.mock.invocationCallOrder[0]);

    const positionsInvalidation = h.invalidateCache.mock.invocationCallOrder[
      h.invalidateCache.mock.calls.findIndex(call => call[0] === 'structure:positions')
    ];
    expect(positionsInvalidation).toBeGreaterThan(h.syncPositions.mock.invocationCallOrder[0]);
    expect(h.invalidateCache).toHaveBeenCalledWith('structure:tree');
    expect(h.notify).toHaveBeenCalledWith({ source: 'scheduler', scope: 'all' });
    expect(h.releaseLock).toHaveBeenCalledTimes(1);
  });
});

describe('плановый цикл: занятый lock', () => {
  it('тик на занятом lock повторяется через минуту, а не ждёт следующего тика', async () => {
    const { ManualSyncInProgressError } = await import('./presence-polling.service.js');
    h.acquireLock.mockRejectedValueOnce(new ManualSyncInProgressError('busy'));

    await startStructureSyncScheduler();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(h.syncDepartments).not.toHaveBeenCalled();
    expect(h.releaseLock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.syncDepartments).toHaveBeenCalledTimes(1);
    expect(h.syncEmployees).toHaveBeenCalledTimes(1);
    expect(h.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('повторы ограничены: после 5 неудач ждём следующего тика', async () => {
    const { ManualSyncInProgressError } = await import('./presence-polling.service.js');
    h.acquireLock.mockRejectedValue(new ManualSyncInProgressError('busy'));

    await startStructureSyncScheduler();
    await vi.advanceTimersByTimeAsync(31_000 + 10 * 60_000);
    // Стартовый прогон + 5 повторов.
    expect(h.acquireLock).toHaveBeenCalledTimes(6);
  });

  it('остановка планировщика снимает отложенный повтор', async () => {
    const { ManualSyncInProgressError } = await import('./presence-polling.service.js');
    h.acquireLock.mockRejectedValueOnce(new ManualSyncInProgressError('busy'));

    await startStructureSyncScheduler();
    await vi.advanceTimersByTimeAsync(31_000);
    stopStructureSyncScheduler();
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(h.acquireLock).toHaveBeenCalledTimes(1);
    expect(h.syncDepartments).not.toHaveBeenCalled();
  });
});
