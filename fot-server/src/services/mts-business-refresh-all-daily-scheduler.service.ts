import { settingsService } from './settings.service.js';
import { startRefreshAll, type IRefreshAllStatus } from './mts-business-refresh-all.service.js';
import { getSigurRuntimeState, mergeSigurRuntimeState } from './sigur-runtime-state.service.js';
import { auditService, AUDIT_ACTIONS } from './audit.service.js';
import { runWithCronMonitor } from '../utils/sentry-cron.js';

// Ежедневный автозапуск полного прогона «Обновить всё» модуля МТС Бизнес
// (все шаги: иерархия, комментарии, биллинг, детализация, абоненты) — данные
// «по итогам дня» без ручной кнопки. Расписание (вкл/выкл + час МСК) хранится
// в system_settings и меняется из админки МТС Бизнес; кэш settingsService 60с +
// минутный тик → изменение применяется в пределах ~2 минут.
//
// Тик раз в минуту, запуск один раз в сутки при первом тике после целевого
// часа (catchup при рестарте — как у cdr-daily). Собственный lease не нужен:
// конкурентность (в т.ч. с ручным прогоном) решает lease внутри
// startRefreshAll — при занятом он тихо возвращает alreadyRunning, день не
// помечается выполненным и автозапуск ретраится следующими тиками.

const CHECK_INTERVAL_MS = 60_000;
const DAILY_STATE_KEY = 'mts_business_refresh_all_daily';

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let lastRunYmdMsk: string | null = null;
let runInFlight: Promise<void> | null = null;

function getMoscowYmd(now: Date): string {
  const formatter = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = formatter.formatToParts(now);
  const get = (type: string): string => parts.find(p => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function getMoscowHour(now: Date): number {
  const formatter = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', hour12: false });
  const hourStr = formatter.formatToParts(now).find(p => p.type === 'hour')?.value ?? '0';
  return Number.parseInt(hourStr === '24' ? '0' : hourStr, 10);
}

/** Гейт тика (чистая функция для тестов): пора ли запускать сегодняшний прогон. */
export function shouldRunDailyRefresh(
  cfg: { enabled: boolean; hourMsk: number },
  lastRunYmd: string | null,
  now: Date,
): boolean {
  if (!cfg.enabled) return false;
  if (getMoscowHour(now) < cfg.hourMsk) return false;
  return lastRunYmd !== getMoscowYmd(now);
}

/** Итог прогона для сводки планировщиков (schedulerRowFromState). */
function summarizeRun(final: IRefreshAllStatus): {
  ok: boolean;
  error: string | null;
  result: { accounts: number; stepsOk: number; stepsUnavailable: number; stepsError: number };
} {
  const stepsError = final.steps.filter(s => s.status === 'error').length;
  const firstError = final.error
    ?? final.steps.find(s => s.status === 'error')?.message
    ?? null;
  return {
    ok: final.error == null && stepsError === 0,
    error: firstError,
    result: {
      accounts: new Set(final.steps.map(s => s.accountId)).size,
      stepsOk: final.steps.filter(s => s.status === 'ok').length,
      stepsUnavailable: final.steps.filter(s => s.status === 'unavailable').length,
      stepsError,
    },
  };
}

async function runDailyCycle(ymd: string, hourMsk: number): Promise<void> {
  if (runInFlight) return;

  runInFlight = (async () => {
    try {
      // Перечитываем state перед стартом: in-memory lastRunYmdMsk у каждого
      // PM2-инстанса свой, а полный прогон дорогой — дешёвая страховка от
      // двойного запуска (второй инстанс мог отработать после нашего старта).
      const state = await getSigurRuntimeState(DAILY_STATE_KEY);
      const storedYmd = state?.meta?.lastRunYmdMsk;
      if (typeof storedYmd === 'string' && storedYmd >= ymd) {
        lastRunYmdMsk = storedYmd;
        return;
      }

      await runWithCronMonitor(
        'mts-business-refresh-all-daily',
        async () => {
          const startedAtIso = new Date().toISOString();
          const started = await startRefreshAll({ initiator: 'schedule' });
          if (!started.started || !started.completion) {
            // Занято ручным прогоном: день НЕ помечаем — ретрай следующими
            // тиками, автопрогон стартует после завершения ручного.
            console.log('[mts-biz-refresh-all-daily] пропуск тика: прогон уже выполняется (ручной?)');
            return 'ok';
          }

          lastRunYmdMsk = ymd;
          await mergeSigurRuntimeState({
            key: DAILY_STATE_KEY,
            meta: { lastRunYmdMsk: ymd, lastStartedAt: startedAtIso },
          }).catch(err => console.error('[mts-biz-refresh-all-daily] merge start state error:', (err as Error).message));
          await auditService.log({
            user_id: null,
            action: AUDIT_ACTIONS.MTS_BUSINESS_REFRESH_ALL_STARTED,
            details: { initiator: 'schedule', hourMsk, ymd },
          });

          const final = await started.completion;
          const summary = summarizeRun(final);
          await mergeSigurRuntimeState({
            key: DAILY_STATE_KEY,
            meta: summary.ok
              ? { lastSuccessAt: new Date().toISOString(), lastResult: summary.result }
              : { lastFailureAt: new Date().toISOString(), lastError: summary.error ?? 'unknown', lastResult: summary.result },
          }).catch(err => console.error('[mts-biz-refresh-all-daily] merge result state error:', (err as Error).message));
          console.log(`[mts-biz-refresh-all-daily] прогон завершён: ok=${summary.ok} steps=${JSON.stringify(summary.result)}`);
          return summary.ok ? 'ok' : 'error';
        },
        {
          // Час динамический (system_settings) — конфиг монитора upsert'ится
          // на каждом чек-ине. Slug включается через SENTRY_CRON_MONITOR_SLUGS;
          // при выключенном автопрогоне включённый slug даст «missed»-алерты.
          schedule: { type: 'crontab', value: `0 ${hourMsk} * * *` },
          checkinMargin: 20,
          maxRuntime: 300,
        },
      );
    } catch (error) {
      // Сюда попадает только «прогон не стартовал» (нет активных аккаунтов,
      // ошибка БД): день не помечен → ретрай следующими тиками.
      console.error('[mts-biz-refresh-all-daily] error:', error instanceof Error ? error.message : 'unknown');
      await mergeSigurRuntimeState({
        key: DAILY_STATE_KEY,
        meta: { lastFailureAt: new Date().toISOString(), lastError: error instanceof Error ? error.message : 'unknown' },
      }).catch(err => console.error('[mts-biz-refresh-all-daily] merge failure state error:', (err as Error).message));
    } finally {
      runInFlight = null;
    }
  })();

  return runInFlight;
}

async function onTick(): Promise<void> {
  try {
    const cfg = await settingsService.getMtsBusinessRefreshAllSchedule();
    const now = new Date();
    if (!shouldRunDailyRefresh(cfg, lastRunYmdMsk, now)) return;
    void runDailyCycle(getMoscowYmd(now), cfg.hourMsk);
  } catch (err) {
    console.error('[mts-biz-refresh-all-daily] tick error:', (err as Error).message);
  }
}

async function loadLastRunFromRuntimeState(): Promise<void> {
  try {
    const state = await getSigurRuntimeState(DAILY_STATE_KEY);
    const stored = state?.meta?.lastRunYmdMsk;
    if (typeof stored === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(stored)) {
      lastRunYmdMsk = stored;
    }
  } catch (err) {
    console.error('[mts-biz-refresh-all-daily] failed to load runtime_state:', (err as Error).message);
  }
}

export async function startMtsBusinessRefreshAllDailyScheduler(): Promise<void> {
  if (schedulerTimer) return;
  await loadLastRunFromRuntimeState();
  console.log('[mts-biz-refresh-all-daily] started (daily at hour from system_settings, MSK, with catchup)');
  schedulerTimer = setInterval(() => void onTick(), CHECK_INTERVAL_MS);
  void onTick();
}

export function stopMtsBusinessRefreshAllDailyScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    console.log('[mts-biz-refresh-all-daily] stopped');
  }
}
