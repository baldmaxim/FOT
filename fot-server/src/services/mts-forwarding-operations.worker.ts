import * as Sentry from '@sentry/node';
import { queryOne } from '../config/postgres.js';
import { getSigurRuntimeOwner } from './sigur-runtime-state.service.js';
import { mtsForwardingOperationsService as ops } from './mts-forwarding-operations.service.js';
import { processOperation } from './mts-forwarding-operations.runner.js';

// Фоновое продолжение операций переадресации «Моя SIM»: подключение PE0250 →
// правило → подтверждение. Не зависит от открытого окна и не проходит
// пользовательский лимит запросов.
//
// Два процесса PM2 не мешают друг другу: работа закрепляется арендой строк
// (claimDue — UPDATE … FOR UPDATE SKIP LOCKED), каждая внешняя мутация — отдельный
// атомарный claimSend. Глобальный lease не нужен.

const TICK_MS = 30_000;
const STARTUP_DELAY_MS = 40_000;
const BATCH = 10;
// Аренда шага: самый долгий шаг — отправка (своя аренда 6 мин в claimSend) либо чтения по 20 с.
const STEP_LEASE_SECONDS = 180;

let timer: NodeJS.Timeout | null = null;
let running = false;
let stopped = false;

export const runForwardingOperationsTick = async (owner: string): Promise<{ recovered: number; processed: number }> => {
  const recovered = await ops.recoverStale();
  const due = await ops.claimDue(owner, BATCH, STEP_LEASE_SECONDS);
  let processed = 0;
  for (const op of due) {
    if (stopped) break;
    try {
      await processOperation(op, owner);
      processed++;
    } catch (error) {
      // Строка остаётся с арендой до истечения — следующий тик возьмёт её снова.
      console.error(`[mts-fwd-op] шаг операции упал: ${error instanceof Error ? error.message : 'unknown'}`);
      Sentry.captureException(error, { tags: { module: 'mts-business', kind: 'forwarding-operation-worker' } });
    }
  }
  return { recovered, processed };
};

const tick = async (owner: string): Promise<void> => {
  if (running || stopped) return;
  running = true;
  try {
    // Таблицы ещё нет (миграция 276 не применена) или пусто — тихо выходим.
    const pending = await queryOne<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM mts_forwarding_operations
        WHERE state NOT IN ('done', 'failed', 'cancelled', 'expired')`,
    ).catch(() => null);
    if (!pending || Number(pending.n) === 0) return;

    const { recovered, processed } = await runForwardingOperationsTick(owner);
    if (recovered || processed) {
      console.log(`[mts-fwd-op] tick: recovered=${recovered} processed=${processed}`);
    }
  } catch (error) {
    console.error('[mts-fwd-op] tick failed:', error instanceof Error ? error.message : 'unknown');
    Sentry.captureException(error, { tags: { module: 'mts-business', kind: 'forwarding-operation-worker' } });
  } finally {
    running = false;
  }
};

export function startMtsForwardingOperationsWorker(): void {
  if (timer) return;
  stopped = false;
  const owner = getSigurRuntimeOwner('mts_forwarding_operations');
  console.log(`[mts-fwd-op] starting (interval=${TICK_MS / 1000}s, owner=${owner})`);
  setTimeout(() => { void tick(owner); }, STARTUP_DELAY_MS);
  timer = setInterval(() => { void tick(owner); }, TICK_MS);
}

export function stopMtsForwardingOperationsWorker(): void {
  stopped = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
