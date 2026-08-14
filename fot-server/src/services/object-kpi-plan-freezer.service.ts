import { withTransaction } from '../config/postgres.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import { runWithCronMonitor, type CronRunStatus } from '../utils/sentry-cron.js';
import { fixMonthPlan, listObjectsWithoutCurrentPlan } from './object-kpi-plan.service.js';
import { settingsService } from './settings.service.js';
import { getNthWorkingDay } from './object-kpi-working-days.service.js';

/**
 * Автоматическая фиксация месячного плана (п. 2.8).
 *
 * Ручная кнопка не может быть единственным механизмом: если экономист не нажмёт
 * «Зафиксировать», исторический план продолжит плыть от новых ДС, актов КС-2 и правок
 * плановой даты ЗОС — и премия за закрытый месяц окажется невоспроизводимой.
 *
 * Джоба выключена по умолчанию (kill-switch в system_settings): включается последней,
 * после сверки первого месяца данных с Excel. Выключатель заодно защищает локальную
 * разработку — там БД подключена read-only, и без него тик падал бы каждый час.
 */

const TICK_INTERVAL_MS = 60 * 60_000;
const STARTUP_DELAY_MS = 60_000;

const SETTING_ENABLED = 'object_kpi_freezer_enabled';
const SETTING_WORKING_DAY = 'object_kpi_fix_working_day';
const SETTING_DATE_OVERRIDE = 'object_kpi_fix_date_override';

/** Приказ говорит «3-й рабочий день», рабочее решение — 5-й (меняется без релиза). */
const DEFAULT_FIX_WORKING_DAY = 5;

let tickTimer: ReturnType<typeof setInterval> | null = null;
let startupTimeout: ReturnType<typeof setTimeout> | null = null;
let runInFlight: Promise<void> | null = null;

export interface ObjectKpiFreezerConfig {
  enabled: boolean;
  fixWorkingDay: number;
  /** Явная дата фиксации на конкретный месяц — аварийный переключатель без релиза. */
  fixDateOverride: string | null;
}

export async function getFreezerConfig(): Promise<ObjectKpiFreezerConfig> {
  const values = await settingsService.getMultiple([
    SETTING_ENABLED,
    SETTING_WORKING_DAY,
    SETTING_DATE_OVERRIDE,
  ]);

  const parsedDay = Number.parseInt(values[SETTING_WORKING_DAY] ?? '', 10);
  return {
    // Именно `=== 'true'`, а не «не false»: отсутствие ключа обязано читаться как «выключено».
    enabled: values[SETTING_ENABLED] === 'true',
    fixWorkingDay: Number.isFinite(parsedDay) && parsedDay >= 1 ? parsedDay : DEFAULT_FIX_WORKING_DAY,
    fixDateOverride: values[SETTING_DATE_OVERRIDE] || null,
  };
}

/**
 * Дата, начиная с которой план месяца фиксируется. Показывается на вкладке заранее
 * («план будет зафиксирован 12.09»), чтобы расхождение с производственным календарём
 * заметил человек, а не бухгалтерия постфактум.
 */
export async function resolveFixationDate(
  periodMonth: string,
  config?: ObjectKpiFreezerConfig,
): Promise<string | null> {
  const settings = config ?? (await getFreezerConfig());
  const [year, month] = periodMonth.split('-').map(Number);

  if (settings.fixDateOverride?.startsWith(periodMonth.slice(0, 7))) {
    return settings.fixDateOverride;
  }
  return getNthWorkingDay(year, month, settings.fixWorkingDay);
}

/**
 * Один прогон фиксации. Экспортируется отдельно от таймера: контроллеру нужна
 * кнопка «выполнить сейчас», а тестам — вызов без планировщика.
 *
 * Каждый объект фиксируется своей транзакцией: упавший объект не должен утаскивать
 * за собой уже зафиксированные.
 */
export async function runPlanFreezerOnce(options: { force?: boolean } = {}): Promise<{
  period_month: string;
  fixation_date: string | null;
  fixed: number;
  skipped: number;
  failed: number;
}> {
  const today = moscowTodayIso();
  const periodMonth = `${today.slice(0, 7)}-01`;
  const config = await getFreezerConfig();
  const fixationDate = await resolveFixationDate(periodMonth, config);

  const summary = { period_month: periodMonth, fixation_date: fixationDate, fixed: 0, skipped: 0, failed: 0 };

  // Срок неизвестен (месяца нет в производственном календаре) — не фиксируем.
  // Молчаливая фиксация «на всякий случай» закрыла бы месяц не в тот день.
  if (!options.force && (!fixationDate || today < fixationDate)) return summary;

  const objectIds = await listObjectsWithoutCurrentPlan(periodMonth);
  const actor = { userId: null, userName: 'Автофиксация плана' };

  for (const objectId of objectIds) {
    try {
      const row = await withTransaction((client) =>
        fixMonthPlan(client, actor, objectId, periodMonth, 'auto'),
      );
      if (row) summary.fixed += 1;
      else summary.skipped += 1;
    } catch (error) {
      summary.failed += 1;
      console.error(
        `[object-kpi-freezer] object ${objectId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return summary;
}

async function runFreezerCycle(): Promise<void> {
  if (runInFlight) return;

  runInFlight = (async () => {
    let cronStatus: CronRunStatus = 'ok';
    try {
      await runWithCronMonitor(
        'object-kpi-plan-freezer',
        async () => {
          try {
            const config = await getFreezerConfig();
            if (!config.enabled) return cronStatus;

            const summary = await runPlanFreezerOnce();
            if (summary.fixed > 0 || summary.failed > 0) {
              console.log(
                `[object-kpi-freezer] ${summary.period_month}: зафиксировано ${summary.fixed}, ` +
                `пропущено ${summary.skipped}, ошибок ${summary.failed}`,
              );
            }
          } catch (error) {
            cronStatus = 'error';
            console.error('[object-kpi-freezer] error:', error instanceof Error ? error.message : error);
          }
          return cronStatus;
        },
        {
          schedule: { type: 'interval', value: 1, unit: 'hour' },
          checkinMargin: 10,
          maxRuntime: 30,
        },
      );
    } finally {
      runInFlight = null;
    }
  })();

  return runInFlight;
}

export function startObjectKpiPlanFreezer(): void {
  if (tickTimer || startupTimeout) return;

  console.log('[object-kpi-freezer] started (interval: 1h)');
  startupTimeout = setTimeout(() => {
    startupTimeout = null;
    void runFreezerCycle();
  }, STARTUP_DELAY_MS);

  tickTimer = setInterval(() => {
    void runFreezerCycle();
  }, TICK_INTERVAL_MS);
}

export function stopObjectKpiPlanFreezer(): void {
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
    console.log('[object-kpi-freezer] stopped');
  }
}
