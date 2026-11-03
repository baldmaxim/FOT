/**
 * Минуты к оплате в сохранённой основе расчёта — новой revision (payroll-basis-paid-minutes.service.ts, миграция 344):
 * нужны почасовой ставке, назначенной на уже закрытый месяц. Даты, норма и суммы окладников не меняются. Повторный
 * запуск — без эффекта. Ошибка хоть одной редакции — код выхода 1 (повтор доберёт).
 * Порядок: 344 → бэкенд → сухой прогон → --apply.
 *
 * Запуск: cd fot-server && npx tsx scripts/backfill-payroll-basis-paid-minutes.ts [--from 2026-05]          — сухой прогон
 *         cd fot-server && npx tsx scripts/backfill-payroll-basis-paid-minutes.ts [--from 2026-05] --apply  — запись
 */
import { closeDb } from '../src/config/postgres.js';
import { backfillPayrollBasisPaidMinutes } from '../src/services/payroll/payroll-basis-paid-minutes.service.js';

const TAG = '[backfill-payroll-basis-paid-minutes]';

/** С мая 2026 — с него есть основы расчёта (backfill-payroll-basis.ts). */
const DEFAULT_FROM = '2026-05';

const argValue = (name: string): string | null => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
};

const main = async (): Promise<void> => {
  const apply = process.argv.includes('--apply');
  const fromMonth = argValue('--from') ?? DEFAULT_FROM;
  if (!/^\d{4}-\d{2}$/.test(fromMonth)) throw new Error(`--from ждёт YYYY-MM, получено «${fromMonth}»`);
  const result = await backfillPayrollBasisPaidMinutes({
    apply,
    fromMonth,
    onVersionError: (versionId, error) => console.error(`${TAG} редакция ${versionId}:`, (error as Error).message),
  });
  console.log(`${TAG} ${apply ? 'ЗАПИСЬ' : 'сухой прогон'} с ${fromMonth}: основ-кандидатов — ${result.candidates}`);
  console.log(`${TAG} ${apply ? `записано revision: ${result.written}` : `будет записано revision: ${result.matched}`}, `
    + `основ с датами без минут: ${result.uncovered}, ошибок: ${result.failedVersions.length}`);
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
