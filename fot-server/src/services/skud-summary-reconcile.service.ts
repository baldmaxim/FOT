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

// Часть пар (emp,date) штатно НИКОГДА не получает summary
// (batch_recalculate_skud_daily_summary не создаёт строку для уволенных /
// без графика / без смены). Раньше они переоткрывались каждые 15 мин как
// «сироты» → вечный recalc + ~138 warning в Sentry на цикл (FOT-SERVER-D).
// Если после recalc строки в summary так и нет — пара «невосстановима»,
// кешируем и больше не считаем сиротой/не пересчитываем. Ключи протухают
// по дате (за пределами lookback) — ретроактивные правки графика
// подхватятся после рестарта или выпадения из окна.
const stableNoSummary = new Set<string>();
// Реальная потеря событий (recalc что-то восстановил) — сигнал, но без
// спама: не чаще раза в 6ч.
const ALERT_THROTTLE_MS = 6 * 60 * 60_000;
let lastAlertAt = 0;

const pairKey = (empId: number, date: string): string => `${empId}:${date}`;

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

  // Протухание: ключи вне lookback-окна больше не запрашиваются — убираем,
  // чтобы set не рос бесконечно и пары переоценивались при возврате в окно.
  for (const key of stableNoSummary) {
    const keyDate = key.slice(key.indexOf(':') + 1);
    if (keyDate < cutoff) stableNoSummary.delete(key);
  }

  const orphans: Array<{ emp_id: number; date: string }> = [];
  for (const key of eventPairs) {
    if (summaryPairs.has(key)) continue;
    if (stableNoSummary.has(key)) continue; // штатно без summary — не сирота
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

      const processedPairs: Array<{ emp_id: number; date: string }> = [];
      let failedChunks = 0;
      for (let i = 0; i < pairs.length; i += RPC_BATCH) {
        const chunk = pairs.slice(i, i + RPC_BATCH);
        try {
          await query(
            'SELECT public.batch_recalculate_skud_daily_summary($1::jsonb)',
            [JSON.stringify(chunk)],
          );
          processedPairs.push(...chunk);
        } catch (err) {
          failedChunks += 1;
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[skud-summary-reconcile] чанк ${i}-${i + chunk.length} упал:`, message);
          continue;
        }
      }

      // Целевая перепроверка: для каких обработанных пар summary реально
      // появилась. Те, где строки так и нет, — штатно «невосстановимы»
      // (уволенные / без графика / без смены): кешируем, чтобы не считать
      // сиротой и не пересчитывать каждые 15 мин (корень FOT-SERVER-D).
      let recovered = 0;
      let stillMissing = 0;
      if (processedPairs.length > 0) {
        const empIds = processedPairs.map(p => p.emp_id);
        const dates = processedPairs.map(p => p.date);
        const presentRows = await query<{ employee_id: number; date: string }>(
          `SELECT employee_id, date FROM skud_daily_summary
            WHERE (employee_id, date) IN (
              SELECT e, d FROM unnest($1::int[], $2::date[]) AS t(e, d)
            )`,
          [empIds, dates],
        );
        const present = new Set(presentRows.map(r => pairKey(r.employee_id, r.date)));
        for (const p of processedPairs) {
          const key = pairKey(p.emp_id, p.date);
          if (present.has(key)) recovered += 1;
          else { stillMissing += 1; stableNoSummary.add(key); }
        }
      }

      const durationMs = Date.now() - startedAt;
      console.warn(
        `[skud-summary-reconcile] orphan=${pairs.length} recovered=${recovered} ` +
        `noSummary=${stillMissing} failedChunks=${failedChunks} за ${durationMs}ms ` +
        `(stableCache=${stableNoSummary.size})`,
      );

      // Шум убран: warning в Sentry ТОЛЬКО при реальном сбое (failedChunks>0)
      // или реальной потере событий (recalc что-то восстановил), и не чаще
      // раза в ALERT_THROTTLE_MS. «Невосстановимые» пары больше не шумят.
      const realLoss = recovered > 0;
      const now = Date.now();
      if (failedChunks > 0 || (realLoss && now - lastAlertAt >= ALERT_THROTTLE_MS)) {
        if (!failedChunks) lastAlertAt = now;
        Sentry.captureMessage('skud-summary-reconcile recovered orphan summaries', {
          level: 'warning',
          tags: { reason: failedChunks > 0 ? 'recalc_failed' : 'summary_orphan' },
          extra: {
            orphanPairs: pairs.length,
            recovered,
            stillMissing,
            failedChunks,
            lookbackDays: LOOKBACK_DAYS,
            durationMs,
          },
        });
      }
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
