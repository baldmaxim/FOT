import * as Sentry from '@sentry/node';

// Sentry Cron Monitoring helper.
// Каждый прогон фоновой джобы делает два чек-ина: in_progress → ok|error.
// Если SENTRY_DSN не задан (локалка/тесты) — пропускает чек-ины и просто вызывает fn().

export type CronScheduleConfig =
  | { type: 'crontab'; value: string }
  | { type: 'interval'; value: number; unit: 'minute' | 'hour' | 'day' };

export interface ICronMonitorConfig {
  schedule: CronScheduleConfig;
  // Минут после ожидаемого старта, после которых run помечается как missed.
  checkinMargin?: number;
  // Минут от in_progress до завершения, после которых run помечается как timeout.
  maxRuntime?: number;
  // По умолчанию Europe/Moscow.
  timezone?: string;
  failureIssueThreshold?: number;
  recoveryThreshold?: number;
}

export type CronRunStatus = 'ok' | 'error';

const TZ_MSK = 'Europe/Moscow';

function buildMonitorConfig(config: ICronMonitorConfig) {
  return {
    schedule: config.schedule,
    checkinMargin: config.checkinMargin,
    maxRuntime: config.maxRuntime,
    timezone: config.timezone ?? TZ_MSK,
    failureIssueThreshold: config.failureIssueThreshold,
    recoveryThreshold: config.recoveryThreshold,
  };
}

/**
 * Оборачивает один прогон джобы в Sentry cron checkin.
 *
 * fn возвращает либо `'ok'` / `void` (успех), либо `'error'` (внутри уже сделан catch,
 * наружу исключение не пробрасывается, но Sentry должен пометить run как error).
 * Если fn кидает — отправляется error и исключение пробрасывается дальше.
 */
export async function runWithCronMonitor(
  monitorSlug: string,
  fn: () => Promise<CronRunStatus | void>,
  config: ICronMonitorConfig,
): Promise<void> {
  // dsn читаем на каждом вызове, а не на module load: dotenv в env.ts
  // подгружает .env уже после vitest setupFiles, поэтому моментальная
  // оценка на загрузке могла бы ошибочно считать SENTRY_DSN заданным
  // в тестах. То же касается прод-сценария hot-reload .env через PM2.
  if (!process.env.SENTRY_DSN) {
    await fn();
    return;
  }
  const monitorConfig = buildMonitorConfig(config);
  // captureCheckIn появился в @sentry/node v7+. Через unknown-cast страхуемся
  // от мок-окружения тестов, где функция отсутствует. Доступ через
  // Reflect.get не триггерит throw-on-undefined у vitest-моков.
  const captureCheckIn = Reflect.get(Sentry as unknown as object, 'captureCheckIn') as
    | ((
        checkIn: { monitorSlug: string; status: 'in_progress' | 'ok' | 'error'; checkInId?: string; duration?: number },
        upsertMonitorConfig?: ReturnType<typeof buildMonitorConfig>,
      ) => string)
    | undefined;
  if (typeof captureCheckIn !== 'function') {
    await fn();
    return;
  }
  const checkInId = captureCheckIn(
    { monitorSlug, status: 'in_progress' },
    monitorConfig,
  );
  const startedAt = Date.now();
  try {
    const result = await fn();
    captureCheckIn(
      {
        checkInId,
        monitorSlug,
        status: result === 'error' ? 'error' : 'ok',
        duration: (Date.now() - startedAt) / 1000,
      },
      monitorConfig,
    );
  } catch (err) {
    captureCheckIn(
      {
        checkInId,
        monitorSlug,
        status: 'error',
        duration: (Date.now() - startedAt) / 1000,
      },
      monitorConfig,
    );
    throw err;
  }
}
