/**
 * Ручной пересчёт снимка «основного объекта» сотрудников (миграция 277).
 *
 * Обычно не нужен: планировщик сам заполняет снимок через ~2 минуты после старта
 * бэкенда и дальше пересчитывает раз в сутки после 03:00 МСК. Скрипт — для первого
 * заполнения без ожидания и для отладки.
 *
 * Запуск (на сервере из /opt/fot-build):
 *   cd fot-server && npx tsx scripts/rebuild-main-object-snapshot.ts
 *   ... --dry-run   — только расчёт и сводка, в БД НИЧЕГО не пишется
 */
import { closeDb } from '../src/config/postgres.js';
import { rebuildMainObjectSnapshot } from '../src/services/employee-main-object-snapshot.service.js';

const dryRun = process.argv.includes('--dry-run');

const main = async (): Promise<void> => {
  const result = await rebuildMainObjectSnapshot({ dryRun });
  console.log(
    `${dryRun ? '[dry-run] ' : ''}период ${result.period.start}..${result.period.end}: `
    + `сотрудников ${result.employees}, с объектом ${result.withObject}, ${result.durationMs} мс`,
  );
  if (dryRun) console.log('В БД ничего не записано.');
};

main()
  .catch(error => {
    console.error('Пересчёт не выполнен:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => { void closeDb(); });
