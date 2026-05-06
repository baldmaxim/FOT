/**
 * Пересчёт skud_daily_summary для всех событий с employee_id.
 * Запуск: npx tsx src/scripts/recalc-daily-summaries.ts
 */
import { supabase } from '../src/config/database.js';

const BATCH = 200;

async function main() {
  console.log('[recalc] Загрузка уникальных (employee_id, event_date, organization_id)...');

  // Находим все уникальные пары employee_id + event_date из skud_events
  let lastId = 0;
  const pairsMap = new Map<string, { org_id: string; emp_id: number; date: string }>();
  let totalScanned = 0;

  while (true) {
    const { data: rows, error } = await supabase
      .from('skud_events')
      .select('id, employee_id, event_date, organization_id')
      .not('employee_id', 'is', null)
      .gt('id', lastId)
      .order('id')
      .limit(1000);

    if (error) {
      console.error('[recalc] Ошибка:', error.message);
      break;
    }
    if (!rows || rows.length === 0) break;

    totalScanned += rows.length;
    lastId = rows[rows.length - 1].id;

    for (const row of rows) {
      const key = `${row.employee_id}:${row.event_date}`;
      if (!pairsMap.has(key)) {
        pairsMap.set(key, {
          org_id: row.organization_id,
          emp_id: row.employee_id,
          date: row.event_date,
        });
      }
    }

    if (totalScanned % 10000 === 0) {
      console.log(`[recalc] Scanned: ${totalScanned} events, unique pairs: ${pairsMap.size}`);
    }

    if (rows.length < 1000) break;
  }

  const pairs = [...pairsMap.values()];
  console.log(`[recalc] Всего уникальных пар: ${pairs.length}`);

  // Вызываем batch_recalculate_skud_daily_summary пакетами
  let recalculated = 0;
  for (let i = 0; i < pairs.length; i += BATCH) {
    const batch = pairs.slice(i, i + BATCH);
    const { error } = await supabase.rpc('batch_recalculate_skud_daily_summary', { p_pairs: batch });
    if (error) {
      console.error(`[recalc] Ошибка на батче ${i}:`, error.message);
    } else {
      recalculated += batch.length;
    }
    if (recalculated % 1000 === 0 && recalculated > 0) {
      console.log(`[recalc] Пересчитано: ${recalculated}/${pairs.length}`);
    }
  }

  console.log(`[recalc] Готово. Пересчитано: ${recalculated}/${pairs.length}`);
  process.exit(0);
}
main();
