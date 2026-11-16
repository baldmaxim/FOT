/**
 * Норма часов основ месяцев с окладом по часам (с ноября 2026) — новой revision (payroll-basis-norm-fix.service.ts).
 * Нужен, только если ноябрьские табели закрыли до выкатки бэкенда с нормой графика: проверка —
 * SELECT count(*) FROM timesheet_version_payroll_basis WHERE month >= '2026-11-01'.
 *
 * На время запуска не закрывать и не открывать табели, не править графики и производственный календарь: основа
 * пересобирается по графикам на сейчас. Порядок: сухой прогон → отчёт (JSON рядом) → --apply → снова сухой = 0.
 * Не построилась основа или норма хоть у одной строки — запись не делается, код выхода 1.
 *
 * Запуск: cd fot-server && npx tsx scripts/fix-payroll-basis-norm-minutes.ts                    — сухой прогон
 *         cd fot-server && npx tsx scripts/fix-payroll-basis-norm-minutes.ts --apply            — запись
 *         cd fot-server && npx tsx scripts/fix-payroll-basis-norm-minutes.ts --calendar [--apply] — откат к норме
 *                                                                               календаря (если откатываем бэкенд)
 */
import { writeFileSync } from 'node:fs';

import { closeDb } from '../src/config/postgres.js';
import { fixPayrollBasisNormMinutes } from '../src/services/payroll/payroll-basis-norm-fix.service.js';

const TAG = '[fix-payroll-basis-norm-minutes]';

const hours = (minutes: number | null): string => (minutes === null ? '—' : `${minutes / 60} ч`);

const main = async (): Promise<void> => {
  const apply = process.argv.includes('--apply');
  const mode = process.argv.includes('--calendar') ? 'calendar' : 'schedule';
  const result = await fixPayrollBasisNormMinutes({ apply, mode });
  const report = `payroll-basis-norm-fix-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(report, JSON.stringify(result, null, 2));
  console.log(`${TAG} ${apply ? 'ЗАПИСЬ' : 'сухой прогон'}, режим ${mode}: основ-кандидатов — ${result.candidates}`);
  for (const change of result.changes) {
    console.log(`${TAG}   ${change.fullName ?? change.employeeId}, ${change.month}, редакция ${change.versionId}: `
      + `${hours(change.before)} → ${hours(change.after)}; ${change.schedules.join('; ')}`);
  }
  for (const problem of result.problems) {
    console.error(`${TAG}   ОШИБКА: редакция ${problem.versionId}, сотрудник ${problem.employeeId ?? '—'}: ${problem.reason}`);
  }
  console.log(`${TAG} изменится основ: ${result.changes.length}; `
    + `${apply ? `записано revision: ${result.written}` : 'запись не делалась'}; отчёт: ${report}`);
  if (result.problems.length > 0) {
    console.error(`${TAG} есть ошибки — ничего не записано; исправить и запустить повторно`);
    process.exitCode = 1;
  }
};

main()
  .catch(error => {
    console.error(`${TAG} фатальная ошибка:`, error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
