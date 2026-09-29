/**
 * Активация объекта табелирования (миграция 288): первый пересчёт и включение ночного
 * расчёта.
 *
 * Одной транзакцией:
 *   - дозафиксирует прошедшие месяцы, которых ещё нет, текущими режимами (расчёт тогда
 *     ещё не работал);
 *   - пересчитает объект своим сотрудникам по часам с 1-го числа по вчера;
 *   - включит ночной расчёт (enabled = true), запишет applied_date и frozen_month.
 *
 * Запуск (на сервере из /opt/fot-build, после миграции 288 и деплоя бэка):
 *   cd fot-server && npx tsx scripts/apply-auto-timesheet-objects.ts --dry-run
 *   cd fot-server && npx tsx scripts/apply-auto-timesheet-objects.ts --all
 *
 * Флаги:
 *   --dry-run  только отчёт, в БД ничего не пишется;
 *   --all      пересчитать и ручные режимы админа (первый запуск по решению пользователя);
 *   --force    разрешить --all, когда расчёт уже включён (перезапишет ручные правки админа);
 *   --details  в отчёт — построчный список изменений.
 * 1-го числа скрипт не запускается: за текущий месяц ещё нет часов.
 */
import { closeDb } from '../src/config/postgres.js';
import { activateTimesheetObjects } from '../src/services/employee-timesheet-object-auto.service.js';

const dryRun = process.argv.includes('--dry-run');
const all = process.argv.includes('--all');
const force = process.argv.includes('--force');
const details = process.argv.includes('--details');

const main = async (): Promise<void> => {
  const result = await activateTimesheetObjects({ all, force, dryRun });
  const { report } = result;
  const prefix = dryRun ? '[dry-run] ' : '';

  console.log(`${prefix}период расчёта ${result.period.start}..${result.period.end}${all ? ', с ручными режимами (--all)' : ''}`);
  console.log(`${prefix}дозафиксировать месяцы: ${result.frozenMonths.length > 0 ? result.frozenMonths.join(', ') : 'нет'}`);
  console.log(`${prefix}своих работающих сотрудников: ${report.employees}, с часами на объектах: ${report.withHours}`);
  console.log(`${prefix}изменится объект: ${report.changed} (Офис — ${report.toOffice}, объект — ${report.toObject})`);
  console.log(
    `${prefix}  откуда: без режима ${report.fromNone}, «По СКУД» ${report.fromSkud}, `
    + `ручной объект ${report.fromAdminObject}, ручная «Текущая деятельность» ${report.fromAdminOffice}, `
    + `авто ${report.fromAuto}`,
  );
  console.log(`${prefix}без изменений: ${report.unchanged}; не трогаем (выбор сотрудника/табеля${all ? '' : ', ручные админа'}): ${report.skippedManual}`);

  if (details) {
    for (const change of result.changes) {
      console.log(
        `  ${change.employeeId}\t${change.fullName ?? ''}\t${change.fromMode ?? '—'}${change.fromObjectId ? `:${change.fromObjectId}` : ''}`
        + ` → ${change.label} (${change.hours} ч)`,
      );
    }
  }
  console.log(dryRun ? 'В БД ничего не записано.' : 'Готово: ночной расчёт включён.');
};

main()
  .catch(error => {
    console.error('Активация не выполнена:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => { void closeDb(); });
