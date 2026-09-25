import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/node';

const m = vi.hoisted(() => {
  class SigurCardLeaseBusyError extends Error {}
  return {
    SigurCardLeaseBusyError,
    run: vi.fn(),
    tryAcquire: vi.fn(),
    merge: vi.fn(),
    release: vi.fn(),
    startHeartbeat: vi.fn(),
    stopHeartbeat: vi.fn(),
  };
});

vi.mock('./contractor-pass-expiry-sync.service.js', () => ({
  runContractorPassExpirySync: m.run,
  summarizePassExpirySync: (result: { status: string }) => ({ status: result.status }),
}));
vi.mock('./sigur-runtime-state.service.js', () => ({
  getSigurRuntimeOwner: (scope: string) => `${scope}:test`,
  tryAcquireSigurRuntimeLease: m.tryAcquire,
  mergeSigurRuntimeState: m.merge,
  releaseSigurRuntimeLease: m.release,
  startSigurRuntimeLeaseHeartbeat: m.startHeartbeat,
}));
vi.mock('./sigur-card-lease.service.js', () => ({ SigurCardLeaseBusyError: m.SigurCardLeaseBusyError }));
vi.mock('./sigur.service.js', () => ({ sigurService: { isConfigured: vi.fn() } }));
vi.mock('./sigur-runtime-guard.service.js', () => ({
  isSigurRuntimeAllowed: () => true,
  logSigurRuntimeGuardSkip: vi.fn(),
}));
vi.mock('../utils/sentry-cron.js', () => ({
  runWithCronMonitor: async (_slug: string, fn: () => Promise<unknown>) => { await fn(); },
}));

const {
  PASS_EXPIRY_RETRY_AFTER_FAILURE_MS,
  PASS_EXPIRY_TICK_ERROR_BACKOFF_MS,
  resetPassExpirySchedulerState,
  runPassExpirySyncTick,
  shouldRunPassExpirySync,
} = await import('./contractor-pass-expiry-sync.scheduler.js');

/** МСК = UTC+3. */
const msk = (iso: string): Date => new Date(`${iso}+03:00`);
const NIGHT = msk('2026-09-26T01:05:00');
const result = (status: 'completed' | 'partial' | 'blocked') => ({ status });
const acquired = (meta: Record<string, unknown> = {}) => ({ acquired: true, row: { meta } });

/** Последний merge состояния — то, что планировщик сохранил в sigur_runtime_state.meta. */
const savedMeta = (): Record<string, unknown> =>
  (m.merge.mock.calls.at(-1)?.[0] as { meta: Record<string, unknown> } | undefined)?.meta ?? {};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NIGHT);
  resetPassExpirySchedulerState();
  m.tryAcquire.mockResolvedValue(acquired());
  m.merge.mockResolvedValue({ key: 'contractor_pass_expiry_daily' });
  m.release.mockResolvedValue(true);
  m.startHeartbeat.mockReturnValue(m.stopHeartbeat);
  m.run.mockResolvedValue(result('completed'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('shouldRunPassExpirySync', () => {
  it('только в ночном окне 01:00–05:59 МСК', () => {
    expect(shouldRunPassExpirySync(null, msk('2026-09-26T00:59:00'))).toBe(false);
    expect(shouldRunPassExpirySync(null, msk('2026-09-26T01:00:00'))).toBe(true);
    expect(shouldRunPassExpirySync(null, msk('2026-09-26T05:59:00'))).toBe(true);
    expect(shouldRunPassExpirySync(null, msk('2026-09-26T06:00:00'))).toBe(false);
    expect(shouldRunPassExpirySync(null, msk('2026-09-26T14:00:00'))).toBe(false);
  });

  it('день уже засчитан — не запускать; вчерашний — запускать', () => {
    const now = msk('2026-09-26T02:00:00');
    expect(shouldRunPassExpirySync({ lastCompletedYmdMsk: '2026-09-26', nextRetryAt: null }, now)).toBe(false);
    expect(shouldRunPassExpirySync({ lastCompletedYmdMsk: '2026-09-25', nextRetryAt: null }, now)).toBe(true);
  });

  it('после сбоя — не раньше чем через час', () => {
    const failedAt = msk('2026-09-26T01:10:00');
    const state = {
      lastCompletedYmdMsk: null,
      nextRetryAt: new Date(failedAt.getTime() + PASS_EXPIRY_RETRY_AFTER_FAILURE_MS).toISOString(),
    };
    expect(shouldRunPassExpirySync(state, msk('2026-09-26T02:09:00'))).toBe(false);
    expect(shouldRunPassExpirySync(state, msk('2026-09-26T02:10:00'))).toBe(true);
  });

  it('сутки считаются по МСК, а не по UTC', () => {
    // 22:30Z 25.09 = 01:30 МСК 26.09.
    const now = new Date('2026-09-25T22:30:00Z');
    expect(shouldRunPassExpirySync({ lastCompletedYmdMsk: '2026-09-25', nextRetryAt: null }, now)).toBe(true);
    expect(shouldRunPassExpirySync({ lastCompletedYmdMsk: '2026-09-26', nextRetryAt: null }, now)).toBe(false);
  });
});

describe('runPassExpirySyncTick', () => {
  it('completed — день засчитан, lease отпущен, второй тик в тот же день ничего не делает', async () => {
    await runPassExpirySyncTick(NIGHT);

    expect(m.run).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false, triggeredBy: 'scheduler' }));
    expect(savedMeta()).toMatchObject({ lastCompletedYmdMsk: '2026-09-26', nextRetryAt: null, lastError: null });
    expect(m.merge).toHaveBeenLastCalledWith(expect.objectContaining({ owner: 'contractor-pass-expiry:test' }));
    expect(m.stopHeartbeat).toHaveBeenCalledTimes(1);
    expect(m.release).toHaveBeenCalledTimes(1);

    await runPassExpirySyncTick(msk('2026-09-26T01:06:00'));
    expect(m.tryAcquire).toHaveBeenCalledTimes(1);
    expect(m.run).toHaveBeenCalledTimes(1);
  });

  it('рестарт после успеха: состояние из БД под lease — прогона нет', async () => {
    m.tryAcquire.mockResolvedValue(acquired({ lastCompletedYmdMsk: '2026-09-26' }));
    await runPassExpirySyncTick(NIGHT);

    expect(m.run).not.toHaveBeenCalled();
    expect(m.release).toHaveBeenCalledTimes(1);
  });

  it('lease у другого процесса — прогона нет, чужой lease не отпускаем', async () => {
    m.tryAcquire.mockResolvedValue({ acquired: false, row: null });
    await runPassExpirySyncTick(NIGHT);

    expect(m.run).not.toHaveBeenCalled();
    expect(m.release).not.toHaveBeenCalled();
  });

  it('вне окна — даже lease не берётся', async () => {
    await runPassExpirySyncTick(msk('2026-09-26T12:00:00'));
    expect(m.tryAcquire).not.toHaveBeenCalled();
  });

  it('partial — повтор через час, день не засчитан', async () => {
    m.run.mockResolvedValue(result('partial'));
    await runPassExpirySyncTick(NIGHT);

    const meta = savedMeta();
    expect(meta.lastCompletedYmdMsk).toBeUndefined();
    expect(meta.nextRetryAt).toBe(new Date(NIGHT.getTime() + PASS_EXPIRY_RETRY_AFTER_FAILURE_MS).toISOString());

    await runPassExpirySyncTick(msk('2026-09-26T02:04:00'));
    expect(m.run).toHaveBeenCalledTimes(1);

    m.tryAcquire.mockResolvedValue(acquired({ nextRetryAt: meta.nextRetryAt }));
    m.run.mockResolvedValue(result('completed'));
    await runPassExpirySyncTick(msk('2026-09-26T02:05:00'));
    expect(m.run).toHaveBeenCalledTimes(2);
  });

  it('blocked — день засчитан, повторов до завтра нет', async () => {
    m.run.mockResolvedValue(result('blocked'));
    await runPassExpirySyncTick(NIGHT);
    expect(savedMeta()).toMatchObject({ lastCompletedYmdMsk: '2026-09-26' });

    await runPassExpirySyncTick(msk('2026-09-26T03:00:00'));
    expect(m.run).toHaveBeenCalledTimes(1);
  });

  it('ошибка прогона — lastError, повтор через час, событие в Sentry', async () => {
    m.run.mockRejectedValue(new Error('Sigur недоступен'));
    await runPassExpirySyncTick(NIGHT);

    expect(savedMeta()).toMatchObject({
      lastError: 'Sigur недоступен',
      nextRetryAt: new Date(NIGHT.getTime() + PASS_EXPIRY_RETRY_AFTER_FAILURE_MS).toISOString(),
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(m.release).toHaveBeenCalledTimes(1);
  });

  it('lock карт занят — отложено без паузы, следующий тик пробует снова', async () => {
    m.run.mockRejectedValueOnce(new m.SigurCardLeaseBusyError('busy'));
    await runPassExpirySyncTick(NIGHT);

    expect(savedMeta().nextRetryAt).toBeUndefined();
    expect(Sentry.captureException).not.toHaveBeenCalled();

    await runPassExpirySyncTick(msk('2026-09-26T01:06:00'));
    expect(m.run).toHaveBeenCalledTimes(2);
  });

  it.each(['onLost', 'onError'] as const)('потеря суточного lease (%s) доходит до сервиса как shouldAbort', async callback => {
    // Проверки — снаружи: исключение внутри прогона планировщик поймал бы как сбой.
    const seen: boolean[] = [];
    m.run.mockImplementation(async (params: { shouldAbort: () => boolean }) => {
      seen.push(params.shouldAbort());
      const heartbeat = m.startHeartbeat.mock.calls[0][0] as Record<'onLost' | 'onError', () => void>;
      heartbeat[callback]();
      seen.push(params.shouldAbort());
      return result('partial');
    });
    await runPassExpirySyncTick(NIGHT);

    expect(seen).toEqual([false, true]);
    expect(m.release).toHaveBeenCalledTimes(1);
  });

  it('сбой захвата lease (БД) — пауза 15 минут, а не ошибка каждую минуту', async () => {
    m.tryAcquire.mockRejectedValueOnce(new Error('connection terminated'));
    await runPassExpirySyncTick(NIGHT);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);

    await runPassExpirySyncTick(new Date(NIGHT.getTime() + PASS_EXPIRY_TICK_ERROR_BACKOFF_MS - 60_000));
    expect(m.tryAcquire).toHaveBeenCalledTimes(1);

    await runPassExpirySyncTick(new Date(NIGHT.getTime() + PASS_EXPIRY_TICK_ERROR_BACKOFF_MS));
    expect(m.tryAcquire).toHaveBeenCalledTimes(2);
    expect(m.run).toHaveBeenCalledTimes(1);
  });

  it('параллельные тики не запускают второй прогон', async () => {
    let finish: () => void = () => {};
    m.run.mockImplementation(() => new Promise(resolve => { finish = () => resolve(result('completed')); }));

    const first = runPassExpirySyncTick(NIGHT);
    const second = runPassExpirySyncTick(NIGHT);
    await vi.waitFor(() => expect(m.run).toHaveBeenCalledTimes(1));
    finish();
    await Promise.all([first, second]);
    expect(m.tryAcquire).toHaveBeenCalledTimes(1);
  });
});
