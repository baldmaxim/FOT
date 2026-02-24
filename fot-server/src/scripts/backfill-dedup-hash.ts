/**
 * Одноразовый скрипт: бэкфилл dedup_hash + удаление дублей.
 * Запуск: npx tsx src/scripts/backfill-dedup-hash.ts
 */
import { supabase } from '../config/database.js';
import { encryptionService } from '../services/encryption.service.js';
import { computeDedupHash } from '../utils/dedup.utils.js';

const BATCH = 1000;
const CONCURRENCY = 50; // параллельных UPDATE

async function backfill() {
  console.log('[backfill] Начинаю бэкфилл dedup_hash...');

  let totalUpdated = 0;

  while (true) {
    const { data: rows, error } = await supabase
      .from('skud_events')
      .select('id, physical_person_encrypted, event_date, event_time, access_point, direction')
      .is('dedup_hash', null)
      .order('id')
      .range(0, BATCH - 1);

    if (error) {
      console.error('[backfill] Ошибка загрузки:', error.message);
      break;
    }
    if (!rows || rows.length === 0) break;

    // Вычисляем хэши
    const updates: { id: number; hash: string }[] = [];
    for (const row of rows) {
      const name = encryptionService.decrypt(row.physical_person_encrypted);
      const hash = computeDedupHash(name, row.event_date, row.event_time, row.access_point, row.direction);
      updates.push({ id: row.id, hash });
    }

    // Параллельные UPDATE по CONCURRENCY штук
    for (let i = 0; i < updates.length; i += CONCURRENCY) {
      const chunk = updates.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(u => supabase.from('skud_events').update({ dedup_hash: u.hash }).eq('id', u.id))
      );
    }

    totalUpdated += updates.length;
    console.log(`[backfill] Обновлено: ${totalUpdated}`);

    if (rows.length < BATCH) break;
  }

  console.log(`[backfill] Бэкфилл завершён. Обновлено строк: ${totalUpdated}`);

  // Удаление дублей
  console.log('[backfill] Поиск дублей...');

  const { data: dupes, error: dupErr } = await supabase.rpc('find_skud_duplicate_ids');
  if (dupErr) {
    console.error('[backfill] Ошибка поиска дублей:', dupErr.message);
    return;
  }

  if (!dupes || dupes.length === 0) {
    console.log('[backfill] Дублей не найдено.');
    return;
  }

  console.log(`[backfill] Найдено дублей: ${dupes.length}. Удаляю...`);
  const idsToDelete: number[] = dupes.map((d: { id: number }) => d.id);
  let totalDeleted = 0;

  for (let i = 0; i < idsToDelete.length; i += BATCH) {
    const batch = idsToDelete.slice(i, i + BATCH);
    const { error: delErr } = await supabase.from('skud_events').delete().in('id', batch);
    if (delErr) {
      console.error('[backfill] Ошибка удаления:', delErr.message);
    } else {
      totalDeleted += batch.length;
      console.log(`[backfill] Удалено: ${totalDeleted} / ${idsToDelete.length}`);
    }
  }

  console.log(`[backfill] Удалено дублей: ${totalDeleted}`);
}

backfill().then(() => {
  console.log('[backfill] Готово.');
  process.exit(0);
}).catch(err => {
  console.error('[backfill] Критическая ошибка:', err);
  process.exit(1);
});
