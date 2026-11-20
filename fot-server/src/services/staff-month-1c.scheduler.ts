import * as Sentry from '@sentry/node';

import { moscowTodayIso } from '../utils/date.utils.js';
import { refreshStaffMonth, STAFF_MONTH_FIRST } from './staff-month-1c.service.js';

/**
 * Фоновое обновление статусов выгрузки «сотрудников месяца» в ЗУП3 (миграция 373) — для «Зарплата → Расчёты».
 *
 * Прошлый и текущий месяц (по Москве). Первый прогон — через минуту после старта (заполнение после деплоя), дальше
 * тик раз в 30 минут: изменилась закрытая часть месяца (закрыли или открыли табель) — пересборка снимка и запись
 * состояний. Раз в сутки с 04:00 МСК — пересборка обязательно (живые дни текущего месяца, справочники). Сборки идут
 * в общей очереди с запросами 1С — одна за раз.
 */
const TICK_INTERVAL_MS = 30 * 60_000;
const STARTUP_DELAY_MS = 60_000;
export const STAFF_MONTH_NIGHT_MSK_HOUR = 4;

let timer: ReturnType<typeof setInterval> | null = null;
let startupTimeout: ReturnType<typeof setTimeout> | null = null;
let runInFlight: Promise<void> | null = null;
let lastNightRun: string | null = null;
let firstRunDone = false;

const moscowHour = (now: Date): number =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', hour12: false }).format(now)) % 24;

/** Прошлый и текущий месяц по Москве (не раньше STAFF_MONTH_FIRST). Чистая функция. */
export const staffMonthRefreshMonths = (now: Date): string[] => {
  const current = moscowTodayIso(now).slice(0, 7);
  const [year, month] = current.split('-').map(Number);
  const previous = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
  return [previous, current].filter(item => item >= STAFF_MONTH_FIRST);
};

/** Ночной обязательный прогон: с 04:00 МСК, раз в сутки. Чистая функция. */
export const isStaffMonthNightRun = (now: Date, lastNight: string | null): boolean => (
  moscowHour(now) >= STAFF_MONTH_NIGHT_MSK_HOUR && lastNight !== moscowTodayIso(now)
);

export async function runStaffMonthTick(now: Date = new Date()): Promise<void> {
  if (runInFlight) return runInFlight;
  const current = (async () => {
    const night = isStaffMonthNightRun(now, lastNightRun);
    const force = night || !firstRunDone;
    try {
      for (const month of staffMonthRefreshMonths(now)) {
        const rebuilt = await refreshStaffMonth(month, force);
        if (rebuilt) console.log(`[staff-month-1c] ${month}: статусы выгрузки в ЗУП3 обновлены${force ? ' (плановая сборка)' : ''}`);
      }
      firstRunDone = true;
      if (night) lastNightRun = moscowTodayIso(now);
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
