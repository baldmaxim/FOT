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
import { SigurCardLeaseBusyError } from './sigur-card-lease.service.js';
import {
  runContractorPassExpirySync,
  summarizePassExpirySync,
} from './contractor-pass-expiry-sync.service.js';

/**
 * Ночная синхронизация «Срока» подрядных пропусков с Sigur — раз в сутки.
 *
 * Окно 01:00–05:59 МСК: после дневного деплоя прогон будет только ночью — днём остаётся
 * время на пробный запуск CLI, а lock записи карт не мешает сайдбару SIGUR в рабочее время.
 *
 * Суточный захват — runtime lease contractor_pass_expiry_daily (рестарт, наложение
 * процессов). День засчитан после completed или blocked (предохранитель); partial или
 * ошибка — повтор не раньше чем через час (nextRetryAt хранится в БД и переживает
 * рестарт); занятый lock карт — отложено до следующего тика без паузы.
 */
const TICK_INTERVAL_MS = 60_000;
const STARTUP_DELAY_MS = 60_000;
const DAILY_STATE_KEY = 'contractor_pass_expiry_daily';
const DAILY_LEASE_TTL_SECONDS = 600;

export const PASS_EXPIRY_WINDOW_START_HOUR_MSK = 1;
/** Час МСК, с которого окно уже закрыто. */
export const PASS_EXPIRY_WINDOW_END_HOUR_MSK = 6;
/** Повтор после partial или ошибки: полный прогон читает все профили Sigur, чаще нельзя. */
export const PASS_EXPIRY_RETRY_AFTER_FAILURE_MS = 60 * 60_000;
/** Пауза после сбоя самого тика (захват lease, БД): не слать ошибку в Sentry каждую минуту. */
export const PASS_EXPIRY_TICK_ERROR_BACKOFF_MS = 15 * 60_000;

export interface IPassExpirySchedulerState {
  lastCompletedYmdMsk: string | null;
  nextRetryAt: string | null;
}

let timer: ReturnType<typeof setInterval> | null = null;
let startupTimeout: ReturnType<typeof setTimeout> | null = null;
let runInFlight: Promise<void> | null = null;
/** Кэш суточного состояния — экономит обращение к БД на каждом тике. Авторитетно — под lease. */
let cachedState: IPassExpirySchedulerState | null = null;

/** Для тестов: забыть кэш суточного состояния. */
export function resetPassExpirySchedulerState(): void {
  cachedState = null;
}

const moscowHour = (now: Date): number =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', hour12: false }).format(now)) % 24;

/** Пора ли прогонять. Чистая функция — решение планировщика покрыто тестами. */
export function shouldRunPassExpirySync(state: IPassExpirySchedulerState | null, now: Date): boolean {
  const hour = moscowHour(now);
  if (hour < PASS_EXPIRY_WINDOW_START_HOUR_MSK || hour >= PASS_EXPIRY_WINDOW_END_HOUR_MSK) return false;
  if (state?.lastCompletedYmdMsk === moscowTodayIso(now)) return false;
  if (state?.nextRetryAt) {
    const retryAtMs = Date.parse(state.nextRetryAt);
    if (Number.isFinite(retryAtMs) && now.getTime() < retryAtMs) return false;
  }
  return true;
}

const readState = (meta: Record<string, unknown> | null | undefined): IPassExpirySchedulerState => ({
  lastCompletedYmdMsk: typeof meta?.lastCompletedYmdMsk === 'string' ? meta.lastCompletedYmdMsk : null,
  nextRetryAt: typeof meta?.nextRetryAt === 'string' ? meta.nextRetryAt : null,
});

/** Запись под owner: если lease уже у другого процесса, merge отвергается — его состояние главнее. */
async function saveState(owner: string, meta: Record<string, unknown>): Promise<void> {
  try {
    const row = await mergeSigurRuntimeState({ key: DAILY_STATE_KEY, owner, meta });
    if (!row) console.warn('[pass-expiry-sync] состояние не сохранено: суточный lease у другого процесса');
  } catch (error) {
    console.error('[pass-expiry-sync] не удалось сохранить состояние:', error instanceof Error ? error.message : error);
  }
}

async function runDailySync(now: Date, owner: string, isLeaseLost: () => boolean): Promise<CronRunStatus> {
  const ymd = moscowTodayIso(now);
  const attemptAt = new Date().toISOString();
  try {
    const result = await runContractorPassExpirySync({
      dryRun: false,
      triggeredBy: 'scheduler',
      shouldAbort: isLeaseLost,
    });

    if (result.status === 'partial') {
      const nextRetryAt = new Date(Date.now() + PASS_EXPIRY_RETRY_AFTER_FAILURE_MS).toISOString();
      cachedState = { lastCompletedYmdMsk: cachedState?.lastCompletedYmdMsk ?? null, nextRetryAt };
      await saveState(owner, { lastAttemptAt: attemptAt, lastResult: summarizePassExpirySync(result), nextRetryAt });
      return 'error';
    }

    // completed или blocked: день засчитан — иначе blocked слал бы одно и то же каждый час.
    cachedState = { lastCompletedYmdMsk: ymd, nextRetryAt: null };
    await saveState(owner, {
      lastAttemptAt: attemptAt,
      lastCompletedYmdMsk: ymd,
      lastSuccessAt: new Date().toISOString(),
      lastResult: summarizePassExpirySync(result),
      nextRetryAt: null,
      lastError: null,
    });
    return result.status === 'completed' ? 'ok' : 'error';
  } catch (error) {
    if (error instanceof SigurCardLeaseBusyError) {
      // Идёт массовое продление или сохранение в сайдбаре — не ошибка, повтор следующим тиком.
      console.log('[pass-expiry-sync] отложено: идёт другая операция с картами Sigur');
      await saveState(owner, { lastAttemptAt: attemptAt, lastDeferredAt: attemptAt });
      return 'ok';
    }
    const nextRetryAt = new Date(Date.now() + PASS_EXPIRY_RETRY_AFTER_FAILURE_MS).toISOString();
    cachedState = { lastCompletedYmdMsk: cachedState?.lastCompletedYmdMsk ?? null, nextRetryAt };
    console.error('[pass-expiry-sync] ошибка прогона:', error instanceof Error ? error.message : error);
    Sentry.captureException(error, { tags: { service: 'contractor-pass-expiry-sync' } });
    await saveState(owner, {
      lastAttemptAt: attemptAt,
      lastFailureAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error),
      nextRetryAt,
    });
    return 'error';
  }
}

export async function runPassExpirySyncTick(now: Date = new Date()): Promise<void> {
  if (runInFlight) return runInFlight;
  if (!shouldRunPassExpirySync(cachedState, now)) return;

  const owner = getSigurRuntimeOwner('contractor-pass-expiry');
  const current: Promise<void> = (async () => {
    let acquired = false;
    let leaseLost = false;
    let stopHeartbeat: (() => void) | null = null;
    try {
      const lease = await tryAcquireSigurRuntimeLease({
        key: DAILY_STATE_KEY,
        owner,
        ttlSeconds: DAILY_LEASE_TTL_SECONDS,
      });
      // Не захватили — прогон ведёт другой процесс.
      if (!lease.acquired) return;
      acquired = true;

      // Авторитетная проверка — по состоянию, вернувшемуся вместе с lease.
      const state = readState(lease.row?.meta);
      cachedState = state;
      if (!shouldRunPassExpirySync(state, now)) return;

      stopHeartbeat = startSigurRuntimeLeaseHeartbeat({
        key: DAILY_STATE_KEY,
        owner,
        ttlSeconds: DAILY_LEASE_TTL_SECONDS,
        onLost: () => { leaseLost = true; },
        onError: () => { leaseLost = true; },
      });

      await runWithCronMonitor(
        'contractor-pass-expiry-daily',
        () => runDailySync(now, owner, () => leaseLost),
        {
          schedule: { type: 'crontab', value: `0 ${PASS_EXPIRY_WINDOW_START_HOUR_MSK} * * *` },
          checkinMargin: 60,
          maxRuntime: 60,
        },
      );
    } catch (error) {
      // Сбой захвата или чтения состояния: пауза только в памяти процесса, процесс не роняем.
      cachedState = {
        lastCompletedYmdMsk: cachedState?.lastCompletedYmdMsk ?? null,
        nextRetryAt: new Date(Date.now() + PASS_EXPIRY_TICK_ERROR_BACKOFF_MS).toISOString(),
      };
      console.error('[pass-expiry-sync] ошибка тика:', error instanceof Error ? error.message : error);
      Sentry.captureException(error, { tags: { service: 'contractor-pass-expiry-sync', stage: 'tick' } });
    } finally {
      stopHeartbeat?.();
      if (acquired) {
        await releaseSigurRuntimeLease({ key: DAILY_STATE_KEY, owner }).catch(error =>
          console.error('[pass-expiry-sync] не удалось отпустить lease:', error instanceof Error ? error.message : error),
        );
      }
      // Промис уже записан в runInFlight: до этой строки в теле всегда был await.
      runInFlight = null;
    }
  })();
  runInFlight = current;

  return current;
}

export async function startContractorPassExpirySyncScheduler(): Promise<void> {
  if (timer || startupTimeout) return;
  try {
    if (!(await sigurService.isConfigured())) {
      console.log('[pass-expiry-sync] Sigur not configured, skipping');
      return;
    }
  } catch (error) {
    console.error('[pass-expiry-sync] не удалось проверить настройки Sigur:', error instanceof Error ? error.message : error);
    return;
  }
  if (!isSigurRuntimeAllowed()) {
    logSigurRuntimeGuardSkip('contractor-pass-expiry-sync');
    return;
  }
  console.log('[pass-expiry-sync] started (tick: 60s, window 01:00–05:59 MSK)');
  startupTimeout = setTimeout(() => {
    startupTimeout = null;
    void runPassExpirySyncTick();
  }, STARTUP_DELAY_MS);
  timer = setInterval(() => {
    void runPassExpirySyncTick();
  }, TICK_INTERVAL_MS);
}

export function stopContractorPassExpirySyncScheduler(): void {
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[pass-expiry-sync] stopped');
  }
}
