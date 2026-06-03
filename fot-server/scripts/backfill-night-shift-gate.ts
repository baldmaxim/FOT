/**
 * Одноразовый скрипт: пересчитывает дни skud_daily_summary, раздутые overnight-парой
 * у ДНЕВНЫХ смен (баг до миграции 168). Признак раздутого дня: закрывающий выход
 * «завернулся» на следующее утро (last_exit < first_entry) при total_hours > 14.
 *
 * Кейс: Улмасов Б.Б. (id=1836) 15.05.2026 — фантомный вечерний вход спарился с выходом
 * следующего утра → total_hours=20.75 вместо ≈8ч. Масштаб: ~4737 дней / 644 чел.
 *
 * После применения миграции 168 (ночной гейт окна) пересчёт через
 * batch_recalculate_skud_daily_summary даёт корректные часы. Идемпотентно; часы
 * только уменьшаются. Законные ночные смены (~287) гейт не трогает — останутся.
 *
 * Запуск (из build-контекста на проде, где есть src+tsx и .env сайта):
 *   cd fot-server && npx tsx scripts/backfill-night-shift-gate.ts [--from=2026-01-01]
 */
import { execute, query } from '../src/config/postgres.js';

const DEFAULT_FROM = '2026-01-01';
const RPC_BATCH = 200;

const parseFrom = (): string => {
  const arg = process.argv.find(item => item.startsWith('--from='));
  if (!arg) return DEFAULT_FROM;
  const value = arg.slice('--from='.length);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    console.error(`[backfill-night] некорректный --from=${value}, использую ${DEFAULT_FROM}`);
    return DEFAULT_FROM;
  }
  return value;
};

const main = async (): Promise<void> => {
  const from = parseFrom();
  console.log(`[backfill-night] ищу раздутые overnight-дни с ${from}`);

  const rows = await query<{ employee_id: number | null; date: string | null }>(
    `SELECT employee_id, date
       FROM skud_daily_summary
      WHERE date >= $1
        AND date < CURRENT_DATE
        AND last_exit < first_entry
        AND total_hours > 14
      ORDER BY employee_id ASC, date ASC`,
    [from],
  );

  const pairs = rows
    .filter(r => r.employee_id != null && r.date)
    .map(r => ({ emp_id: Number(r.employee_id), date: String(r.date).slice(0, 10) }));

  console.log(`[backfill-night] найдено раздутых дней: ${pairs.length}`);
  if (pairs.length === 0) {
    console.log('[backfill-night] нечего пересчитывать, выхожу.');
    return;
  }

  let processed = 0;
  let failedChunks = 0;
  for (let i = 0; i < pairs.length; i += RPC_BATCH) {
    const chunk = pairs.slice(i, i + RPC_BATCH);
    try {
      await execute(
        'SELECT public.batch_recalculate_skud_daily_summary($1::jsonb)',
        [JSON.stringify(chunk)],
      );
    } catch (err) {
      console.error(
        `[backfill-night] чанк ${i}-${i + chunk.length} упал:`,
        err instanceof Error ? err.message : err,
      );
      failedChunks += 1;
      continue;
    }
    processed += chunk.length;
    console.log(`[backfill-night] обработано ${processed}/${pairs.length}`);
  }

  const [{ still_buggy }] = await query<{ still_buggy: string }>(
    `SELECT count(*)::text AS still_buggy
       FROM skud_daily_summary
      WHERE date >= $1 AND date < CURRENT_DATE
        AND last_exit < first_entry AND total_hours > 14`,
    [from],
  );

  console.log(
    `[backfill-night] готово: пересчитано ${processed}/${pairs.length}, упавших чанков: ${failedChunks}. ` +
    `Осталось «раздутых» (ожидаются законные ночные): ${still_buggy}`,
  );
};

main().catch(err => {
  console.error('[backfill-night] фатальная ошибка:', err);
  process.exit(1);
});
