import * as Sentry from '@sentry/node';
import { runWithCronMonitor, type CronRunStatus } from '../utils/sentry-cron.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import { sigurService } from './sigur.service.js';
import { isSigurRuntimeAllowed, logSigurRuntimeGuardSkip } from './sigur-runtime-guard.service.js';
import {
  getSigurRuntimeOwner,
  mergeSigurRuntimeState,
  releaseSigurRuntimeLease,
  startSigurRuntimeLeaseHeartbeat,
  tryAcquireSigurRuntimeLease,
} from './sigur-runtime-state.service.js';
import {
  isIdleBlockNightlyEnabled,
  runContractorPassIdleBlock,
  summarizeIdleBlock,
} from './contractor-pass-idle-block.service.js';

/**
 * Ночная автоблокировка пропусков подрядчиков, которые не ходят больше 5 дней — раз в сутки.
 *
 * Выключена, пока system_settings.contractor_pass_idle_block_enabled не равно 'true': лимит 300
 * выключателем не считается, партии начальной очереди опустили бы очередь ниже него.
 *
 * Окно 04:00–05:59 МСК: дозагрузка событий за сутки (sigur_events_daily) заканчивается около 03:00,
 * иначе пропущенный проход выглядел бы как простой.
 *
 * Суточный захват — runtime lease (его же берёт CLI). День засчитан после completed, events_gap
 * и mass_stop: они не лечатся повтором в ту же ночь. Partial или ошибка — повтор через час.
 */
const TICK_INTERVAL_MS = 60_000;
const STARTUP_DELAY_MS = 60_000;
export const IDLE_BLOCK_DAILY_STATE_KEY = 'contractor_pass_idle_block_daily';
export const IDLE_BLOCK_LEASE_TTL_SECONDS = 600;

export const IDLE_BLOCK_WINDOW_START_HOUR_MSK = 4;
/** Час МСК, с которого окно уже закрыто. */
export const IDLE_BLOCK_WINDOW_END_HOUR_MSK = 6;
export const IDLE_BLOCK_RETRY_AFTER_FAILURE_MS = 60 * 60_000;
/** Пауза после сбоя самого тика (захват lease, БД): не слать ошибку в Sentry каждую минуту. */
export const IDLE_BLOCK_TICK_ERROR_BACKOFF_MS = 15 * 60_000;

export interface IIdleBlockSchedulerState {
  lastCompletedYmdMsk: string | null;
  nextRetryAt: string | null;
}

let timer: ReturnType<typeof setInterval> | null = null;
let startupTimeout: ReturnType<typeof setTimeout> | null = null;
let runInFlight: Promise<void> | null = null;
/** Кэш суточного состояния — экономит обращение к БД на каждом тике. Авторитетно — под lease. */
let cachedState: IIdleBlockSchedulerState | null = null;

/** Для тестов: забыть кэш суточного состояния. */
export function resetIdleBlockSchedulerState(): void {
  cachedState = null;
}

const moscowHour = (now: Date): number =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', hour12: false }).format(now)) % 24;

/** Пора ли прогонять. Чистая функция — решение планировщика покрыто тестами. */
export function shouldRunIdleBlock(state: IIdleBlockSchedulerState | null, now: Date): boolean {
  const hour = moscowHour(now);
  if (hour < IDLE_BLOCK_WINDOW_START_HOUR_MSK || hour >= IDLE_BLOCK_WINDOW_END_HOUR_MSK) return false;
  if (state?.lastCompletedYmdMsk === moscowTodayIso(now)) return false;
  if (state?.nextRetryAt) {
    const retryAtMs = Date.parse(state.nextRetryAt);
    if (Number.isFinite(retryAtMs) && now.getTime() < retryAtMs) return false;
  }
  return true;
}

const readState = (meta: Record<string, unknown> | null | undefined): IIdleBlockSchedulerState => ({
  lastCompletedYmdMsk: typeof meta?.lastCompletedYmdMsk === 'string' ? meta.lastCompletedYmdMsk : null,
  nextRetryAt: typeof meta?.nextRetryAt === 'string' ? meta.nextRetryAt : null,
});

/** Запись под owner: если lease уже у другого процесса, merge отвергается — его состояние главнее. */
async function saveState(owner: string, meta: Record<string, unknown>): Promise<void> {
  try {
    const row = await mergeSigurRuntimeState({ key: IDLE_BLOCK_DAILY_STATE_KEY, owner, meta });
    if (!row) console.warn('[pass-idle-block] состояние не сохранено: суточный lease у другого процесса');
  } catch (error) {
    console.error('[pass-idle-block] не удалось сохранить состояние:', error instanceof Error ? error.message : error);
  }
}

async function runDaily(now: Date, owner: string, isLeaseLost: () => boolean): Promise<CronRunStatus> {
  const ymd = moscowTodayIso(now);
  const attemptAt = new Date().toISOString();
  try {
    const result = await runContractorPassIdleBlock({
      dryRun: false,
      triggeredBy: 'scheduler',
      shouldAbort: isLeaseLost,
    });

    if (result.status === 'partial') {
      const nextRetryAt = new Date(Date.now() + IDLE_BLOCK_RETRY_AFTER_FAILURE_MS).toISOString();
      cachedState = { lastCompletedYmdMsk: cachedState?.lastCompletedYmdMsk ?? null, nextRetryAt };
      await saveState(owner, { lastAttemptAt: attemptAt, lastResult: summarizeIdleBlock(result), nextRetryAt });
      return 'error';
    }

    cachedState = { lastCompletedYmdMsk: ymd, nextRetryAt: null };
    await saveState(owner, {
      lastAttemptAt: attemptAt,
      lastCompletedYmdMsk: ymd,
      lastSuccessAt: new Date().toISOString(),
      lastResult: summarizeIdleBlock(result),
      nextRetryAt: null,
      lastError: null,
    });
    return result.status === 'completed' ? 'ok' : 'error';
  } catch (error) {
    const nextRetryAt = new Date(Date.now() + IDLE_BLOCK_RETRY_AFTER_FAILURE_MS).toISOString();
    cachedState = { lastCompletedYmdMsk: cachedState?.lastCompletedYmdMsk ?? null, nextRetryAt };
    console.error('[pass-idle-block] ошибка прогона:', error instanceof Error ? error.message : error);
    Sentry.captureException(error, { tags: { service: 'contractor-pass-idle-block' } });
    await saveState(owner, {
      lastAttemptAt: attemptAt,
      lastFailureAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error),
      nextRetryAt,
    });
    return 'error';
  }
}

export async function runIdleBlockTick(now: Date = new Date()): Promise<void> {
  if (runInFlight) return runInFlight;
  if (!shouldRunIdleBlock(cachedState, now)) return;

  const owner = getSigurRuntimeOwner('contractor-pass-idle-block');
  const current: Promise<void> = (async () => {
    let acquired = false;
    let leaseLost = false;
    let stopHeartbeat: (() => void) | null = null;
    try {
      // Выключатель — до lease: пока он выключен, не трогаем ни lease, ни Sentry-монитор.
      if (!(await isIdleBlockNightlyEnabled())) return;

      const lease = await tryAcquireSigurRuntimeLease({
        key: IDLE_BLOCK_DAILY_STATE_KEY,
        owner,
        ttlSeconds: IDLE_BLOCK_LEASE_TTL_SECONDS,
      });
      // Не захватили — прогон ведёт другой процесс или CLI.
      if (!lease.acquired) return;
      acquired = true;

      // Авторитетная проверка — по состоянию, вернувшемуся вместе с lease.
      const state = readState(lease.row?.meta);
      cachedState = state;
      if (!shouldRunIdleBlock(state, now)) return;

      stopHeartbeat = startSigurRuntimeLeaseHeartbeat({
        key: IDLE_BLOCK_DAILY_STATE_KEY,
        owner,
        ttlSeconds: IDLE_BLOCK_LEASE_TTL_SECONDS,
        onLost: () => { leaseLost = true; },
        onError: () => { leaseLost = true; },
      });

      await runWithCronMonitor(
        'contractor-pass-idle-block-daily',
        () => runDaily(now, owner, () => leaseLost),
        {
          schedule: { type: 'crontab', value: `0 ${IDLE_BLOCK_WINDOW_START_HOUR_MSK} * * *` },
          checkinMargin: 60,
          maxRuntime: 60,
        },
      );
    } catch (error) {
      // Сбой захвата или чтения состояния: пауза только в памяти процесса, процесс не роняем.
      cachedState = {
        lastCompletedYmdMsk: cachedState?.lastCompletedYmdMsk ?? null,
        nextRetryAt: new Date(Date.now() + IDLE_BLOCK_TICK_ERROR_BACKOFF_MS).toISOString(),
      };
      console.error('[pass-idle-block] ошибка тика:', error instanceof Error ? error.message : error);
      Sentry.captureException(error, { tags: { service: 'contractor-pass-idle-block', stage: 'tick' } });
    } finally {
      stopHeartbeat?.();
      if (acquired) {
        await releaseSigurRuntimeLease({ key: IDLE_BLOCK_DAILY_STATE_KEY, owner }).catch(error =>
          console.error('[pass-idle-block] не удалось отпустить lease:', error instanceof Error ? error.message : error),
        );
      }
      // Промис уже записан в runInFlight: до этой строки в теле всегда был await.
      runInFlight = null;
    }
  })();
  runInFlight = current;

  return current;
}

export async function startContractorPassIdleBlockScheduler(): Promise<void> {
  if (timer || startupTimeout) return;
  try {
    if (!(await sigurService.isConfigured())) {
      console.log('[pass-idle-block] Sigur not configured, skipping');
      return;
    }
  } catch (error) {
    console.error('[pass-idle-block] не удалось проверить настройки Sigur:', error instanceof Error ? error.message : error);
    return;
  }
  if (!isSigurRuntimeAllowed()) {
    logSigurRuntimeGuardSkip('contractor-pass-idle-block');
    return;
  }
  console.log('[pass-idle-block] started (tick: 60s, window 04:00–05:59 MSK, включается настройкой)');
  startupTimeout = setTimeout(() => {
    startupTimeout = null;
    void runIdleBlockTick();
  }, STARTUP_DELAY_MS);
  timer = setInterval(() => {
    void runIdleBlockTick();
  }, TICK_INTERVAL_MS);
}

export function stopContractorPassIdleBlockScheduler(): void {
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[pass-idle-block] stopped');
  }
}
