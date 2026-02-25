/**
 * Бэкфилл employee_id для всех событий без привязки.
 * Запуск: npx tsx src/scripts/backfill-employee-ids.ts
 */
import { supabase } from '../config/database.js';
import { encryptionService } from '../services/encryption.service.js';

const BATCH = 1000;
const CONCURRENCY = 50;

async function main() {
  // 1. Загружаем всех сотрудников → маппинг name → employee_id
  console.log('[backfill-emp] Загрузка сотрудников...');
  const { data: employees } = await supabase
    .from('employees')
    .select('id, full_name_encrypted')
    .eq('is_archived', false);

  const employeeMap = new Map<string, number>();
  for (const emp of employees || []) {
    const name = encryptionService.decrypt(emp.full_name_encrypted).toLowerCase().trim();
    if (!employeeMap.has(name)) {
      employeeMap.set(name, emp.id);
    }
  }
  console.log(`[backfill-emp] Сотрудников: ${employeeMap.size}`);

  // 2. Сканируем события без employee_id, курсор по id
  let lastId = 0;
  let totalScanned = 0;
  let totalUpdated = 0;

  while (true) {
    const { data: rows, error } = await supabase
      .from('skud_events')
      .select('id, physical_person_encrypted')
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

    const updates: { id: number; employee_id: number }[] = [];
    for (const row of rows) {
      const name = encryptionService.decrypt(row.physical_person_encrypted).toLowerCase().trim();
      const empId = employeeMap.get(name);
      if (empId) {
        updates.push({ id: row.id, employee_id: empId });
      }
    }

    if (updates.length > 0) {
      for (let i = 0; i < updates.length; i += CONCURRENCY) {
        const chunk = updates.slice(i, i + CONCURRENCY);
        await Promise.all(
          chunk.map(u => supabase.from('skud_events').update({ employee_id: u.employee_id }).eq('id', u.id))
        );
      }
      totalUpdated += updates.length;
    }

    if (totalScanned % 10000 === 0) {
      console.log(`[backfill-emp] Scanned: ${totalScanned} | Updated: ${totalUpdated} | lastId: ${lastId}`);
    }

    if (rows.length < BATCH) break;
  }

  console.log(`[backfill-emp] Готово. Scanned: ${totalScanned} | Updated: ${totalUpdated}`);
  process.exit(0);
}
main();
