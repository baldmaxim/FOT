/**
 * Разовая правка зафиксированного месяца под правило рабочих: рабочим (роль «Рабочий» или
 * бригадник без учётки) в фиксации месяца — «По СКУД» (skud/auto) вместо объекта по часам.
 * Нужна для сентября 2026: он зафиксирован 1.10, до правила. Подробности —
 * src/services/employee-timesheet-object-month-fix.service.ts.
 *
 * Если строки фиксации изменились, планировщик (тик 15 мин, с 04:00 МСК) пересоберёт
 * объектную разбивку утверждённых подач месяца — дождаться objects_rebuilt_month = месяц.
 * Повторный запуск — 0 изменений.
 *
 * Запуск на сервере — рабочий каталог папка сайта (там production .env):
 *   cd /srv/sites/fot.su10.ru/fot-server
 *   NODE_ENV=production /opt/fot-build/fot-server/node_modules/.bin/tsx \
 *     /opt/fot-build/fot-server/scripts/fix-worker-timesheet-objects-month.ts --month=2026-09 --dry-run --details
 *
 * Флаги:
 *   --month=YYYY-MM  месяц (обязателен);
 *   --dry-run        только отчёт, в БД ничего не пишется;
 *   --details        в отчёт — построчный список.
 */
import { closeDb } from '../src/config/postgres.js';
import { fixWorkersFrozenMonth, type IMonthFixRow } from '../src/services/employee-timesheet-object-month-fix.service.js';

const dryRun = process.argv.includes('--dry-run');
const details = process.argv.includes('--details');
const monthArg = process.argv.find(arg => arg.startsWith('--month='))?.slice('--month='.length) ?? '';

const printRows = (rows: IMonthFixRow[]): void => {
  for (const row of rows) {
    console.log(
      `  ${row.employeeId}\t${row.fullName ?? ''}\t${row.employmentStatus}\t${row.fromSetBy ?? '—'}\t`
      + `${row.fromMode ?? '—'}${row.fromObjectId ? `:${row.fromObjectId}` : ''} → По СКУД`,
    );
  }
};

const main = async (): Promise<void> => {
  if (!monthArg) throw new Error('Укажите --month=YYYY-MM');
  const result = await fixWorkersFrozenMonth({ month: monthArg, dryRun });
  const prefix = dryRun ? '[dry-run] ' : '';
  const firedFrozen = result.frozen.filter(row => row.employmentStatus === 'fired').length;

  console.log(`${prefix}месяц ${result.month}`);
  console.log(
    `${prefix}строки фиксации рабочих → «По СКУД»: ${result.frozen.length} `
    + `(работают ${result.frozen.length - firedFrozen}, уволены ${firedFrozen})`,
  );
  if (details) printRows(result.frozen);
  console.log(`${prefix}уволенные рабочие, объект в карточке → «По СКУД»: ${result.live.length}`);
  if (details) printRows(result.live);
  if (dryRun) {
    console.log('В БД ничего не записано.');
    return;
  }
  console.log(result.rebuildRequested
    ? `Готово. Планировщик пересоберёт объекты подач ${result.month} — дождитесь objects_rebuilt_month = ${result.month}.`
    : 'Готово: фиксация не менялась, пересборка не нужна.');
};

main()
  .catch(error => {
    console.error('Правка не выполнена:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => { void closeDb(); });
