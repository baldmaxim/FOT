import * as Sentry from '@sentry/node';
import { moscowTodayIso } from '../utils/date.utils.js';
import { runWithCronMonitor, type CronRunStatus } from '../utils/sentry-cron.js';
import { moscowHour, nextMonthStart } from './timesheet-export-mode.service.js';
import {
  previousMonthStartMsk,
  readTimesheetObjectState,
  type ITimesheetObjectAutoState,
} from './employee-timesheet-object.service.js';
import { freezeMonth, recomputeCurrentMonth } from './employee-timesheet-object-auto.service.js';
import { rebuildVersionObjectsForMonth } from './timesheet-version-objects-rebuild.service.js';
import { query } from '../config/postgres.js';

/**
 * Ночной расчёт объекта табелирования (миграция 288).
 *
 * Тик раз в 15 минут, работа — с 04:00 МСК (после ночной подгрузки СКУД), только
 * когда расчёт включён скриптом активации. Решения — по состоянию в БД, поэтому
 * простой и рестарт догоняются сами:
 *   1. пока прошлый месяц не зафиксирован — фиксация следующего месяца по порядку;
 *   2. пока пересборка отстаёт от фиксации — пересборка объектов редакций месяца;
 *   3. сегодня не 1-е и расчёт за сегодня не сделан — пересчёт с 1-го числа по вчера.
 */
const TICK_INTERVAL_MS = 15 * 60_000;
const STARTUP_DELAY_MS = 180_000;
export const TIMESHEET_OBJECT_EARLIEST_MSK_HOUR = 4;
/** К этому часу 1-го числа прошлый месяц уже должен быть зафиксирован. */
export const TIMESHEET_OBJECT_FREEZE_DEADLINE_MSK_HOUR = 6;
/** После сбоя не повторяем чаще: расчёт тяжёлый, ошибка может быть стойкой. */
export const TIMESHEET_OBJECT_RETRY_AFTER_FAILURE_MS = 30 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let startupTimeout: ReturnType<typeof setTimeout> | null = null;
let runInFlight: Promise<void> | null = null;
let lastFailureAt = 0;

/** Для тестов. */
export function resetTimesheetObjectSchedulerState(): void {
  lastFailureAt = 0;
}

export type TimesheetObjectStep =
  | { kind: 'freeze'; month: string }
  | { kind: 'rebuild'; month: string }
  | { kind: 'recompute' }
  | { kind: 'idle' };

/**
 * Следующий шаг по состоянию — чистая функция, решение покрыто тестами.
 * skipRebuild — пересборка в этом проходе уже сбоила: не блокируем ею пересчёт
 * текущего месяца, повторим её на следующем тике.
 */
export function nextTimesheetObjectStep(
  state: ITimesheetObjectAutoState | null,
  now: Date,
  options: { skipRebuild?: boolean } = {},
): TimesheetObjectStep {
  if (!state?.enabled) return { kind: 'idle' };
  if (moscowHour(now) < TIMESHEET_OBJECT_EARLIEST_MSK_HOUR) return { kind: 'idle' };
  if (state.frozen_month < previousMonthStartMsk(now)) {
    return { kind: 'freeze', month: nextMonthStart(state.frozen_month) };
  }
  if (!options.skipRebuild && state.objects_rebuilt_month < state.frozen_month) {
    return { kind: 'rebuild', month: nextMonthStart(state.objects_rebuilt_month) };
  }
  const today = moscowTodayIso(now);
  if (!today.endsWith('-01') && (!state.applied_date || state.applied_date < today)) {
    return { kind: 'recompute' };
  }
  return { kind: 'idle' };
}

async function markRebuilt(month: string): Promise<void> {
  await query(
    `UPDATE timesheet_object_auto_state
        SET objects_rebuilt_month = GREATEST(objects_rebuilt_month, $1::date), updated_at = now()
      WHERE singleton`,
    [month],
  );
}

/** Прошлый месяц не зафиксирован к 06:00 1-го числа — отдельный сигнал. */
function reportLateFreeze(state: ITimesheetObjectAutoState | null, now: Date): void {
  if (!state?.enabled) return;
  if (state.frozen_month >= previousMonthStartMsk(now)) return;
  if (moscowTodayIso(now).endsWith('-01') && moscowHour(now) < TIMESHEET_OBJECT_FREEZE_DEADLINE_MSK_HOUR) return;
  Sentry.captureMessage('timesheet_object_freeze_late', {
    level: 'warning',
    tags: { source: 'employee-timesheet-object' },
    extra: { frozen_month: state.frozen_month, expected: previousMonthStartMsk(now) },
  });
}

/**
 * Один проход: шаги до idle. Максимум шагов ограничен, чтобы при ошибке в решении
 * тик не крутился бесконечно.
 */
async function runSteps(now: Date): Promise<CronRunStatus> {
  let status: CronRunStatus = 'ok';
  let skipRebuild = false;
  for (let guard = 0; guard < 36; guard += 1) {
    const state = await readTimesheetObjectState();
    const step = nextTimesheetObjectStep(state, now, { skipRebuild });
    if (step.kind === 'idle') return status;

    if (step.kind === 'freeze') {
      const result = await freezeMonth(step.month, now);
      console.log(`[timesheet-object] фиксация ${step.month}: ${JSON.stringify(result)}`);
      if (result.kind === 'skipped') return status;
      continue;
    }
    if (step.kind === 'rebuild') {
      const result = await rebuildVersionObjectsForMonth(step.month);
      console.log(
        `[timesheet-object] пересборка объектов ${step.month}: подач ${result.approvals}, `
        + `новых редакций ${result.created}, сбоев ${result.failures}`,
      );
      if (result.failures > 0) {
        // Месяц не сдвигаем — повтор на следующем тике (пересборка идемпотентна), а
        // пересчёт текущего месяца ею не блокируем.
        status = 'error';
        skipRebuild = true;
        continue;
      }
      await markRebuilt(step.month);
      continue;
    }
    const result = await recomputeCurrentMonth(now);
    console.log(`[timesheet-object] пересчёт текущего месяца: ${JSON.stringify(result)}`);
    return status;
  }
  return status;
}

export async function runTimesheetObjectTick(now: Date = new Date()): Promise<void> {
  if (runInFlight) return runInFlight;
  if (lastFailureAt && now.getTime() - lastFailureAt < TIMESHEET_OBJECT_RETRY_AFTER_FAILURE_MS) return;

  const current: Promise<void> = (async () => {
    try {
      let state: ITimesheetObjectAutoState | null;
      try {
        state = await readTimesheetObjectState();
      } catch (error) {
        // Миграция 288 не применена — расчёт выключен, а не сломан.
        if ((error as { code?: string } | null)?.code === '42P01') return;
        throw error;
      }
      if (nextTimesheetObjectStep(state, now).kind === 'idle') return;

      await runWithCronMonitor(
        'employee-timesheet-object',
        async (): Promise<CronRunStatus> => {
          try {
            const status = await runSteps(now);
            if (status === 'ok') lastFailureAt = 0;
            else lastFailureAt = now.getTime();
            return status;
          } catch (error) {
            lastFailureAt = now.getTime();
            console.error('[timesheet-object] ошибка расчёта:', error instanceof Error ? error.message : error);
            Sentry.captureException(error, { tags: { source: 'employee-timesheet-object' } });
            reportLateFreeze(await readTimesheetObjectState().catch(() => null), now);
            return 'error';
          }
        },
        {
          schedule: { type: 'interval', value: 1, unit: 'day' },
          checkinMargin: 60,
          maxRuntime: 30,
        },
      );
    } catch (error) {
      console.error('[timesheet-object] ошибка тика:', error instanceof Error ? error.message : error);
      Sentry.captureException(error, { tags: { source: 'employee-timesheet-object' } });
    } finally {
      runInFlight = null;
    }
  })();
  runInFlight = current;

  return current;
}

export function startTimesheetObjectScheduler(): void {
  if (timer || startupTimeout) return;
  console.log('[timesheet-object] started (tick: 15m, earliest 04:00 MSK)');
  startupTimeout = setTimeout(() => {
    startupTimeout = null;
    void runTimesheetObjectTick();
  }, STARTUP_DELAY_MS);
  timer = setInterval(() => {
    void runTimesheetObjectTick();
  }, TICK_INTERVAL_MS);
}

export function stopTimesheetObjectScheduler(): void {
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[timesheet-object] stopped');
  }
}
