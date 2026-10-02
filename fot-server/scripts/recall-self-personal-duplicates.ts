/**
 * Разовая чистка: утверждённая персональная подача руководителя, чья строка уже есть в
 * утверждённой подаче его отдела, уводится в пустой черновик — иначе 1С получит часы
 * руководителя дважды (сентябрь 2026: Душанова, Карасени, Орешкин). Строка остаётся в
 * подаче отдела, редакции персональной — историей.
 *
 * Заодно в пустой черновик уходят ещё не утверждённые личные подачи, поданные до
 * 5f6f1c33, где только сам руководитель, а его строку теперь подаёт отдел (сентябрь:
 * Хачатуров) — иначе утверждение подачи отдела упрётся в пересечение дней. Подробности —
 * src/services/timesheet-self-personal-duplicate.service.ts.
 *
 * Запускать ДО перезапуска бэкенда с проверкой пересечений при утверждении: иначе
 * закрытие подач отделов с такими дублями упрётся в 409.
 *
 * Запуск на сервере — рабочий каталог папка сайта (там production .env):
 *   cd /srv/sites/fot.su10.ru/fot-server
 *   NODE_ENV=production /opt/fot-build/fot-server/node_modules/.bin/tsx \
 *     /opt/fot-build/fot-server/scripts/recall-self-personal-duplicates.ts --month=2026-09
 *
 * Флаги:
 *   --month=YYYY-MM   месяц (обязателен);
 *   --yes             снять (без него — только отчёт);
 *   --only=1781,1828  только указанные подачи.
 */
import { closeDb } from '../src/config/postgres.js';
import { toMonthStart } from '../src/services/timesheet-export-mode.service.js';
import {
  listSelfPersonalDuplicates,
  listStaleSelfSubmissions,
  recallSelfPersonalDuplicate,
  recallStaleSelfSubmission,
} from '../src/services/timesheet-self-personal-duplicate.service.js';

const APPLY = process.argv.includes('--yes');
const monthArg = process.argv.find(arg => arg.startsWith('--month='))?.slice('--month='.length) ?? '';
const ONLY = (() => {
  const arg = process.argv.find(item => item.startsWith('--only='));
  if (!arg) return null;
  const ids = arg.slice('--only='.length).split(',').map(Number).filter(id => Number.isSafeInteger(id) && id > 0);
  return ids.length > 0 ? ids : null;
})();

const main = async (): Promise<void> => {
  const month = toMonthStart(monthArg);
  if (!month) throw new Error('Укажите --month=YYYY-MM');

  const duplicates = await listSelfPersonalDuplicates(month, ONLY);
  const stale = await listStaleSelfSubmissions(month, ONLY);
  const auto = duplicates.filter(item => item.manualReason === null);
  const manual = duplicates.filter(item => item.manualReason !== null);
  const hours = auto.reduce((sum, item) => sum + item.hours, 0);
  console.log(
    `${APPLY ? '' : '[отчёт] '}месяц ${month}: дублей строки руководителя ${duplicates.length}, `
    + `снимаются ${auto.length} (${Math.round(hours * 100) / 100} ч), вручную ${manual.length}`,
  );
  for (const item of duplicates) {
    console.log(
      `  подача ${item.approvalId} (${item.startDate}..${item.endDate}) ${item.fullName ?? item.managerEmployeeId}: `
      + `${item.days} дн., ${item.hours} ч, остаётся в ${item.keptInApprovalIds.join(', ')}`
      + (item.manualReason ? ` — ВРУЧНУЮ: ${item.manualReason}` : ''),
    );
  }
  console.log(`${APPLY ? '' : '[отчёт] '}поданных личных со строкой руководителя, которую подаёт отдел: ${stale.length}`);
  for (const item of stale) {
    console.log(`  подача ${item.approvalId} (${item.startDate}..${item.endDate}) ${item.fullName ?? item.managerEmployeeId}: в черновик, строку подаст отдел`);
  }
  if (!APPLY) {
    console.log('В БД ничего не записано. Снять — с --yes.');
    return;
  }

  let recalled = 0;
  let failures = 0;
  for (const item of auto) {
    try {
      const result = await recallSelfPersonalDuplicate(item.approvalId);
      if (result.recalled) {
        recalled += 1;
        console.log(`  подача ${item.approvalId}: в черновик, строка остаётся в ${item.keptInApprovalIds.join(', ')}`);
      } else {
        const reason = result.duplicate?.manualReason ?? 'дубля уже нет или подача изменилась';
        console.log(`  подача ${item.approvalId}: без изменений (${reason})`);
      }
    } catch (error) {
      failures += 1;
      console.error(`  подача ${item.approvalId}: ошибка —`, error instanceof Error ? error.message : error);
    }
  }
  for (const item of stale) {
    try {
      const result = await recallStaleSelfSubmission(item.approvalId);
      if (result.recalled) {
        recalled += 1;
        console.log(`  подача ${item.approvalId}: в черновик, строку подаст отдел`);
      } else {
        console.log(`  подача ${item.approvalId}: без изменений (уже не подана или состав изменился)`);
      }
    } catch (error) {
      failures += 1;
      console.error(`  подача ${item.approvalId}: ошибка —`, error instanceof Error ? error.message : error);
    }
  }
  console.log(`Готово: снято ${recalled}, ошибок ${failures}.`);
  if (failures > 0) process.exitCode = 1;
};

main()
  .catch(error => {
    console.error('Чистка не выполнена:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => { void closeDb(); });
