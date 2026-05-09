/**
 * Одноразовый скрипт: переименовывает старые записи в skud_event_failures
 * с именем `TYPE_<id>` (fallback) на человекочитаемые имена из справочника
 * Sigur (`GET /api/v1/events/types`).
 *
 * Контекст: до этой правки маппер знал только PASS_DETECTED=6 и PASS_DENY=12,
 * остальные типы (TYPE_7, TYPE_24, TYPE_36, ...) попадали в БД с fallback-именем.
 * После загрузки актуального справочника обновляем все такие записи.
 *
 * Запуск: cd fot-server && npx tsx scripts/backfill-failure-type-names.ts
 * Идемпотентен — обновляет только записи, у которых failure_type матчит
 * паттерн `TYPE_<id>` и failure_type_id присутствует в новом справочнике.
 */
import { supabase } from '../src/config/database.js';
import { sigurService } from '../src/services/sigur.service.js';

const main = async (): Promise<void> => {
  console.log('[backfill-types] загружаю справочник типов событий из Sigur...');
  await sigurService.loadEventTypes();

  // Получим уникальные failure_type_id, у которых имя — TYPE_<id>.
  const { data: rows, error } = await supabase
    .from('skud_event_failures')
    .select('failure_type_id, failure_type')
    .like('failure_type', 'TYPE\\_%');

  if (error) {
    console.error('[backfill-types] ошибка SELECT:', error.message);
    process.exit(1);
  }

  const idsToRename = new Map<number, { fallbackName: string; count: number }>();
  for (const row of rows ?? []) {
    const id = (row as { failure_type_id: number | null }).failure_type_id;
    const name = (row as { failure_type: string | null }).failure_type;
    if (id == null || !name) continue;
    const entry = idsToRename.get(id);
    if (entry) entry.count += 1;
    else idsToRename.set(id, { fallbackName: name, count: 1 });
  }

  if (idsToRename.size === 0) {
    console.log('[backfill-types] нечего обновлять — TYPE_* записей нет.');
    return;
  }

  console.log(`[backfill-types] найдено уникальных id для переименования: ${idsToRename.size}`);

  let renamedRows = 0;
  let skippedIds = 0;
  for (const [id, info] of idsToRename) {
    // Используем приватный кеш через обёртку: getEventTypes уже вернул всё,
    // а sigurService после loadEventTypes() кеширует в памяти. Но прямого
    // геттера снаружи нет — повторяем тот же запрос вручную.
    const newName = await resolveTypeName(id);
    if (!newName) {
      console.warn(`[backfill-types] id=${id} (${info.count} записей) не найден в справочнике Sigur — пропускаю`);
      skippedIds += 1;
      continue;
    }
    if (newName === info.fallbackName) {
      console.log(`[backfill-types] id=${id}: имя совпадает (${newName}), пропускаю`);
      continue;
    }
    const { error: updateErr, count } = await supabase
      .from('skud_event_failures')
      .update({ failure_type: newName }, { count: 'exact' })
      .eq('failure_type_id', id)
      .like('failure_type', 'TYPE\\_%');
    if (updateErr) {
      console.error(`[backfill-types] UPDATE для id=${id} упал:`, updateErr.message);
      continue;
    }
    const affected = count ?? info.count;
    renamedRows += affected;
    console.log(`[backfill-types] id=${id}: TYPE_${id} → ${newName} (${affected} записей)`);
  }

  console.log(`[backfill-types] готово: переименовано ${renamedRows} записей, пропущено id: ${skippedIds}`);
};

/**
 * Резолвит id в имя через прямой запрос к Sigur. Используется один раз для
 * каждого уникального id — кеш sigurService уже прогрет при старте скрипта.
 */
let cachedTypes: Map<number, string> | null = null;
async function resolveTypeName(id: number): Promise<string | null> {
  if (!cachedTypes) {
    const response = await sigurService.getEventTypes();
    const items: Array<Record<string, unknown>> = Array.isArray(response)
      ? (response as Array<Record<string, unknown>>)
      : Array.isArray((response as Record<string, unknown> | null)?.data)
        ? ((response as Record<string, unknown>).data as Array<Record<string, unknown>>)
        : [];
    cachedTypes = new Map<number, string>();
    for (const item of items) {
      const itemId = typeof item.id === 'number' ? item.id : null;
      const itemName = typeof item.name === 'string' ? item.name : null;
      if (itemId != null && itemName) cachedTypes.set(itemId, itemName);
    }
    console.log(`[backfill-types] справочник: ${cachedTypes.size} типов`);
  }
  return cachedTypes.get(id) ?? null;
}

main().catch(err => {
  console.error('[backfill-types] фатальная ошибка:', err);
  process.exit(1);
});
