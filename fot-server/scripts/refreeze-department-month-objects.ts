/**
 * Объект табелирования (миграция 288): пересчёт фиксации уже зафиксированного месяца для
 * одного отдела — по часам за весь месяц, как ночная фиксация без «Офиса» отдела.
 *
 * Повод — отдел ОТ и ТБ: стоял в «Режиме табелирования» с «Офисом», сентябрь 2026
 * зафиксировался «Офисом», правило сняли 02.10. Ночь зафиксированный месяц не трогает.
 *
 * Одной транзакцией: строки фиксации прямых не архивных сотрудников отдела → объект с
 * наибольшими часами за месяц (офис — «Офис»), нет часов — прежний, личный «Офис» не
 * трогается; аудит TIMESHEET_OBJECT_AUTO_ASSIGNED (reason month_refreeze). После COMMIT —
 * пересборка объектной разбивки утверждённых подач месяца с сотрудниками отдела (новая
 * редакция source = 'objects' — только где объект сменился, 1С перезаберёт). Повтор —
 * no-op, а упавшую пересборку дочиняет.
 *
 * Отказ: месяц не закончился или не зафиксирован, у отдела стоит «Офис», отдел подрядный.
 *
 * Запуск на сервере — рабочий каталог папка сайта (там production .env):
 *   cd /srv/sites/fot.su10.ru/fot-server
 *   NODE_ENV=production /opt/fot-build/fot-server/node_modules/.bin/tsx \
 *     /opt/fot-build/fot-server/scripts/refreeze-department-month-objects.ts \
 *     --month 2026-09 --department <uuid> --dry-run --details
 *
 * Флаги:
 *   --month YYYY-MM   месяц фиксации;
 *   --department UUID отдел;
 *   --dry-run         только отчёт, в БД ничего не пишется;
 *   --details         построчный список изменений.
 */
import { closeDb } from '../src/config/postgres.js';
import { refreezeDepartmentMonth } from '../src/services/timesheet-object-month-refreeze.service.js';
import { rebuildVersionObjectsForMonth } from '../src/services/timesheet-version-objects-rebuild.service.js';

const argValue = (name: string): string | null => {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] ?? null;
  const inline = process.argv.find(arg => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const dryRun = process.argv.includes('--dry-run');
const details = process.argv.includes('--details');
const month = argValue('--month');
const departmentId = argValue('--department');

const main = async (): Promise<void> => {
  if (!month || !departmentId || !UUID_RE.test(departmentId)) {
    throw new Error('Нужны --month YYYY-MM и --department <uuid>');
  }
  const result = await refreezeDepartmentMonth({ month, departmentId, dryRun });
  const prefix = dryRun ? '[dry-run] ' : '';
  const toOffice = result.changes.filter(change => change.toMode === 'current_activity').length;

  console.log(`${prefix}отдел «${result.departmentName}», месяц ${result.month}`);
  console.log(`${prefix}сотрудников со строкой фиксации: ${result.employees}, с часами на объектах: ${result.withHours}`);
  console.log(`${prefix}изменится: ${result.changes.length} (объект — ${result.changes.length - toOffice}, «Офис» — ${toOffice})`);
  console.log(`${prefix}без изменений (нет часов или объект тот же): ${result.employees - result.changes.length - result.personalOffice}`);
  console.log(`${prefix}личный «Офис» — не трогаем: ${result.personalOffice}`);
  if (result.withoutFreezeRow.length > 0) {
    console.log(`${prefix}без строки фиксации (не трогаем): ${result.withoutFreezeRow.map(row => `${row.id} ${row.fullName ?? ''}`).join(', ')}`);
  }
  if (details) {
    for (const change of result.changes) {
      console.log(
        `  ${change.employeeId}\t${change.fullName ?? ''}\t${change.fromSetBy ?? '—'}\t`
        + `${change.fromMode ?? '—'}${change.fromObjectId ? `:${change.fromObjectId}` : ''}`
        + ` → ${change.label}${change.toMode === 'skud' ? '' : ` (${change.hours} ч)`}`,
      );
    }
  }
  if (dryRun) {
    console.log('В БД ничего не записано.');
    return;
  }

  console.log(`фиксация обновлена: ${result.appliedIds.length}`);
  // По всем сотрудникам отдела: у неизменённых пересборка — no-op, а повтор дочинит упавшие.
  const rebuild = await rebuildVersionObjectsForMonth(result.month, { employeeIds: result.employeeIds });
  console.log(`пересборка объектов подач: подач ${rebuild.approvals}, новых редакций ${rebuild.created}, сбоев ${rebuild.failures}`);
  if (rebuild.failures > 0) {
    console.log('Есть сбои пересборки — запустите скрипт ещё раз: фиксация уже стоит, повтор пересоберёт только упавшие.');
    process.exitCode = 1;
  }
};

main()
  .catch(error => {
    console.error('Пересчёт не выполнен:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => { void closeDb(); });
