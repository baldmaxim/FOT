/**
 * Фоновый поллер pending-проверок newdb (РКЛ/патент).
 *
 * Провайдер обрабатывает запросы асинхронно (queued/in progress) — результат
 * забирается повторным POST с тем же requestId (бесплатно, is_repeat). Раньше
 * это была только ручная кнопка «Обновить»; теперь поллер добирает результаты
 * сам: тик каждые 60с + kick сразу после запуска проверки (провайдер обычно
 * успевает за десятки секунд).
 *
 * Хост-гейт (как у Sigur-джоб): работает только на прод-хабе. Гейт закрывает
 * и start, и kick — флаг started выставляется только после успешного guard,
 * kick без started — no-op (иначе локальный дев-бэкенд с read-only БД запускал
 * бы цикл через runChecksForPass).
 *
 * PM2 — один fork-инстанс: процессового флага processing достаточно, DB lease
 * не нужен (отдельная задача при переходе на cluster).
 */
import * as Sentry from '@sentry/node';
import { pollAllPending } from './newdb-check.service.js';
import { isSigurRuntimeAllowed, logSigurRuntimeGuardSkip } from './sigur-runtime-guard.service.js';

const TICK_INTERVAL_MS = 60_000;
const STARTUP_DELAY_MS = 30_000;
const KICK_DELAY_MS = 30_000;
const POLL_BATCH = 15;

let started = false;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let startupTimeout: ReturnType<typeof setTimeout> | null = null;
let kickTimeout: ReturnType<typeof setTimeout> | null = null;
let processing = false;

async function runCycle(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    const s = await pollAllPending(POLL_BATCH);
    const total = s.updated + s.stillPending + s.errors + s.skipped;
    if (total > 0) {
      console.log(`[newdb-poller] updated=${s.updated} stillPending=${s.stillPending} errors=${s.errors} skipped=${s.skipped}`);
    }
  } catch (error) {
    console.error('[newdb-poller] cycle error:', error instanceof Error ? error.message : error);
    Sentry.captureException(error, { tags: { service: 'newdb-pending-poller' } });
  } finally {
    processing = false;
  }
}

/**
 * Ускорить ближайший опрос (вызывается из runChecksForPass после появления
 * pending). Задержка KICK_DELAY_MS — даём провайдеру время обработать запрос.
 */
export function kickNewdbPendingPoller(): void {
  if (!started) return;
  if (kickTimeout) return;
  kickTimeout = setTimeout(() => {
    kickTimeout = null;
    void runCycle();
  }, KICK_DELAY_MS);
}

export function startNewdbPendingPoller(): void {
  if (started) return;
  if (!isSigurRuntimeAllowed()) {
    logSigurRuntimeGuardSkip('newdb-pending-poller');
    return;
  }
  started = true;

  console.log(`[newdb-poller] started (tick: ${TICK_INTERVAL_MS / 1000}s)`);
  startupTimeout = setTimeout(() => {
    startupTimeout = null;
    void runCycle();
  }, STARTUP_DELAY_MS);

  tickTimer = setInterval(() => {
    void runCycle();
  }, TICK_INTERVAL_MS);
}

export function stopNewdbPendingPoller(): void {
  started = false;
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
    console.log('[newdb-poller] stopped');
  }
}
