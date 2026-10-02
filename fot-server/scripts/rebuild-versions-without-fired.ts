/**
 * Разовая пересборка утверждённых подач месяца без уволенных в этом месяце (правило с
 * 01.09.2026: уволенный не виден в месяце увольнения — ни в табеле, ни в «Едином 1С», ни
 * в API 1С). Уже утверждённые подачи хранят уволенных в последней редакции — скрипт
 * адресно убирает их (остальные сотрудники, разбивка и руководители — байт в байт) и
 * создаёт новую revision: 1С увидит подачу устаревшей и перечитает её. Подробности —
 * src/services/timesheet-version-fired-rebuild.service.ts.
 *
 * Запускать ПОСЛЕ правки фиксации рабочих (fix-worker-timesheet-objects-month) и пересборки
 * объектов планировщиком: пока objects_rebuilt_month < месяц, скрипт отказывается.
 *
 * Запуск на сервере — рабочий каталог папка сайта (там production .env):
 *   cd /srv/sites/fot.su10.ru/fot-server
 *   NODE_ENV=production /opt/fot-build/fot-server/node_modules/.bin/tsx \
 *     /opt/fot-build/fot-server/scripts/rebuild-versions-without-fired.ts --month=2026-09
 *
 * Флаги:
 *   --month=YYYY-MM   месяц (обязателен, не раньше 2026-09);
 *   --yes             пересобрать (без него — только отчёт);
 *   --only=1621,1633  только указанные подачи.
 */
import { closeDb } from '../src/config/postgres.js';
import { readTimesheetObjectState } from '../src/services/employee-timesheet-object.service.js';
import { toMonthStart } from '../src/services/timesheet-export-mode.service.js';
import { FIRED_HIDDEN_FROM_MONTH } from '../src/services/timesheet-fired-cutoff.service.js';
import {
  listFiredRebuildCandidates,
  rebuildApprovalWithoutFired,
} from '../src/services/timesheet-version-fired-rebuild.service.js';

const APPLY = process.argv.includes('--yes');
const monthArg = process.argv.find(arg => arg.startsWith('--month='))?.slice('--month='.length) ?? '';
const ONLY = (() => {
  const arg = process.argv.find(item => item.startsWith('--only='));
  if (!arg) return null;
  const ids = arg.slice('--only='.length).split(',').map(Number).filter(id => Number.isSafeInteger(id) && id > 0);
  return ids.length > 0 ? new Set(ids) : null;
})();

const main = async (): Promise<void> => {
  const month = toMonthStart(monthArg);
  if (!month) throw new Error('Укажите --month=YYYY-MM');
  if (month < FIRED_HIDDEN_FROM_MONTH) throw new Error(`Правило действует с ${FIRED_HIDDEN_FROM_MONTH}: месяц ${month} не трогаем`);

  const state = await readTimesheetObjectState();
  if (state && state.frozen_month >= month && state.objects_rebuilt_month < month) {
    throw new Error(
      `Объекты подач ${month} ещё не пересобраны (objects_rebuilt_month ${state.objects_rebuilt_month}) — `
      + 'дождитесь планировщика после fix-worker-timesheet-objects-month',
    );
  }

  const candidates = (await listFiredRebuildCandidates(month))
    .filter(candidate => !ONLY || ONLY.has(candidate.approvalId));
  const people = candidates.reduce((sum, candidate) => sum + candidate.fired.length, 0);
  const hours = candidates.reduce((sum, candidate) => sum + candidate.fired.reduce((acc, row) => acc + row.hours, 0), 0);
  console.log(`${APPLY ? '' : '[отчёт] '}месяц ${month}: подач с уволенными ${candidates.length}, уволенных ${people}, часов ${Math.round(hours * 100) / 100}`);
  for (const candidate of candidates) {
    const scope = candidate.managerEmployeeId != null ? `личная ${candidate.managerEmployeeId}` : `отдел ${candidate.departmentId}`;
    console.log(
      `  подача ${candidate.approvalId} (${candidate.startDate}..${candidate.endDate}, ${scope}): `
      + candidate.fired.map(row => `${row.employeeId} ${row.fullName ?? ''} ${row.hours} ч`).join('; '),
    );
  }
  if (!APPLY) {
    console.log('В БД ничего не записано. Пересобрать — с --yes.');
    return;
  }

  let created = 0;
  let failures = 0;
  for (const candidate of candidates) {
    try {
      const result = await rebuildApprovalWithoutFired(candidate.approvalId);
      if (result.created) {
        created += 1;
        console.log(`  подача ${candidate.approvalId}: revision ${result.revision}, убраны ${result.removedIds.join(', ')}`);
      } else {
        console.log(`  подача ${candidate.approvalId}: без изменений (уже пересобрана, открыта или уволенных нет)`);
      }
    } catch (error) {
      failures += 1;
      console.error(`  подача ${candidate.approvalId}: ошибка —`, error instanceof Error ? error.message : error);
    }
  }
  console.log(`Готово: новых редакций ${created}, ошибок ${failures}. Предупредите 1С — перечитать подачи ${month}.`);
  if (failures > 0) process.exitCode = 1;
};

main()
  .catch(error => {
    console.error('Пересборка не выполнена:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => { void closeDb(); });
