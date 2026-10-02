/**
 * Объект табелирования (миграция 288): пересчёт сразу, не дожидаясь ночи, — по тому же
 * правилу, что ночной расчёт. Первым запуском включал ночной расчёт.
 *
 * Одной транзакцией:
 *   - при первой активации дозафиксирует прошедшие месяцы, которых ещё нет, текущими
 *     режимами (расчёт тогда ещё не работал); если расчёт уже включён, а прошлый месяц не
 *     зафиксирован ночью, — отказ;
 *   - ставит своим работающим сотрудникам объект с наибольшими часами с 1-го числа по
 *     вчера, в том числе поверх прежнего выбора в ЛК/табеле и ручного объекта админа;
 *     «Офис» из окна «Режим табелирования» (отдела и личный) не трогает, нет часов —
 *     объект прежний; рабочим (роль «Рабочий» или бригадник без учётки) — «По СКУД»,
 *     разбивка по проходам, независимо от часов;
 *   - включит ночной расчёт (enabled = true), запишет applied_date и frozen_month.
 *
 * Запуск на сервере — рабочий каталог папка сайта (там production .env):
 *   cd /srv/sites/fot.su10.ru/fot-server
 *   NODE_ENV=production /opt/fot-build/fot-server/node_modules/.bin/tsx \
 *     /opt/fot-build/fot-server/scripts/apply-auto-timesheet-objects.ts --dry-run --details
 *
 * Флаги:
 *   --dry-run  только отчёт, в БД ничего не пишется;
 *   --details  в отчёт — построчный список изменений.
 * 1-го числа скрипт не запускается: за текущий месяц ещё нет часов.
 */
import { closeDb } from '../src/config/postgres.js';
import { activateTimesheetObjects } from '../src/services/employee-timesheet-object-auto.service.js';

const dryRun = process.argv.includes('--dry-run');
const details = process.argv.includes('--details');

const main = async (): Promise<void> => {
  const result = await activateTimesheetObjects({ dryRun });
  const { report } = result;
  const prefix = dryRun ? '[dry-run] ' : '';

  console.log(`${prefix}период расчёта ${result.period.start}..${result.period.end}`);
  console.log(`${prefix}дозафиксировать месяцы: ${result.frozenMonths.length > 0 ? result.frozenMonths.join(', ') : 'нет'}`);
  console.log(`${prefix}своих работающих сотрудников: ${report.employees}, с часами на объектах: ${report.withHours}`);
  console.log(`${prefix}рабочих (разбивка «По СКУД»): ${report.workers}`);
  console.log(
    `${prefix}изменится объект: ${report.changed} `
    + `(Офис — ${report.toOffice}, объект — ${report.toObject}, рабочие → «По СКУД» — ${report.toSkud})`,
  );
  console.log(
    `${prefix}  откуда: без режима ${report.fromNone}, «По СКУД» ${report.fromSkud}, `
    + `ручной объект ${report.fromAdminObject}, ручная «Текущая деятельность» ${report.fromAdminOffice}, `
    + `выбор в ЛК/табеле → по часам ${report.fromChoice}, авто ${report.fromAuto}`,
  );
  console.log(`${prefix}без изменений (нет часов или объект тот же): ${report.unchanged}`);
  console.log(`${prefix}назначение из «Режима табелирования» («Офис» или объект) — не трогаем: ${report.personalPin}`);
  console.log(`${prefix}в отделах с «Офисом» (объект ставит правило отдела): ${report.officeDepartment}`);

  if (details) {
    for (const change of result.changes) {
      console.log(
        `  ${change.employeeId}\t${change.fullName ?? ''}\t${change.fromSetBy ?? '—'}\t`
        + `${change.fromMode ?? '—'}${change.fromObjectId ? `:${change.fromObjectId}` : ''}`
        + ` → ${change.label}${change.toMode === 'skud' ? '' : ` (${change.hours} ч)`}`,
      );
    }
  }
  console.log(dryRun ? 'В БД ничего не записано.' : 'Готово: объекты пересчитаны, ночной расчёт включён.');
};

main()
  .catch(error => {
    console.error('Пересчёт не выполнен:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => { void closeDb(); });
