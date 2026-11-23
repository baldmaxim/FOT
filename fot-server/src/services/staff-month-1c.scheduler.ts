import * as Sentry from '@sentry/node';

import { moscowTodayIso } from '../utils/date.utils.js';
import { refreshStaffMonth, STAFF_MONTH_FIRST } from './staff-month-1c.service.js';

/**
 * Фоновое обновление статусов выгрузки «сотрудников месяца» в ЗУП3 по половинам месяца (миграция 375) — для
 * «Зарплата → Расчёты».
 *
 * Прошлый и текущий месяц (по Москве). Тик через минуту после старта и дальше раз в 30 минут. Месяц пересобирается,
 * если сборки ещё не было (заполнение после деплоя), изменилась закрытая часть (закрыли или открыли табель) или после
 * последних 04:00 МСК он не собирался (живые дни текущего месяца, справочники). Отметка сборки — в БД
 * (staff_month_1c_half_builds): рестарт сервера месяц не пересобирает. Сборки — в общей очереди с запросами 1С, одна за раз.
 */
const TICK_INTERVAL_MS = 30 * 60_000;
const STARTUP_DELAY_MS = 60_000;
export const STAFF_MONTH_NIGHT_MSK_HOUR = 4;

let timer: ReturnType<typeof setInterval> | null = null;
let startupTimeout: ReturnType<typeof setTimeout> | null = null;
let runInFlight: Promise<void> | null = null;

/** Прошлый и текущий месяц по Москве (не раньше STAFF_MONTH_FIRST). Чистая функция. */
export const staffMonthRefreshMonths = (now: Date): string[] => {
  const current = moscowTodayIso(now).slice(0, 7);
  const [year, month] = current.split('-').map(Number);
  const previous = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
  return [previous, current].filter(item => item >= STAFF_MONTH_FIRST);
};

/** Последняя граница 04:00 МСК (= 01:00 UTC, в Москве нет перехода на летнее время) не позже now — ISO без долей. */
export const staffMonthNightSince = (now: Date): string => {
  const boundary = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), STAFF_MONTH_NIGHT_MSK_HOUR - 3));
  if (boundary.getTime() > now.getTime()) boundary.setUTCDate(boundary.getUTCDate() - 1);
  return `${boundary.toISOString().slice(0, 19)}Z`;
};

export async function runStaffMonthTick(now: Date = new Date()): Promise<void> {
  if (runInFlight) return runInFlight;
  const current = (async () => {
    try {
      for (const month of staffMonthRefreshMonths(now)) {
        const rebuilt = await refreshStaffMonth(month, staffMonthNightSince(now));
        if (rebuilt) console.log(`[staff-month-1c] ${month}: статусы выгрузки в ЗУП3 обновлены`);
      }
    } catch (error) {
      console.error('[staff-month-1c] ошибка обновления статусов:', error instanceof Error ? error.message : error);
      Sentry.captureException(error, { tags: { source: 'staff-month-1c-scheduler' } });
    } finally {
      runInFlight = null;
    }
  })();
  runInFlight = current;
  return current;
}

export function startStaffMonthScheduler(): void {
  if (timer || startupTimeout) return;
  console.log('[staff-month-1c] started (tick: 30m, night 04:00 MSK)');
  startupTimeout = setTimeout(() => {
    startupTimeout = null;
    void runStaffMonthTick();
  }, STARTUP_DELAY_MS);
  timer = setInterval(() => {
    void runStaffMonthTick();
  }, TICK_INTERVAL_MS);
}

export function stopStaffMonthScheduler(): void {
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[staff-month-1c] stopped');
  }
}
