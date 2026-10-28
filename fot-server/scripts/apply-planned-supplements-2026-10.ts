/**
 * Плановые («штатные») доплаты — по таблице «Доплата штатная» из 1С, присланной 28.10.2026
 * (payroll-planned-supplements-sync.service.ts). Сотрудники вне таблицы с доплатой в журнале (Власов, Казаков,
 * Сапожникова) — снять: в ЗУП за июль–август доплату им не начисляли; у Беляковой прежние 25 000 так же заменяются.
 * Корж: обе строки таблицы действуют вместе — 20 000 с 01.03.2023 и 10 000 на 01.10.2026–31.01.2027, то есть
 * 30 000 на эти месяцы.
 *
 * Запуск (на сервере — из каталога сайта, где .env):
 *   npx tsx scripts/apply-planned-supplements-2026-10.ts          — сухой прогон (пишет и откатывает)
 *   npx tsx scripts/apply-planned-supplements-2026-10.ts --apply  — запись
 */
import { closeDb } from '../src/config/postgres.js';
import {
  syncPlannedSupplements,
  type IPlannedSupplementTarget,
} from '../src/services/payroll/payroll-planned-supplements-sync.service.js';
import type { IPlannedSupplementValue } from '../src/services/payroll/payroll-terms.service.js';

const TAG = '[apply-planned-supplements]';

const p = (amount: number, dateFrom: string, dateTo: string | null = null): IPlannedSupplementValue => ({ amount, dateFrom, dateTo });

const TARGETS: IPlannedSupplementTarget[] = [
  { employeeId: 1665, fullName: 'Смитская Юлия Александровна', periods: [p(20000, '2023-01-01')] },
  { employeeId: 247, fullName: 'Барулин Илья Андреевич', periods: [p(20000, '2023-02-01')] },
  {
    employeeId: 874,
    fullName: 'Корж Илья Семенович',
    periods: [p(20000, '2023-03-01', '2026-09-30'), p(30000, '2026-10-01', '2027-01-31'), p(20000, '2027-02-01')],
  },
  { employeeId: 1392, fullName: 'Пахомова Василина Валерьевна', periods: [p(30000, '2025-06-30')] },
  { employeeId: 875, fullName: 'Коржуков Дмитрий Александрович', periods: [p(60000, '2026-01-01', '2026-09-30')] },
  { employeeId: 891, fullName: 'Кравец Данил Александрович', periods: [p(60000, '2026-01-01', '2026-09-30')] },
  { employeeId: 2140, fullName: 'Шиляков Алексей Владимирович', periods: [p(50000, '2026-05-01', '2026-12-31')] },
  { employeeId: 753, fullName: 'Калязин Сергей Александрович', periods: [p(50000, '2026-05-01', '2026-12-31')] },
  { employeeId: 1515, fullName: 'Ротару Иван Захарович', periods: [p(30000, '2026-10-01', '2026-12-01')] },
  { employeeId: 284, fullName: 'Белякова Надежда Владимировна', periods: [p(10000, '2026-10-01', '2027-01-31')] },
  { employeeId: 368, fullName: 'Бурлаку Кристина Александровна', periods: [p(10000, '2026-10-01', '2027-01-31')] },
  { employeeId: 1491, fullName: 'Рацкевич Светлана Юрьевна', periods: [p(20000, '2026-10-01', '2027-01-31')] },
  // Уволена 14.10.2026 — по день увольнения.
  { employeeId: 408, fullName: 'Воронцова Наталья Алексеевна', periods: [p(10000, '2026-06-01', '2026-10-14')] },
  { employeeId: 403, fullName: 'Власов Алексей Николаевич', periods: [] },
  { employeeId: 738, fullName: 'Казаков Евгений Игоревич', periods: [] },
  { employeeId: 1594, fullName: 'Сапожникова Ксения Викторовна', periods: [] },
];

const formatPeriods = (periods: readonly IPlannedSupplementValue[]): string => (
  periods.length === 0
    ? 'нет'
    : periods.map(period => `${period.amount} с ${period.dateFrom}${period.dateTo ? ` по ${period.dateTo}` : ''}`).join('; ')
);

const main = async (): Promise<void> => {
  const apply = process.argv.includes('--apply');
  const items = await syncPlannedSupplements(TARGETS, { apply });
  console.log(`${TAG} ${apply ? 'ЗАПИСЬ' : 'сухой прогон (записано и откатано)'}: сотрудников ${items.length}`);
  for (const item of items) {
    console.log(item.status === 'same'
      ? `${TAG}   ${item.fullName}: как в таблице — ${formatPeriods(item.after)}`
      : `${TAG}   ${item.fullName}: ${formatPeriods(item.before)} → ${formatPeriods(item.after)}`);
  }
  const changed = items.filter(item => item.status === 'changed').length;
  console.log(`${TAG} ${apply ? 'изменено' : 'будет изменено'}: ${changed}, без изменений: ${items.length - changed}`);
};

main()
  .catch(error => {
    console.error(`${TAG} ошибка, ничего не записано:`, error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
