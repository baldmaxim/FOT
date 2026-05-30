/**
 * Фоновая досинхронизация отзыва пропусков подрядчика с Sigur.
 *
 * Контроллер revokePass теперь возвращает пропуск в пул МГНОВЕННО (в БД), а
 * тяжёлый перенос/блокировку профиля в Sigur (move + rename + block, каждый с
 * таймаутами и ретраями) делает этот шедулер по строкам
 * contractor_passes.sigur_sync_state='pending_revoke'.
 *
 * Тик каждые 25с + немедленный kick (debounce) сразу после enqueue, чтобы в
 * типичном случае Sigur подхватывал отзыв за ~секунду, а не за полминуты.
 */
import * as Sentry from '@sentry/node';
import {
  claimRevokeTasks,
  processRevokePass,
} from './contractor-pool.service.js';

const TICK_INTERVAL_MS = 25_000;
const STARTUP_DELAY_MS = 20_000;
const KICK_DEBOUNCE_MS = 500;

let tickTimer: ReturnType<typeof setInterval> | null = null;
let startupTimeout: ReturnType<typeof setTimeout> | null = null;
let kickTimeout: ReturnType<typeof setTimeout> | null = null;
let processing = false;
let pendingKick = false;

async function doOneCycle(): Promise<void> {
  const ids = await claimRevokeTasks();
  for (const id of ids) {
    try {
      await processRevokePass(id);
    } catch (error) {
      console.error(
        `[contractor-pass-sync] revoke sync failed for pass=${id}:`,
        error instanceof Error ? error.message : error,
      );
      Sentry.captureException(error, {
        tags: { service: 'contractor-pass-sync' },
        extra: { passId: id },
      });
    }
  }
}

async function runCycle(): Promise<void> {
  if (processing) {
    pendingKick = true;
    return;
  }
  processing = true;
  try {
    do {
      pendingKick = false;
      await doOneCycle();
    } while (pendingKick);
  } catch (error) {
    console.error('[contractor-pass-sync] cycle error:', error instanceof Error ? error.message : error);
    Sentry.captureException(error, { tags: { service: 'contractor-pass-sync', stage: 'cycle' } });
  } finally {
    processing = false;
  }
}

/** Немедленно (с дебаунсом) запустить досинхронизацию — вызывать после enqueueRevoke. */
export function kickContractorPassSync(): void {
  if (kickTimeout) return;
  kickTimeout = setTimeout(() => {
    kickTimeout = null;
    void runCycle();
  }, KICK_DEBOUNCE_MS);
}

export function startContractorPassSyncScheduler(): void {
  if (tickTimer || startupTimeout) return;

  console.log('[contractor-pass-sync] started (tick: 25s)');
  startupTimeout = setTimeout(() => {
    startupTimeout = null;
    void runCycle();
  }, STARTUP_DELAY_MS);

  tickTimer = setInterval(() => {
    void runCycle();
  }, TICK_INTERVAL_MS);
}

export function stopContractorPassSyncScheduler(): void {
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }
  if (kickTimeout) {
    clearTimeout(kickTimeout);
    kickTimeout = null;
  }
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
    console.log('[contractor-pass-sync] stopped');
  }
}
