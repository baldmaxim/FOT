/**
 * Бэкфилл employee_id для всех событий без привязки.
 * Учитывает organization_id для корректного маппинга при дубликатах ФИО.
 * Запуск: npx tsx src/scripts/backfill-employee-ids.ts
 */
import { supabase } from '../config/database.js';

const BATCH = 1000;
const CONCURRENCY = 50;

async function main() {
  // 1. Загружаем всех сотрудников → маппинг "name|org_id" → employee_id
  console.log('[backfill-emp] Загрузка сотрудников...');
  const { data: employees } = await supabase
    .from('employees')
    .select('id, full_name, organization_id')
    .eq('is_archived', false);

  // Ключ: "name|org_id" → employee_id (точное совпадение по организации)
  const empByNameOrg = new Map<string, number>();
  for (const emp of employees || []) {
    const name = (emp.full_name || '').toLowerCase().trim();
    const key = `${name}|${emp.organization_id}`;
    if (!empByNameOrg.has(key)) {
      empByNameOrg.set(key, emp.id);
    }
  }
  console.log(`[backfill-emp] Записей name|org: ${empByNameOrg.size}`);

  // 2. Сканируем события без employee_id
  let lastId = 0;
  let totalScanned = 0;
  let totalUpdated = 0;
  // Множество пар (emp_id, date), у которых нужно пересчитать skud_daily_summary —
  // иначе сводка останется пустой ('first_entry IS NULL'), даже если в skud_events уже есть привязка.
  const summariesToUpdate = new Set<string>();

  while (true) {
    const { data: rows, error } = await supabase
      .from('skud_events')
      .select('id, physical_person, organization_id, event_date')
      .is('employee_id', null)
      .gt('id', lastId)
      .order('id')
      .limit(BATCH);

    if (error) {
      console.error('[backfill-emp] Ошибка:', error.message);
      break;
    }
    if (!rows || rows.length === 0) break;

    totalScanned += rows.length;
    lastId = rows[rows.length - 1].id;

    const updates: { id: number; employee_id: number; event_date: string }[] = [];
    for (const row of rows) {
      const name = (row.physical_person || '').toLowerCase().trim();
      const key = `${name}|${row.organization_id}`;
      const empId = empByNameOrg.get(key);
      if (empId) {
        updates.push({ id: row.id, employee_id: empId, event_date: row.event_date });
      }
    }

    if (updates.length > 0) {
      for (let i = 0; i < updates.length; i += CONCURRENCY) {
        const chunk = updates.slice(i, i + CONCURRENCY);
        await Promise.all(
          chunk.map(u => supabase.from('skud_events').update({ employee_id: u.employee_id }).eq('id', u.id))
        );
      }
      for (const u of updates) {
        summariesToUpdate.add(`${u.employee_id}:${u.event_date}`);
      }
      totalUpdated += updates.length;
    }

    if (totalScanned % 10000 === 0) {
      console.log(`[backfill-emp] Scanned: ${totalScanned} | Updated: ${totalUpdated} | lastId: ${lastId}`);
    }

    if (rows.length < BATCH) break;
  }

  // 3. Пересчёт skud_daily_summary для всех пар, где была обновлена привязка employee_id.
  if (summariesToUpdate.size > 0) {
    console.log(`[backfill-emp] Пересчёт ${summariesToUpdate.size} сводок...`);
    const pairs = [...summariesToUpdate].map(key => {
      const [empId, date] = key.split(':');
      return {
        org_id: '00000000-0000-0000-0000-000000000000',
        emp_id: parseInt(empId, 10),
        date,
      };
    });
    const RECALC_BATCH = 200;
    let recalculated = 0;
    for (let i = 0; i < pairs.length; i += RECALC_BATCH) {
      const chunk = pairs.slice(i, i + RECALC_BATCH);
      const { error } = await supabase.rpc('batch_recalculate_skud_daily_summary', { p_pairs: chunk });
      if (error) {
        console.error(`[backfill-emp] Ошибка пересчёта на батче ${i}:`, error.message);
      } else {
        recalculated += chunk.length;
      }
    }
    console.log(`[backfill-emp] Пересчитано: ${recalculated}/${pairs.length}`);
  }

  console.log(`[backfill-emp] Готово. Scanned: ${totalScanned} | Updated: ${totalUpdated}`);
  process.exit(0);
}
main();
