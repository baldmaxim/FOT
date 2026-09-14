import * as Sentry from '@sentry/node';
import { runWithCronMonitor, type CronRunStatus } from '../utils/sentry-cron.js';
import {
  loadLatestSnapshotRun,
  rebuildMainObjectSnapshot,
  resolveSnapshotPeriod,
  type ISnapshotRun,
} from './employee-main-object-snapshot.service.js';

/**
 * Ночной пересчёт снимка «основного объекта» (миграция 277).
 *
 * Тик раз в 15 минут. Пересчёт нужен, когда в снимке нет вчерашнего дня. Запускается
 * только с 03:00 МСК — после ночной подгрузки СКУД и не в рабочий пик сразу после
 * деплоя. Исключение — снимка нет вовсе (первое заполнение): тогда сразу, иначе до
 * ночи Excel и столбец «Объект» считали бы на лету.
 *
 * Простой или рестарт догоняются сами: следующий тик после 03:00 увидит устаревший снимок.
 */
const TICK_INTERVAL_MS = 15 * 60_000;
const STARTUP_DELAY_MS = 120_000;
export const SNAPSHOT_EARLIEST_MSK_HOUR = 3;

/** После сбоя не повторяем чаще раза в час: пересчёт тяжёлый, а ошибка может быть стойкой. */
export const SNAPSHOT_RETRY_AFTER_FAILURE_MS = 60 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let startupTimeout: ReturnType<typeof setTimeout> | null = null;
let runInFlight: Promise<void> | null = null;
let lastFailureAt = 0;

/** Для тестов: сбросить память о последнем сбое. */
export function resetMainObjectSnapshotSchedulerState(): void {
  lastFailureAt = 0;
}

const moscowHour = (now: Date): number =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', hour12: false }).format(now)) % 24;

/** Нужен ли пересчёт сейчас. Чистая функция — решение планировщика покрыто тестами. */
export function shouldRebuildSnapshot(latest: ISnapshotRun | null, now: Date): boolean {
  if (!latest) return true;
  const target = resolveSnapshotPeriod(now);
  if (latest.period.end >= target.end) return false;
  return moscowHour(now) >= SNAPSHOT_EARLIEST_MSK_HOUR;
}

export async function runMainObjectSnapshotTick(now: Date = new Date()): Promise<void> {
  if (runInFlight) return runInFlight;
  // Проверка паузы — ДО создания промиса: синхронный return внутри async-функции выполнил
  // бы finally (runInFlight = null) раньше присваивания, и флаг «идёт расчёт» залип бы.
  if (lastFailureAt && now.getTime() - lastFailureAt < SNAPSHOT_RETRY_AFTER_FAILURE_MS) return;

  const current: Promise<void> = (async () => {
    try {
      const latest = await loadLatestSnapshotRun();
      if (!shouldRebuildSnapshot(latest, now)) return;

      await runWithCronMonitor(
        'employee-main-object-snapshot',
        async (): Promise<CronRunStatus> => {
          try {
            const result = await rebuildMainObjectSnapshot({ now });
            lastFailureAt = 0;
            console.log(
              `[main-object-snapshot] ${result.period.start}..${result.period.end}: `
              + `сотрудников ${result.employees}, с объектом ${result.withObject}, ${result.durationMs} мс`,
            );
            return 'ok';
          } catch (error) {
            lastFailureAt = now.getTime();
            console.error('[main-object-snapshot] ошибка пересчёта:', error instanceof Error ? error.message : error);
            Sentry.captureException(error, { tags: { source: 'employee-main-object-snapshot' } });
            return 'error';
          }
        },
        {
          schedule: { type: 'interval', value: 1, unit: 'day' },
          checkinMargin: 60,
          maxRuntime: 20,
        },
      );
    } catch (error) {
      // Сбой чтения журнала: пробуем на следующем тике, процесс не роняем.
      console.error('[main-object-snapshot] ошибка тика:', error instanceof Error ? error.message : error);
      Sentry.captureException(error, { tags: { source: 'employee-main-object-snapshot' } });
    } finally {
      // Промис уже записан в runInFlight: до этой строки в теле всегда был await.
      runInFlight = null;
    }
  })();
  runInFlight = current;

  return current;
}

export function startMainObjectSnapshotScheduler(): void {
  if (timer || startupTimeout) return;
  console.log('[main-object-snapshot] started (tick: 15m, earliest 03:00 MSK)');
  startupTimeout = setTimeout(() => {
    startupTimeout = null;
    void runMainObjectSnapshotTick();
  }, STARTUP_DELAY_MS);
  timer = setInterval(() => {
    void runMainObjectSnapshotTick();
  }, TICK_INTERVAL_MS);
}

export function stopMainObjectSnapshotScheduler(): void {
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[main-object-snapshot] stopped');
  }
}
