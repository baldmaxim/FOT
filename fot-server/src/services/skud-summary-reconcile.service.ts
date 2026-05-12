import * as Sentry from '@sentry/node';
import { query } from '../config/postgres.js';

/**
 * Фоновая страховка от «осиротевших» событий — записей в skud_events,
 * для которых нет соответствующей строки в skud_daily_summary.
 *
 * Корневой Bug A: presence-polling.service.ts вызывает recalc-RPC только для
 * событий, реально вставленных текущим тиком (ignoreDuplicates=true). Если
 * recalc упал транзиентно после успешного upsert — на следующих тиках события
 * видятся как дубликаты и пересчёт никогда больше не вызывается.
 *
 * Шаг 3a исправляет polling, чтобы recalc вызывался по batch, а не по
 * insertedRows. Этот сервис — вторая линия защиты: страхует от любых других
 * путей вставки событий (skud-import, sigur-sync-events, ручной SQL-патчинг)
 * и от gap-ов, оставшихся в БД до фикса polling.
 *
 * Тик каждые 15 минут, окно — последние 7 дней. Найденные пары пересчитываются
 * через batch_recalculate_skud_daily_summary батчами по 200. Sentry warning,
 * если пар > 0 — повторное срабатывание сигналит, что polling всё ещё теряет.
 */
const RECONCILE_INTERVAL_MS = 15 * 60_000;
const STARTUP_DELAY_MS = 90_000;
const LOOKBACK_DAYS = 7;
const PAGE_SIZE = 5000;
const RPC_BATCH = 200;

let timer: ReturnType<typeof setInterval> | null = null;
let startupTimeout: ReturnType<typeof setTimeout> | null = null;
let runInFlight: Promise<void> | null = null;

async function collectOrphanPairs(cutoff: string): Promise<Array<{ emp_id: number; date: string }>> {
  const eventPairs = new Set<string>();
  let from = 0;
  // Пагинация по skud_events: тянем сырой select и уникализуем в памяти.
  /* eslint-disable no-await-in-loop */
  while (true) {
    const rows = await query<{ employee_id: number | null; event_date: string | null }>(
      `SELECT employee_id, event_date FROM skud_events
       WHERE event_date >= $1 AND employee_id IS NOT NULL
       ORDER BY id ASC
       LIMIT ${PAGE_SIZE} OFFSET ${from}`,
      [cutoff],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const empId = row.employee_id;
      const date = row.event_date;
      if (empId == null || !date) continue;
      eventPairs.add(`${empId}:${date}`);
    }
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  const summaryPairs = new Set<string>();
  let sFrom = 0;
  while (true) {
    const rows = await query<{ employee_id: number | null; date: string | null }>(
      `SELECT employee_id, date FROM skud_daily_summary
       WHERE date >= $1
       ORDER BY date ASC
       LIMIT ${PAGE_SIZE} OFFSET ${sFrom}`,
      [cutoff],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const empId = row.employee_id;
      const date = row.date;
      if (empId == null || !date) continue;
      summaryPairs.add(`${empId}:${date}`);
    }
    if (rows.length < PAGE_SIZE) break;
    sFrom += PAGE_SIZE;
  }
  /* eslint-enable no-await-in-loop */

  const orphans: Array<{ emp_id: number; date: string }> = [];
  for (const key of eventPairs) {
    if (summaryPairs.has(key)) continue;
    const [emp, date] = key.split(':');
    orphans.push({ emp_id: Number(emp), date });
  }
  return orphans;
}

async function runReconcileCycle(): Promise<void> {
  if (runInFlight) return;

  runInFlight = (async () => {
    const startedAt = Date.now();
    try {
      const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);

      const pairs = await collectOrphanPairs(cutoff);
      if (pairs.length === 0) {
        return;
      }

      let processed = 0;
      let failedChunks = 0;
      for (let i = 0; i < pairs.length; i += RPC_BATCH) {
        const chunk = pairs.slice(i, i + RPC_BATCH);
        try {
          await query(
            'SELECT public.batch_recalculate_skud_daily_summary($1::jsonb)',
            [JSON.stringify(chunk)],
          );
          processed += chunk.length;
        } catch (err) {
          failedChunks += 1;
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[skud-summary-reconcile] чанк ${i}-${i + chunk.length} упал:`, message);
          continue;
        }
      }

      const durationMs = Date.now() - startedAt;
      console.warn(`[skud-summary-reconcile] восстановлено ${processed}/${pairs.length} пар за ${durationMs}ms (failed chunks: ${failedChunks})`);

      // Регулярные срабатывания = polling всё ещё теряет события. Помечаем warning,
      // чтобы это было заметно в Sentry, но без алёрт-эскалации.
      Sentry.captureMessage('skud-summary-reconcile recovered orphan summaries', {
        level: 'warning',
        tags: { reason: 'summary_orphan' },
        extra: {
          orphanPairs: pairs.length,
          processed,
          failedChunks,
          lookbackDays: LOOKBACK_DAYS,
          durationMs,
        },
      });
    } catch (error) {
      console.error('[skud-summary-reconcile] error:', error instanceof Error ? error.message : error);
      Sentry.captureException(error, { tags: { source: 'skud-summary-reconcile' } });
    } finally {
      runInFlight = null;
    }
  })();

  return runInFlight;
}

export function startSkudSummaryReconcileScheduler(): void {
  if (timer || startupTimeout) return;

  console.log('[skud-summary-reconcile] started (interval: 15m, lookback: 7d)');
  startupTimeout = setTimeout(() => {
    startupTimeout = null;
    void runReconcileCycle();
  }, STARTUP_DELAY_MS);

  timer = setInterval(() => {
    void runReconcileCycle();
  }, RECONCILE_INTERVAL_MS);
}

export function stopSkudSummaryReconcileScheduler(): void {
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[skud-summary-reconcile] stopped');
  }
}
