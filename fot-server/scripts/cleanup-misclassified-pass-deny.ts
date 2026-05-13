/**
 * Одноразовый скрипт: чистит из skud_events записи, которые попали туда по
 * багу классификации до фикса в `enrichAllRawEvents` (PASS_DENY и др. не-PASS
 * события классифицировались как success по direction/accessObjectId).
 *
 * Алгоритм:
 *   1. Загрузить все строки из skud_event_failures за период.
 *   2. Для каждой строки пересчитать «старый» dedup_hash как
 *      computeDedupHash(physical_person, event_date, event_time, access_point, direction)
 *      — это тот же hash, который использовался при ошибочной записи
 *      события в skud_events (формат старого hash, без failure_type/raw_id).
 *   3. Найти соответствующие записи в skud_events по этим dedup_hash и
 *      собрать пары (employee_id, event_date) для последующего пересчёта.
 *   4. Удалить найденные записи из skud_events.
 *   5. Вызвать batch_recalculate_skud_daily_summary для пострадавших пар —
 *      total_hours/first_entry/last_exit пересчитаются без ложных событий.
 *
 * После запуска повторно открыть табель/карточку сотрудника — failure'ы
 * больше не будут учитываться в часах работы.
 *
 * Идемпотентен: повторный запуск ничего не удалит, т.к. после первого запуска
 * записей с такими dedup_hash в skud_events не останется.
 *
 * Запуск:
 *   cd fot-server && npx tsx scripts/cleanup-misclassified-pass-deny.ts \
 *     --start=2026-04-01 --end=2026-05-08 [--dry-run]
 *
 * Без --dry-run скрипт реально удаляет записи и пересчитывает summary.
 * --dry-run только печатает что было бы удалено и сколько пар пересчитано.
 */
import { execute, query } from '../src/config/postgres.js';
import { computeDedupHash } from '../src/utils/dedup.utils.js';

const PAGE = 2000;
const DELETE_BATCH = 500;
const RECALC_BATCH = 100;

interface FailureRow {
  physical_person: string | null;
  event_date: string;
  event_time: string;
  access_point: string | null;
  direction: 'entry' | 'exit' | null;
}

interface SkudEventMatch {
  id: number;
  employee_id: number | null;
  event_date: string;
  event_at: string;
  dedup_hash: string;
  physical_person: string | null;
  access_point: string | null;
  direction: string | null;
}

const parseArg = (name: string): string | null => {
  const arg = process.argv.find(item => item.startsWith(`--${name}=`));
  if (!arg) return null;
  return arg.slice(`--${name}=`.length);
};

const isDryRun = (): boolean => process.argv.includes('--dry-run');

async function main(): Promise<void> {
  const startDate = parseArg('start');
  const endDate = parseArg('end');
  const dryRun = isDryRun();

  if (!startDate || !endDate) {
    console.error(
      'usage: npx tsx scripts/cleanup-misclassified-pass-deny.ts --start=YYYY-MM-DD --end=YYYY-MM-DD [--dry-run]',
    );
    process.exit(1);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    console.error(`[cleanup] некорректные даты: start=${startDate} end=${endDate}`);
    process.exit(1);
  }

  console.log(
    `[cleanup] period=${startDate}..${endDate} dryRun=${dryRun ? 'YES' : 'no'}`,
  );

  // ─── 1. Загружаем все failures за период ───
  const failures: FailureRow[] = [];
  {
    let from = 0;
    while (true) {
      const rows = await query<{
        physical_person: string | null;
        event_date: string;
        event_time: string;
        access_point: string | null;
        direction: 'entry' | 'exit' | null;
      }>(
        `SELECT physical_person, event_date, event_time, access_point, direction
           FROM skud_event_failures
          WHERE event_date >= $1 AND event_date <= $2
          ORDER BY event_date ASC
          LIMIT $3 OFFSET $4`,
        [startDate, endDate, PAGE, from],
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        failures.push({
          physical_person: row.physical_person,
          event_date: String(row.event_date),
          event_time: String(row.event_time),
          access_point: row.access_point,
          direction: row.direction,
        });
      }
      if (rows.length < PAGE) break;
      from += PAGE;
    }
  }
  console.log(`[cleanup] загружено ${failures.length} failures за период`);

  if (failures.length === 0) {
    console.log('[cleanup] failures за период не найдены, нечего чистить.');
    return;
  }

  // ─── 2. Пересчитываем «старые» hash, под которыми failure лежат в skud_events ───
  const oldHashes = new Set<string>();
  for (const f of failures) {
    if (!f.physical_person) continue; // без имени в skud_events записи быть не должно
    const hash = computeDedupHash(
      f.physical_person,
      f.event_date,
      f.event_time,
      f.access_point,
      f.direction,
    );
    oldHashes.add(hash);
  }
  console.log(`[cleanup] уникальных «старых» hash для поиска: ${oldHashes.size}`);

  if (oldHashes.size === 0) {
    console.log('[cleanup] все failures без physical_person — поиск в skud_events невозможен.');
    return;
  }

  // ─── 3. Ищем совпадения в skud_events ───
  const allHashes = [...oldHashes];
  const matches: SkudEventMatch[] = [];
  for (let i = 0; i < allHashes.length; i += DELETE_BATCH) {
    const chunk = allHashes.slice(i, i + DELETE_BATCH);
    const rows = await query<{
      id: number;
      employee_id: number | null;
      event_date: string;
      event_at: string;
      dedup_hash: string;
      physical_person: string | null;
      access_point: string | null;
      direction: string | null;
    }>(
      `SELECT id, employee_id, event_date, event_at, dedup_hash, physical_person, access_point, direction
         FROM skud_events
        WHERE dedup_hash = ANY($1::text[])
          AND event_date >= $2
          AND event_date <= $3`,
      [chunk, startDate, endDate],
    );
    for (const row of rows) {
      matches.push({
        id: Number(row.id),
        employee_id: row.employee_id ?? null,
        event_date: String(row.event_date),
        event_at: String(row.event_at),
        dedup_hash: String(row.dedup_hash),
        physical_person: row.physical_person ?? null,
        access_point: row.access_point ?? null,
        direction: row.direction ?? null,
      });
    }
  }
  console.log(`[cleanup] найдено ${matches.length} ложных success-записей в skud_events`);

  if (matches.length === 0) {
    console.log('[cleanup] совпадений нет — нечего удалять.');
    return;
  }

  // Сэмпл первых 5 для аудита
  console.log('[cleanup] sample (первые 5):');
  for (const m of matches.slice(0, 5)) {
    console.log(
      `  id=${m.id} emp=${m.employee_id} ${m.event_date} ${m.event_at} ${m.physical_person} @ ${m.access_point} (${m.direction})`,
    );
  }

  // ─── 4. Собираем пары (employee_id, event_date) для пересчёта ───
  const recalcPairs = new Set<string>();
  for (const m of matches) {
    if (m.employee_id != null) {
      recalcPairs.add(`${m.employee_id}:${m.event_date}`);
    }
  }
  console.log(`[cleanup] пар (emp, date) для пересчёта summary: ${recalcPairs.size}`);

  if (dryRun) {
    console.log('[cleanup] DRY RUN — изменений не делаем.');
    return;
  }

  // ─── 5. Удаляем ───
  const idsToDelete = matches.map(m => m.id);
  let deleted = 0;
  for (let i = 0; i < idsToDelete.length; i += DELETE_BATCH) {
    const chunk = idsToDelete.slice(i, i + DELETE_BATCH);
    try {
      await execute(
        'DELETE FROM skud_events WHERE id = ANY($1::bigint[])',
        [chunk],
      );
    } catch (err) {
      console.error(
        `[cleanup] ошибка удаления batch ${i}/${idsToDelete.length}:`,
        err instanceof Error ? err.message : err,
      );
      throw err;
    }
    deleted += chunk.length;
  }
  console.log(`[cleanup] удалено из skud_events: ${deleted} строк`);

  // ─── 6. Пересчитываем skud_daily_summary ───
  const allPairs = [...recalcPairs].map(key => {
    const [empId, date] = key.split(':');
    return { emp_id: parseInt(empId, 10), date };
  });
  let recalced = 0;
  for (let i = 0; i < allPairs.length; i += RECALC_BATCH) {
    const chunk = allPairs.slice(i, i + RECALC_BATCH);
    try {
      await execute(
        'SELECT public.batch_recalculate_skud_daily_summary($1::jsonb)',
        [JSON.stringify(chunk)],
      );
    } catch (err) {
      console.error(
        `[cleanup] ошибка recalc batch ${i}/${allPairs.length}:`,
        err instanceof Error ? err.message : err,
      );
      throw err;
    }
    recalced += chunk.length;
  }
  console.log(`[cleanup] пересчитано summary для ${recalced} пар (emp, date)`);

  console.log('[cleanup] DONE.');
}

main().catch(err => {
  console.error('[cleanup] FATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
