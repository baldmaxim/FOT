/**
 * «Офис» из окна «Режим табелирования» — в уже зафиксированном месяце. Окно действует на
 * месяцы, которые ещё не зафиксированы: «Офис», поставленный после ночной фиксации (УОК-Офис —
 * 1.10 10:51, сентябрь зафиксирован в 04:13), в прошлый месяц не попал. Скрипт ставит «Офис»
 * в фиксации месяца всем, кто сейчас в окне, — сотрудникам отделов с «Офисом» и личным
 * «Офисам», — у кого там ещё не «Офис». Подробности —
 * src/services/employee-timesheet-object-month-fix.service.ts (applyOfficeWindowToFrozenMonth).
 *
 * Если фиксация изменилась, планировщик (тик 15 мин, с 04:00 МСК) пересоберёт объектную
 * разбивку утверждённых подач месяца — дождаться objects_rebuilt_month = месяц.
 * Повторный запуск — 0 изменений.
 *
 * Запуск на сервере — рабочий каталог папка сайта (там production .env):
 *   cd /srv/sites/fot.su10.ru/fot-server
 *   NODE_ENV=production /opt/fot-build/fot-server/node_modules/.bin/tsx \
 *     /opt/fot-build/fot-server/scripts/apply-office-window-month.ts --month=2026-09 --dry-run --details
 *
 * Флаги:
 *   --month=YYYY-MM  месяц (обязателен);
 *   --dry-run        только отчёт, в БД ничего не пишется;
 *   --details        в отчёт — построчный список.
 */
import { closeDb } from '../src/config/postgres.js';
import { applyOfficeWindowToFrozenMonth } from '../src/services/employee-timesheet-object-month-fix.service.js';

const dryRun = process.argv.includes('--dry-run');
const details = process.argv.includes('--details');
const monthArg = process.argv.find(arg => arg.startsWith('--month='))?.slice('--month='.length) ?? '';

const main = async (): Promise<void> => {
  if (!monthArg) throw new Error('Укажите --month=YYYY-MM');
  const result = await applyOfficeWindowToFrozenMonth({ month: monthArg, dryRun });
  const prefix = dryRun ? '[dry-run] ' : '';
  const byDepartment = result.rows.filter(row => row.via === 'department').length;

  console.log(`${prefix}месяц ${result.month}`);
  console.log(
    `${prefix}строки фиксации → «Офис»: ${result.rows.length} `
    + `(«Офис» отдела ${byDepartment}, личный «Офис» ${result.rows.length - byDepartment})`,
  );
  if (details) {
    for (const row of result.rows) {
      console.log(
        `  ${row.employeeId}\t${row.fullName ?? ''}\t${row.via === 'department' ? 'отдел' : 'личный'}\t`
        + `${row.departmentName ?? ''}\t${row.fromSetBy ?? '—'}\t`
        + `${row.fromMode ?? '—'}${row.fromObjectId ? `:${row.fromObjectId}` : ''} → Офис`,
      );
    }
  }
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
