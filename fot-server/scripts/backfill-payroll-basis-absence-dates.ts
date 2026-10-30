/**
 * Даты отсутствий в сохранённой основе расчёта — новой revision (payroll-basis-absence-dates.service.ts, миграция 339):
 * нужны дням «Квартиры» (630 ₽ × дни без отпуска и больничного). Только основы с отсутствиями и без дат; число дат
 * по статусам должно совпасть со счётчиками основы, иначе основа пропускается и печатается. Повторный запуск — без
 * эффекта. Ошибка хоть одной редакции — код выхода 1 (повтор доберёт). Порядок: 339 → сухой прогон → --apply → бэкенд.
 *
 * Запуск: cd fot-server && npx tsx scripts/backfill-payroll-basis-absence-dates.ts [--from 2026-09]          — сухой прогон
 *         cd fot-server && npx tsx scripts/backfill-payroll-basis-absence-dates.ts [--from 2026-09] --apply  — запись
 */
import { closeDb } from '../src/config/postgres.js';
import { backfillPayrollBasisAbsenceDates } from '../src/services/payroll/payroll-basis-absence-dates.service.js';

const TAG = '[backfill-payroll-basis-absence-dates]';

/** С сентября 2026 — «Квартира» заведена с 01.09.2026 (миграция 339). */
const DEFAULT_FROM = '2026-09';

const argValue = (name: string): string | null => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
};

const main = async (): Promise<void> => {
  const apply = process.argv.includes('--apply');
  const fromMonth = argValue('--from') ?? DEFAULT_FROM;
  if (!/^\d{4}-\d{2}$/.test(fromMonth)) throw new Error(`--from ждёт YYYY-MM, получено «${fromMonth}»`);
  const result = await backfillPayrollBasisAbsenceDates({
    apply,
    fromMonth,
    onVersionError: (versionId, error) => console.error(`${TAG} редакция ${versionId}:`, (error as Error).message),
  });
  console.log(`${TAG} ${apply ? 'ЗАПИСЬ' : 'сухой прогон'} с ${fromMonth}: основ-кандидатов — ${result.candidates}`);
  for (const skip of result.skipped) {
    console.log(`${TAG}   пропущена: ${skip.fullName ?? skip.employeeId}, ${skip.month}, редакция ${skip.versionId}: `
      + `счётчики ${JSON.stringify(skip.stored)}, пересборка ${skip.rebuilt ? JSON.stringify(skip.rebuilt) : 'нет основы'}`);
  }
  console.log(`${TAG} ${apply ? `записано revision: ${result.written}` : `будет записано revision: ${result.matched}`}, `
    + `пропущено: ${result.skipped.length}, ошибок: ${result.failedVersions.length}`);
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
