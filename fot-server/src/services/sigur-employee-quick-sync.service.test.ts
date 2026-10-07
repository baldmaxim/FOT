import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * Очередь точечного синка: debounce/max-wait, версии карточек (повторная правка во
 * время прогона не теряется), повторы при занятом lock и ошибках, раздельные подключения.
 */

const h = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  syncEmployees: vi.fn(),
  isSigurRuntimeAllowed: vi.fn(() => true),
}));

class SyncInProgress extends Error {
  readonly code = 'SYNC_IN_PROGRESS';
}

vi.mock('./presence-polling.service.js', () => ({
  acquireStructureSyncSchedulerLock: h.acquireLock,
  releaseStructureSyncSchedulerLock: h.releaseLock,
}));
vi.mock('./sigur-sync-employees.service.js', () => ({ syncEmployeesLogic: h.syncEmployees }));
vi.mock('./sigur-runtime-guard.service.js', () => ({
  isSigurRuntimeAllowed: h.isSigurRuntimeAllowed,
  logSigurRuntimeGuardSkip: vi.fn(),
}));
vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));

import {
  __getEmployeeQuickSyncQueueForTests,
  __resetEmployeeQuickSyncForTests,
  requestEmployeeQuickSync,
} from './sigur-employee-quick-sync.service.js';

type TOutcome = 'inserted' | 'unchanged' | 'retryable' | 'not_found';

/** syncEmployeesLogic, отдающий исход по каждой карточке. */
const outcomesBy = (fn: (sigurId: number) => TOutcome) => async (
  _connection: unknown,
  _onProgress: unknown,
  _context: unknown,
  _autoInsert: unknown,
  options: { onlySigurIds: number[] },
) => ({ quick_outcomes: new Map(options.onlySigurIds.map(id => [id, fn(id)])) });

const requestedIds = (callIdx: number): number[] => h.syncEmployees.mock.calls[callIdx][4].onlySigurIds;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  __resetEmployeeQuickSyncForTests();
  h.isSigurRuntimeAllowed.mockReturnValue(true);
  h.acquireLock.mockResolvedValue(undefined);
  h.releaseLock.mockResolvedValue(undefined);
  h.syncEmployees.mockImplementation(outcomesBy(() => 'inserted'));
});

afterEach(() => {
  __resetEmployeeQuickSyncForTests();
  vi.useRealTimers();
});

describe('очередь точечного синка', () => {
  it('две правки за 15 с — один прогон по обеим карточкам', async () => {
    requestEmployeeQuickSync(151896, 'external');
    await vi.advanceTimersByTimeAsync(6_000);
    requestEmployeeQuickSync(151897, 'external');
    await vi.advanceTimersByTimeAsync(14_000);
    expect(h.syncEmployees).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_500);
    expect(h.syncEmployees).toHaveBeenCalledTimes(1);
    expect(h.syncEmployees.mock.calls[0][0]).toBe('external');
    expect(requestedIds(0)).toEqual([151896, 151897]);
    expect(h.releaseLock).toHaveBeenCalledTimes(1);
    expect(__getEmployeeQuickSyncQueueForTests('external')?.size).toBe(0);
  });

  it('непрерывные правки не откладывают запуск дольше 60 с от первой', async () => {
    requestEmployeeQuickSync(1);
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      requestEmployeeQuickSync(100 + i);
    }
    expect(h.syncEmployees).toHaveBeenCalledTimes(1);
    expect(requestedIds(0)).toContain(1);
  });

  it('повторная правка той же карточки во время прогона не теряется', async () => {
    let release: () => void = () => undefined;
    h.syncEmployees.mockImplementationOnce(async (...args: Parameters<ReturnType<typeof outcomesBy>>) => {
      // Пока идёт прогон, карточку правят ещё раз.
      requestEmployeeQuickSync(151896);
      await new Promise<void>(resolve => { release = resolve; });
      return outcomesBy(() => 'unchanged')(...args);
    });

    requestEmployeeQuickSync(151896);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.syncEmployees).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);

    // Первый прогон не снял карточку — вторая правка уходит следующим прогоном.
    expect(__getEmployeeQuickSyncQueueForTests()?.has(151896)).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.syncEmployees).toHaveBeenCalledTimes(2);
    expect(requestedIds(1)).toEqual([151896]);
    expect(__getEmployeeQuickSyncQueueForTests()?.size).toBe(0);
  });

  it('занятый lock — повтор с backoff, попытки карточки не тратятся, release не вызывается', async () => {
    h.acquireLock.mockRejectedValueOnce(new SyncInProgress('busy'));

    requestEmployeeQuickSync(151896);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.syncEmployees).not.toHaveBeenCalled();
    expect(h.releaseLock).not.toHaveBeenCalled();
    expect(__getEmployeeQuickSyncQueueForTests()?.get(151896)?.attempts).toBe(0);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.syncEmployees).toHaveBeenCalledTimes(1);
    expect(h.releaseLock).toHaveBeenCalledTimes(1);
    expect(__getEmployeeQuickSyncQueueForTests()?.size).toBe(0);
  });

  it('retryable — остаётся и повторяется; окончательные исходы снимаются', async () => {
    let failing = true;
    h.syncEmployees.mockImplementation(outcomesBy(id => {
      if (id === 2 && failing) return 'retryable';
      return id === 3 ? 'not_found' : 'inserted';
    }));

    requestEmployeeQuickSync(1);
    requestEmployeeQuickSync(2);
    requestEmployeeQuickSync(3);
    await vi.advanceTimersByTimeAsync(15_000);

    const queue = __getEmployeeQuickSyncQueueForTests();
    expect([...(queue?.keys() ?? [])]).toEqual([2]);
    expect(queue?.get(2)?.attempts).toBe(1);

    failing = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requestedIds(1)).toEqual([2]);
    expect(queue?.size).toBe(0);
  });

  it('новая правка сбрасывает счётчик неудач', async () => {
    h.syncEmployees.mockImplementation(outcomesBy(() => 'retryable'));
    requestEmployeeQuickSync(2);
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(__getEmployeeQuickSyncQueueForTests()?.get(2)?.attempts).toBe(2);

    requestEmployeeQuickSync(2);
    expect(__getEmployeeQuickSyncQueueForTests()?.get(2)?.attempts).toBe(0);
  });

  it('после 10 неудач одной версии карточка снимается (её подхватит плановый синк)', async () => {
    h.syncEmployees.mockImplementation(outcomesBy(() => 'retryable'));
    requestEmployeeQuickSync(2);
    await vi.advanceTimersByTimeAsync(15 * 60_000);

    expect(h.syncEmployees).toHaveBeenCalledTimes(10);
    expect(__getEmployeeQuickSyncQueueForTests()?.size).toBe(0);
  });

  it('ошибка прогона целиком — повтор, карточки не теряются', async () => {
    h.syncEmployees.mockRejectedValueOnce(new Error('Sigur timeout'));
    requestEmployeeQuickSync(5);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(__getEmployeeQuickSyncQueueForTests()?.get(5)?.attempts).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.syncEmployees).toHaveBeenCalledTimes(2);
    expect(__getEmployeeQuickSyncQueueForTests()?.size).toBe(0);
  });

  it('разные подключения — раздельные пачки под одним lock', async () => {
    requestEmployeeQuickSync(1, 'external');
    requestEmployeeQuickSync(2, 'internal');
    await vi.advanceTimersByTimeAsync(15_000);

    expect(h.syncEmployees).toHaveBeenCalledTimes(2);
    const byConnection = new Map(h.syncEmployees.mock.calls.map(call => [call[0], call[4].onlySigurIds]));
    expect(byConnection.get('external')).toEqual([1]);
    expect(byConnection.get('internal')).toEqual([2]);
    expect(h.acquireLock).toHaveBeenCalledTimes(1);
    expect(h.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('не runtime-хост — ничего не ставится', async () => {
    h.isSigurRuntimeAllowed.mockReturnValue(false);
    requestEmployeeQuickSync(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.syncEmployees).not.toHaveBeenCalled();
    expect(__getEmployeeQuickSyncQueueForTests()).toBeUndefined();
  });
});
