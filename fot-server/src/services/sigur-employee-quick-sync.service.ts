/**
 * Точечный синк сотрудников после правки карточки в разделе SIGUR портала.
 *
 * Зачем: правка отдела/должности в SIGUR пишет только в Sigur, а строка в employees
 * появлялась лишь плановым синком (раз в 30 мин) — кадровик ждал, чтобы назначить график.
 * Здесь та же логика syncEmployeesLogic, но по нескольким карточкам (GET /employees/:id)
 * без полной выгрузки и без рассылки structure_updated всем клиентам.
 *
 * Гарантии:
 * - серия правок схлопывается: debounce 15 с, но не дольше 60 с от первой постановки;
 * - повторная правка той же карточки во время прогона не теряется — запись снимается,
 *   только если её версия не менялась с момента снимка;
 * - занятый structure-sync lock и ошибки — повтор с backoff, а не потеря;
 *   после MAX_ATTEMPTS неудач одной версии карточку подхватит плановый синк;
 * - lock освобождается только если был взят.
 */
import * as Sentry from '@sentry/node';
import type { ConnectionType } from './sigur-base.service.js';
import {
  acquireStructureSyncSchedulerLock,
  releaseStructureSyncSchedulerLock,
} from './presence-polling.service.js';
import { syncEmployeesLogic, type TQuickSyncOutcome } from './sigur-sync-employees.service.js';
import { isSigurRuntimeAllowed, logSigurRuntimeGuardSkip } from './sigur-runtime-guard.service.js';

const DEBOUNCE_MS = 15_000;
const MAX_WAIT_MS = 60_000;
const RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000, 60_000];
const MAX_ATTEMPTS = 10;

/** Ключ очереди: подключение Sigur (undefined — подключение по умолчанию). */
type TConnectionKey = ConnectionType | 'default';

interface IQueuedCard {
  version: number;
  attempts: number;
  firstQueuedAt: number;
}

const queues = new Map<TConnectionKey, Map<number, IQueuedCard>>();
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let retryLevel = 0;
let versionSeq = 0;

const toKey = (connection?: ConnectionType): TConnectionKey => connection ?? 'default';
const fromKey = (key: TConnectionKey): ConnectionType | undefined => (key === 'default' ? undefined : key);

const hasQueued = (): boolean => [...queues.values()].some(q => q.size > 0);

const scheduleRun = (delayMs: number): void => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void runOnce();
  }, Math.max(0, delayMs));
  timer.unref?.();
};

/** Debounce от последней правки, но не позже MAX_WAIT_MS от самой старой постановки. */
const scheduleDebounced = (): void => {
  let oldest = Number.POSITIVE_INFINITY;
  for (const queue of queues.values()) {
    for (const card of queue.values()) oldest = Math.min(oldest, card.firstQueuedAt);
  }
  const now = Date.now();
  scheduleRun(Math.min(DEBOUNCE_MS, oldest + MAX_WAIT_MS - now));
};

const scheduleRetry = (): void => {
  const delay = RETRY_DELAYS_MS[Math.min(retryLevel, RETRY_DELAYS_MS.length - 1)];
  retryLevel++;
  console.log(`[quick-sync] retry in ${Math.round(delay / 1000)}s (level ${retryLevel})`);
  scheduleRun(delay);
};

/** Неудача одной версии карточки: счётчик, после MAX_ATTEMPTS — снимаем. */
const registerFailure = (queue: Map<number, IQueuedCard>, sigurId: number, version: number): void => {
  const card = queue.get(sigurId);
  if (!card || card.version !== version) return; // новая правка — счётчик уже сброшен
  card.attempts++;
  if (card.attempts >= MAX_ATTEMPTS) {
    queue.delete(sigurId);
    console.warn(`[quick-sync] card ${sigurId}: ${MAX_ATTEMPTS} failed attempts — left to the scheduled sync`);
  }
};

async function runOnce(): Promise<void> {
  if (inFlight) return;
  if (!hasQueued()) return;
  inFlight = true;

  let acquired = false;
  let needsRetry = false;

  try {
    await acquireStructureSyncSchedulerLock();
    acquired = true;

    for (const [key, queue] of queues) {
      if (queue.size === 0) continue;
      const snapshot = [...queue.entries()].map(([sigurId, card]) => ({ sigurId, version: card.version }));

      let outcomes: Map<number, TQuickSyncOutcome> | undefined;
      try {
        const result = await syncEmployeesLogic(fromKey(key), undefined, {}, true, {
          onlySigurIds: snapshot.map(s => s.sigurId),
        });
        outcomes = result.quick_outcomes;
      } catch (error) {
        needsRetry = true;
        console.error(`[quick-sync] batch failed (${key}):`, (error as Error).message);
        Sentry.captureException(error, { tags: { service: 'employee-quick-sync' } });
        for (const { sigurId, version } of snapshot) registerFailure(queue, sigurId, version);
        continue;
      }

      for (const { sigurId, version } of snapshot) {
        const outcome = outcomes?.get(sigurId) ?? 'retryable';
        const card = queue.get(sigurId);
        if (!card) continue;
        if (card.version !== version) continue; // правка во время прогона — следующим прогоном
        if (outcome === 'retryable') {
          needsRetry = true;
          registerFailure(queue, sigurId, version);
        } else {
          queue.delete(sigurId);
        }
      }
      console.log(
        `[quick-sync] ${key}: ${snapshot.length} card(s) — `
        + snapshot.map(s => `${s.sigurId}:${outcomes?.get(s.sigurId) ?? 'retryable'}`).join(', '),
      );
    }
  } catch (error) {
    // Чаще всего lock держит плановый/ручной синк — это не ошибка карточек, попытки не тратим.
    needsRetry = true;
    if ((error as { code?: string }).code === 'SYNC_IN_PROGRESS') {
      console.log(`[quick-sync] sync in progress, will retry: ${(error as Error).message}`);
    } else {
      console.error('[quick-sync] run failed:', (error as Error).message);
      Sentry.captureException(error, { tags: { service: 'employee-quick-sync' } });
    }
  } finally {
    if (acquired) {
      await releaseStructureSyncSchedulerLock().catch(releaseError => {
        console.error('[quick-sync] lock release error:', (releaseError as Error).message);
      });
    }
    inFlight = false;
  }

  if (!hasQueued()) {
    retryLevel = 0;
    return;
  }
  if (needsRetry) {
    scheduleRetry();
  } else {
    // Остались только правки, пришедшие во время прогона.
    retryLevel = 0;
    scheduleDebounced();
  }
}

/**
 * Поставить карточку Sigur в очередь точечного синка. Fire-and-forget: ничего не бросает,
 * вызывающий контроллер синка не ждёт.
 */
export function requestEmployeeQuickSync(sigurEmployeeId: number, connection?: ConnectionType): void {
  if (!Number.isInteger(sigurEmployeeId) || sigurEmployeeId <= 0) return;
  if (!isSigurRuntimeAllowed()) {
    logSigurRuntimeGuardSkip('employee-quick-sync');
    return;
  }

  const key = toKey(connection);
  let queue = queues.get(key);
  if (!queue) {
    queue = new Map();
    queues.set(key, queue);
  }
  const existing = queue.get(sigurEmployeeId);
  versionSeq++;
  if (existing) {
    // Новая правка: новая версия и свежий счётчик неудач.
    existing.version = versionSeq;
    existing.attempts = 0;
  } else {
    queue.set(sigurEmployeeId, { version: versionSeq, attempts: 0, firstQueuedAt: Date.now() });
  }

  // Во время прогона только копим: хвост прогона сам назначит следующий.
  if (inFlight) return;
  retryLevel = 0;
  scheduleDebounced();
}

export function __resetEmployeeQuickSyncForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  queues.clear();
  inFlight = false;
  retryLevel = 0;
  versionSeq = 0;
}

export function __getEmployeeQuickSyncQueueForTests(connection?: ConnectionType): Map<number, IQueuedCard> | undefined {
  return queues.get(toKey(connection));
}
