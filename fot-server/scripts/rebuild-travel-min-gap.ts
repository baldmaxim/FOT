/**
 * Одноразовый скрипт: пересчёт «дороги» (skud_travel_segments) после введения
 * нижнего порога MIN_TRAVEL_GAP_MINUTES (короткие переходы ≤10 мин больше не считаются
 * дорогой, см. skud-travel.service.ts). Перегенерирует авто-сегменты за указанные месяцы;
 * ранее принятые вручную решения (approved/rejected/pending) сохраняются
 * (mergeDecidedIntoSegments). После пересчёта hours_worked в табеле/ЛК перестаёт включать
 * мнимую дорогу от перемещений между соседними офисами.
 *
 * skud_daily_summary трогать не нужно — дорога прибавляется на чтении из travel-сегментов.
 *
 * Запуск (пользователь сам, против прод-БД):
 *   cd fot-server && npx tsx scripts/rebuild-travel-min-gap.ts            # последние 3 месяца
 *   cd fot-server && npx tsx scripts/rebuild-travel-min-gap.ts --months=6
 *   cd fot-server && npx tsx scripts/rebuild-travel-min-gap.ts --month=2026-05
 *   cd fot-server && npx tsx scripts/rebuild-travel-min-gap.ts --month=2026-05 --employee=573
 * Идемпотентен.
 */
import { rebuildTravelSegmentsForScope } from '../src/services/skud-travel.service.js';

const DEFAULT_MONTHS = 3;

const pad2 = (n: number): string => String(n).padStart(2, '0');

const parseArg = (name: string): string | null => {
  const prefix = `--${name}=`;
  const arg = process.argv.find(item => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
};

const buildMonthKeys = (): string[] => {
  const single = parseArg('month');
  if (single) {
    if (!/^\d{4}-\d{2}$/.test(single)) {
      throw new Error(`Некорректный --month=${single}, ожидаю YYYY-MM`);
    }
    return [single];
  }
  const monthsArg = Number(parseArg('months'));
  const months = Number.isFinite(monthsArg) && monthsArg > 0 ? Math.floor(monthsArg) : DEFAULT_MONTHS;
  const now = new Date();
  const keys: string[] = [];
  for (let offset = months - 1; offset >= 0; offset -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    keys.push(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`);
  }
  return keys;
};

const main = async (): Promise<void> => {
  const employeeArg = parseArg('employee');
  const employeeId = employeeArg ? Number(employeeArg) : null;
  if (employeeArg && (!Number.isFinite(employeeId) || employeeId! <= 0)) {
    throw new Error(`Некорректный --employee=${employeeArg}`);
  }

  const monthKeys = buildMonthKeys();
  console.log(`[travel-rebuild] месяцы: ${monthKeys.join(', ')}${employeeId ? `, сотрудник ${employeeId}` : ' (все активные сотрудники)'}`);

  let totalSegments = 0;
  for (const month of monthKeys) {
    try {
      const { segmentCount, employeeCount } = await rebuildTravelSegmentsForScope({
        month,
        departmentId: null,
        employeeId,
      });
      totalSegments += segmentCount;
      console.log(`[travel-rebuild] ${month}: сегментов ${segmentCount}, сотрудников ${employeeCount}`);
    } catch (err) {
      console.error(`[travel-rebuild] ${month} упал:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`[travel-rebuild] готово: всего сегментов после пересчёта ${totalSegments}`);
};

main().catch(err => {
  console.error('[travel-rebuild] фатальная ошибка:', err);
  process.exit(1);
});
