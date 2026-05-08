/**
 * Одноразовый скрипт: восстанавливает недостающие строки в skud_daily_summary
 * для (employee_id, event_date), у которых есть события в skud_events,
 * но нет соответствующей записи в skud_daily_summary.
 *
 * Причина пропусков (Bug A): presence-polling.service.ts при upsert событий с
 * ignoreDuplicates=true получает в .select() только новые строки. Если RPC
 * пересчёта summary падает транзиентно, на следующем тике события уже видятся
 * как дубликаты и recalc для них больше не вызывается. Кейс из прода:
 * Фетисова А. А. (id=2502) на 2026-05-04 — события есть, summary нет, табель «Н».
 *
 * Запуск: cd fot-server && npx tsx scripts/backfill-orphan-skud-summaries.ts [--days=60]
 * Идемпотентен — RPC batch_recalculate_skud_daily_summary пересчитывает с нуля и UPSERT-ит.
 */
import { supabase } from '../src/config/database.js';

const DEFAULT_DAYS = 60;
const RPC_BATCH = 200;
const PAGE = 5000;

const parseDays = (): number => {
  const arg = process.argv.find(item => item.startsWith('--days='));
  if (!arg) return DEFAULT_DAYS;
  const value = Number(arg.slice('--days='.length));
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`[backfill] некорректный --days=${arg}, использую ${DEFAULT_DAYS}`);
    return DEFAULT_DAYS;
  }
  return Math.floor(value);
};

async function collectOrphanPairs(cutoff: string): Promise<Array<{ emp_id: number; date: string }>> {
  const eventPairs = new Set<string>();
  let from = 0;
  while (true) {
    const { data: rows, error } = await supabase
      .from('skud_events')
      .select('employee_id, event_date')
      .gte('event_date', cutoff)
      .not('employee_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!rows || rows.length === 0) break;
    for (const row of rows) {
      const empId = (row as { employee_id: number | null }).employee_id;
      const date = (row as { event_date: string | null }).event_date;
      if (empId == null || !date) continue;
      eventPairs.add(`${empId}:${date}`);
    }
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  console.log(`[backfill] уникальных пар в skud_events за период: ${eventPairs.size}`);

  const summaryPairs = new Set<string>();
  let sFrom = 0;
  while (true) {
    const { data: rows, error } = await supabase
      .from('skud_daily_summary')
      .select('employee_id, date')
      .gte('date', cutoff)
      .order('date', { ascending: true })
      .range(sFrom, sFrom + PAGE - 1);
    if (error) throw error;
    if (!rows || rows.length === 0) break;
    for (const row of rows) {
      const empId = (row as { employee_id: number | null }).employee_id;
      const date = (row as { date: string | null }).date;
      if (empId == null || !date) continue;
      summaryPairs.add(`${empId}:${date}`);
    }
    if (rows.length < PAGE) break;
    sFrom += PAGE;
  }
  console.log(`[backfill] уникальных пар в skud_daily_summary за период: ${summaryPairs.size}`);

  const orphans: Array<{ emp_id: number; date: string }> = [];
  for (const key of eventPairs) {
    if (summaryPairs.has(key)) continue;
    const [emp, date] = key.split(':');
    orphans.push({ emp_id: Number(emp), date });
  }
  orphans.sort((a, b) => a.emp_id - b.emp_id || a.date.localeCompare(b.date));
  return orphans;
}

const main = async (): Promise<void> => {
  const days = parseDays();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  console.log(`[backfill] ищу события без summary за период с ${cutoff}`);

  const pairs = await collectOrphanPairs(cutoff);
  console.log(`[backfill] найдено пар (employee_id, date) без summary: ${pairs.length}`);
  if (pairs.length === 0) {
    console.log('[backfill] нечего пересчитывать, выхожу.');
    return;
  }

  let processed = 0;
  let failedChunks = 0;
  for (let i = 0; i < pairs.length; i += RPC_BATCH) {
    const chunk = pairs.slice(i, i + RPC_BATCH);
    const { error: rpcErr } = await supabase.rpc('batch_recalculate_skud_daily_summary', { p_pairs: chunk });
    if (rpcErr) {
      console.error(`[backfill] чанк ${i}-${i + chunk.length} упал:`, rpcErr.message);
      failedChunks += 1;
      continue;
    }
    processed += chunk.length;
    console.log(`[backfill] обработано ${processed}/${pairs.length}`);
  }

  console.log(`[backfill] готово: пересчитано ${processed}/${pairs.length}, упавших чанков: ${failedChunks}`);
};

main().catch(err => {
  console.error('[backfill] фатальная ошибка:', err);
  process.exit(1);
});
