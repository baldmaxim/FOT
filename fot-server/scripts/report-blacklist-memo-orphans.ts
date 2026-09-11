/**
 * Отчёт о «сиротах» служебных записок чёрного списка (миграция 274). READ-ONLY.
 *
 * Сирота — объект R2 под префиксом `blacklist/`, на чей ключ не ссылается ни одна
 * строка person_blacklist_memos (включая мягко удалённые). Появляется в одном
 * случае: файл ушёл в R2, транзакция БД упала и запрос не повторили. Данные при
 * этом не теряются, объём ограничен одним объектом на уникальный файл.
 *
 * Скрипт НИЧЕГО не удаляет. Автоочистки нет намеренно: ошибка очистки уничтожила
 * бы доказательство. Решение по каждому объекту — вручную.
 *
 * Запуск (на сервере из /opt/fot-build):
 *   cd fot-server && npx tsx scripts/report-blacklist-memo-orphans.ts
 *   ... --older-than-days=7   — показывать только объекты старше N дней (по умолчанию 1)
 */
import { query } from '../src/config/postgres.js';
import { r2Service } from '../src/services/r2.service.js';

const PREFIX = 'blacklist/';

const olderThanDays = (() => {
  const arg = process.argv.find(a => a.startsWith('--older-than-days='));
  const value = arg ? Number(arg.split('=')[1]) : 1;
  return Number.isFinite(value) && value >= 0 ? value : 1;
})();

const main = async (): Promise<void> => {
  if (!(await r2Service.isEnabledAsync())) {
    throw new Error('R2 не настроен — сравнивать не с чем.');
  }

  const objects = await r2Service.listObjects(PREFIX);
  const rows = await query<{ r2_key: string }>(
    'SELECT DISTINCT r2_key FROM public.person_blacklist_memos',
  );
  const referenced = new Set(rows.map(row => row.r2_key));

  // Свежие объекты пропускаем: загрузка могла прямо сейчас быть между R2 и транзакцией.
  const threshold = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const orphans = objects.filter(obj =>
    !referenced.has(obj.key)
    && (obj.lastModified === null || obj.lastModified.getTime() < threshold));

  console.log(`Объектов под ${PREFIX}: ${objects.length}`);
  console.log(`Ключей в person_blacklist_memos (с удалёнными): ${referenced.size}`);
  console.log(`Сирот старше ${olderThanDays} дн.: ${orphans.length}`);

  for (const orphan of orphans) {
    const days = orphan.lastModified
      ? Math.floor((Date.now() - orphan.lastModified.getTime()) / (24 * 60 * 60 * 1000))
      : null;
    console.log(`  ${orphan.key}  ${orphan.size} байт  ${days === null ? 'возраст неизвестен' : `${days} дн.`}`);
  }

  if (orphans.length > 0) {
    console.log('\nСкрипт ничего не удалял. Перед ручным удалением сверьте содержимое объекта.');
  }
};

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('Отчёт не построен:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
