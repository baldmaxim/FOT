/**
 * Гейт перед деплоем фронта «Статьи затрат»: проверяет ОПУБЛИКОВАННОЕ поколение снимков
 * 277/279, а не последнюю запись журнала (она может быть running/error/superseded при
 * корректном активном снимке). Только чтение, в одной REPEATABLE READ транзакции.
 *
 * Запуск (на сервере из /opt/fot-build):
 *   cd fot-server && npx tsx scripts/check-main-object-snapshot.ts
 *   ... --allow-empty   — пустой готовый снимок не считать провалом
 *
 * Код выхода 0 — все проверки пройдены, 1 — провал (причины в выводе).
 */
import { closeDb } from '../src/config/postgres.js';
import { checkPublishedSnapshot } from '../src/services/employee-main-object-snapshot-check.service.js';

const allowEmpty = process.argv.includes('--allow-empty');

const main = async (): Promise<void> => {
  const report = await checkPublishedSnapshot({ allowEmpty });
  for (const line of report.info) console.log(line);
  if (report.failures.length === 0) {
    console.log('OK: опубликованный снимок согласован.');
    return;
  }
  for (const failure of report.failures) console.error(`ПРОВАЛ: ${failure}`);
  process.exitCode = 1;
};

main()
  .catch(error => {
    console.error('Проверка не выполнена:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => { void closeDb(); });
