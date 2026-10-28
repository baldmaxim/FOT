/**
 * Переработка в будни в сохранённой основе расчёта — новой revision (payroll-basis-overtime-fix.service.ts):
 * - без флага — порог не ниже 8 ч, и в предпраздничный день, а не сверх короткой пятницы графика: только уменьшение;
 * - --remote — «УУ» с правкой часов сверх порога: только добавление дней «УУ», уже бывших рабочими днями основы.
 * Повторный запуск — без эффекта. Ошибка хоть одной редакции — код выхода 1 (повтор доберёт). Порядок: деплой
 * бэкенда (новое правило для закрытий) → сухой прогон → --apply.
 *
 * Запуск: cd fot-server && npx tsx scripts/fix-payroll-basis-overtime.ts [--remote]          — сухой прогон
 *         cd fot-server && npx tsx scripts/fix-payroll-basis-overtime.ts [--remote] --apply  — запись
 */
import { closeDb } from '../src/config/postgres.js';
import { fixPayrollBasisOvertime, type IOvertimeFixSample } from '../src/services/payroll/payroll-basis-overtime-fix.service.js';

const TAG = '[fix-payroll-basis-overtime]';

/** Сверка «Бухгалтерии» за сентябрь: Абраменко, Коновалова, Марухина — дни поимённо. */
const SAMPLE_EMPLOYEE_IDS = new Set([71, 866, 1083]);

/**
 * «УУ» с правкой > 8 ч на проде 28.10: Разаханов Э. З., Гусев, Мазеева, Крячек, Одинцов, Могуев; Ващук — график 10 ч,
 * должен остаться без изменений.
 */
const REMOTE_SAMPLE_EMPLOYEE_IDS = new Set([1456, 2505, 1034, 910, 1331, 1163, 394]);

const formatSample = (sample: IOvertimeFixSample): string => (
  `${sample.fullName ?? sample.employeeId}, ${sample.month}, редакция ${sample.versionId}: `
  + `${JSON.stringify(sample.before)} → ${JSON.stringify(sample.after)}`
  + (sample.remoteDates ? ` (УУ с правкой: ${sample.remoteDates.join(', ')})` : '')
);

const main = async (): Promise<void> => {
  const apply = process.argv.includes('--apply');
  const mode = process.argv.includes('--remote') ? 'remote' : 'reduce';
  const result = await fixPayrollBasisOvertime({
    apply,
    mode,
    sampleEmployeeIds: mode === 'remote' ? REMOTE_SAMPLE_EMPLOYEE_IDS : SAMPLE_EMPLOYEE_IDS,
    onVersionError: (versionId, error) => console.error(`${TAG} редакция ${versionId}:`, (error as Error).message),
  });
  console.log(`${TAG} ${apply ? 'ЗАПИСЬ' : 'сухой прогон'}, режим ${mode}: основ-кандидатов — ${result.candidates}`);
  if (mode === 'remote') {
    for (const change of result.changes) console.log(`${TAG}   изменится: ${formatSample(change)}`);
  }
  const changedKeys = new Set(result.changes.map(change => `${change.versionId}|${change.employeeId}|${change.month}`));
  for (const sample of result.samples) {
    const unchanged = !changedKeys.has(`${sample.versionId}|${sample.employeeId}|${sample.month}`);
    if (mode === 'reduce' && unchanged) continue;
    console.log(`${TAG}   ${unchanged ? 'без изменений' : 'проверка'}: ${formatSample(sample)}`);
  }
  for (const month of result.months) {
    console.log(`${TAG} ${month.month}: основ ${month.rows}, людей ${month.people}, `
      + `переработка ${month.minutesBefore / 60} ч → ${month.minutesAfter / 60} ч`);
  }
  console.log(`${TAG} ${apply ? `записано revision: ${result.written}` : `будет записано revision: ${result.changed}`}, `
    + `ошибок: ${result.failedVersions.length}`);
  if (result.failedVersions.length > 0) {
    console.error(`${TAG} редакции с ошибкой: ${result.failedVersions.join(', ')} — исправить и запустить повторно`);
    process.exitCode = 1;
  }
};

main()
  .catch(error => {
    console.error(`${TAG} фатальная ошибка:`, error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
