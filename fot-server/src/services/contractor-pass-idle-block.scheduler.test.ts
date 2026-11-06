import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/node';

const m = vi.hoisted(() => ({
  run: vi.fn(),
  enabled: vi.fn(),
  tryAcquire: vi.fn(),
  merge: vi.fn(),
  release: vi.fn(),
  startHeartbeat: vi.fn(),
  stopHeartbeat: vi.fn(),
}));

vi.mock('./contractor-pass-idle-block.service.js', () => ({
  runContractorPassIdleBlock: m.run,
  isIdleBlockNightlyEnabled: m.enabled,
  summarizeIdleBlock: (result: { status: string }) => ({ status: result.status }),
}));
vi.mock('./sigur-runtime-state.service.js', () => ({
  getSigurRuntimeOwner: (scope: string) => `${scope}:test`,
  tryAcquireSigurRuntimeLease: m.tryAcquire,
  mergeSigurRuntimeState: m.merge,
  releaseSigurRuntimeLease: m.release,
  startSigurRuntimeLeaseHeartbeat: m.startHeartbeat,
}));
vi.mock('./sigur.service.js', () => ({ sigurService: { isConfigured: vi.fn() } }));
vi.mock('./sigur-runtime-guard.service.js', () => ({
  isSigurRuntimeAllowed: () => true,
  logSigurRuntimeGuardSkip: vi.fn(),
}));
vi.mock('../utils/sentry-cron.js', () => ({
  runWithCronMonitor: async (_slug: string, fn: () => Promise<unknown>) => { await fn(); },
}));

const {
  IDLE_BLOCK_RETRY_AFTER_FAILURE_MS,
  IDLE_BLOCK_TICK_ERROR_BACKOFF_MS,
  resetIdleBlockSchedulerState,
  runIdleBlockTick,
  shouldRunIdleBlock,
} = await import('./contractor-pass-idle-block.scheduler.js');

/** МСК = UTC+3. */
const msk = (iso: string): Date => new Date(`${iso}+03:00`);
const NIGHT = msk('2026-11-06T04:05:00');
const result = (status: string) => ({ status });
const acquired = (meta: Record<string, unknown> = {}) => ({ acquired: true, row: { meta } });

const savedMeta = (): Record<string, unknown> =>
  (m.merge.mock.calls.at(-1)?.[0] as { meta: Record<string, unknown> } | undefined)?.meta ?? {};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NIGHT);
  resetIdleBlockSchedulerState();
  m.enabled.mockResolvedValue(true);
  m.tryAcquire.mockResolvedValue(acquired());
  m.merge.mockResolvedValue({ key: 'contractor_pass_idle_block_daily' });
  m.release.mockResolvedValue(true);
  m.startHeartbeat.mockReturnValue(m.stopHeartbeat);
  m.run.mockResolvedValue(result('completed'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('shouldRunIdleBlock', () => {
  it.each([
    ['2026-11-06T03:59:00', false],
    ['2026-11-06T04:00:00', true],
    ['2026-11-06T05:59:00', true],
    ['2026-11-06T06:00:00', false],
    ['2026-11-06T12:00:00', false],
  ])('%s → %s', (time, expected) => {
    expect(shouldRunIdleBlock(null, msk(time))).toBe(expected);
  });

  it('день уже засчитан — нет; повтор — не раньше nextRetryAt', () => {
    expect(shouldRunIdleBlock({ lastCompletedYmdMsk: '2026-11-06', nextRetryAt: null }, NIGHT)).toBe(false);
    expect(shouldRunIdleBlock({ lastCompletedYmdMsk: '2026-11-05', nextRetryAt: null }, NIGHT)).toBe(true);
    expect(shouldRunIdleBlock({
      lastCompletedYmdMsk: null,
      nextRetryAt: new Date(NIGHT.getTime() + 60_000).toISOString(),
    }, NIGHT)).toBe(false);
  });
});

describe('runIdleBlockTick', () => {
  it('настройка выключена или строки нет: ни прогона, ни lease, ни сверки', async () => {
    m.enabled.mockResolvedValue(false);

    await runIdleBlockTick(NIGHT);

    expect(m.tryAcquire).not.toHaveBeenCalled();
    expect(m.run).not.toHaveBeenCalled();
    expect(m.release).not.toHaveBeenCalled();
  });

  it('вне окна настройку не читает', async () => {
    await runIdleBlockTick(msk('2026-11-06T12:00:00'));

    expect(m.enabled).not.toHaveBeenCalled();
    expect(m.run).not.toHaveBeenCalled();
  });

  it('включена: запуск без limit и force, день засчитан, lease отпущен', async () => {
    await runIdleBlockTick(NIGHT);

    expect(m.run).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false, triggeredBy: 'scheduler' }));
    expect(m.run.mock.calls[0][0]).not.toHaveProperty('limit');
    expect(m.run.mock.calls[0][0]).not.toHaveProperty('force');
    expect(savedMeta()).toMatchObject({ lastCompletedYmdMsk: '2026-11-06', nextRetryAt: null });
    expect(m.release).toHaveBeenCalledTimes(1);
    expect(m.stopHeartbeat).toHaveBeenCalledTimes(1);
  });

  it('второй тик той же ночи не запускает', async () => {
    await runIdleBlockTick(NIGHT);
    await runIdleBlockTick(new Date(NIGHT.getTime() + 60_000));

    expect(m.run).toHaveBeenCalledTimes(1);
  });

  it.each(['events_gap', 'mass_stop'])('%s засчитывает день: повтор не лечит', async status => {
    m.run.mockResolvedValue(result(status));

    await runIdleBlockTick(NIGHT);

    expect(savedMeta()).toMatchObject({ lastCompletedYmdMsk: '2026-11-06' });
  });

  it('partial: повтор через час, день не засчитан', async () => {
    m.run.mockResolvedValue(result('partial'));

    await runIdleBlockTick(NIGHT);

    expect(savedMeta().lastCompletedYmdMsk).toBeUndefined();
    expect(savedMeta().nextRetryAt).toBe(new Date(NIGHT.getTime() + IDLE_BLOCK_RETRY_AFTER_FAILURE_MS).toISOString());
    await runIdleBlockTick(new Date(NIGHT.getTime() + 60_000));
    expect(m.run).toHaveBeenCalledTimes(1);
  });

  it('ошибка прогона: Sentry, повтор через час', async () => {
    m.run.mockRejectedValue(new Error('db down'));

    await runIdleBlockTick(NIGHT);

    expect(Sentry.captureException).toHaveBeenCalled();
    expect(savedMeta().lastError).toBe('db down');
    expect(savedMeta().nextRetryAt).toBe(new Date(NIGHT.getTime() + IDLE_BLOCK_RETRY_AFTER_FAILURE_MS).toISOString());
  });

  it('lease занят (идёт CLI): не запускаем', async () => {
    m.tryAcquire.mockResolvedValue({ acquired: false, row: null });

    await runIdleBlockTick(NIGHT);

    expect(m.run).not.toHaveBeenCalled();
    expect(m.release).not.toHaveBeenCalled();
  });

  it('день засчитан другим процессом: авторитетно по состоянию из lease', async () => {
    m.tryAcquire.mockResolvedValue(acquired({ lastCompletedYmdMsk: '2026-11-06' }));

    await runIdleBlockTick(NIGHT);

    expect(m.run).not.toHaveBeenCalled();
    expect(m.release).toHaveBeenCalledTimes(1);
  });

  it('сбой чтения настройки: пауза, процесс не падает', async () => {
    m.enabled.mockRejectedValue(new Error('db down'));

    await runIdleBlockTick(NIGHT);
    await runIdleBlockTick(new Date(NIGHT.getTime() + IDLE_BLOCK_TICK_ERROR_BACKOFF_MS - 1000));

    expect(m.enabled).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('потеря lease доходит до сервиса', async () => {
    let shouldAbort: (() => boolean) | undefined;
    m.run.mockImplementation(async (params: { shouldAbort: () => boolean }) => {
      shouldAbort = params.shouldAbort;
      return result('completed');
    });
    m.startHeartbeat.mockImplementation((params: { onLost: () => void }) => {
      params.onLost();
      return m.stopHeartbeat;
    });

    await runIdleBlockTick(NIGHT);

    expect(shouldAbort?.()).toBe(true);
  });
});
