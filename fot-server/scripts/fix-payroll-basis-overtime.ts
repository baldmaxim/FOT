/**
 * Переработка в будни в сохранённой основе расчёта — по порогу не ниже 8 ч (предпраздничный 7 ч), а не сверх короткой
 * пятницы графика: новой revision, только уменьшение (payroll-basis-overtime-fix.service.ts). Повторный запуск — без
 * эффекта. Порядок: деплой бэкенда (новое правило для закрытий) → сухой прогон → --apply.
 *
 * Запуск: cd fot-server && npx tsx scripts/fix-payroll-basis-overtime.ts          — сухой прогон
 *         cd fot-server && npx tsx scripts/fix-payroll-basis-overtime.ts --apply  — запись
 */
import { closeDb } from '../src/config/postgres.js';
import { fixPayrollBasisOvertime } from '../src/services/payroll/payroll-basis-overtime-fix.service.js';

const TAG = '[fix-payroll-basis-overtime]';

/** Сверка «Бухгалтерии» за сентябрь: Абраменко, Коновалова, Марухина — дни поимённо. */
const SAMPLE_EMPLOYEE_IDS = new Set([71, 866, 1083]);

const main = async (): Promise<void> => {
  const apply = process.argv.includes('--apply');
  const result = await fixPayrollBasisOvertime({
    apply,
    sampleEmployeeIds: SAMPLE_EMPLOYEE_IDS,
    onVersionError: (versionId, error) => console.error(`${TAG} редакция ${versionId}:`, (error as Error).message),
  });
  console.log(`${TAG} ${apply ? 'ЗАПИСЬ' : 'сухой прогон'}: основ с переработкой — ${result.candidates}`);
  for (const sample of result.samples) {
    console.log(`${TAG}   ${sample.fullName ?? sample.employeeId}, ${sample.month}, редакция ${sample.versionId}: `
      + `${JSON.stringify(sample.before)} → ${JSON.stringify(sample.after)}`);
  }
  for (const month of result.months) {
    console.log(`${TAG} ${month.month}: основ ${month.rows}, людей ${month.people}, `
      + `переработка ${month.minutesBefore / 60} ч → ${month.minutesAfter / 60} ч`);
  }
  console.log(`${TAG} ${apply ? `записано revision: ${result.written}` : `будет записано revision: ${result.changed}`}, `
    + `ошибок: ${result.failedVersions.length}`);
};

main()
  .catch(error => {
    console.error(`${TAG} фатальная ошибка:`, error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
