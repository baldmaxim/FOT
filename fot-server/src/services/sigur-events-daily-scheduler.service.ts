import { sigurService } from './sigur.service.js';
import {
  hasExclusiveSyncLease,
  hasEventsSyncLease,
} from './presence-polling.service.js';
import { syncEventsLogic } from './sigur-sync-events.service.js';
import type { ISyncContext } from './sigur-sync-shared.js';
import { notifySkudRealtimeChanged } from './skud-realtime.service.js';
import {
  getSigurRuntimeState,
  mergeSigurRuntimeState,
} from './sigur-runtime-state.service.js';
import { isSigurRuntimeAllowed, logSigurRuntimeGuardSkip } from './sigur-runtime-guard.service.js';
import { env } from '../config/env.js';
import { runWithCronMonitor, type CronRunStatus } from '../utils/sentry-cron.js';

const CHECK_INTERVAL_MS = 60_000;
const DAILY_STATE_KEY = 'sigur_events_daily';

function resolveTargetHourMsk(): number {
  const parsed = Number.parseInt(env.SIGUR_EVENTS_DAILY_TARGET_HOUR_MSK, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 23) return 3;
  return parsed;
}

function resolveWindowDays(): number {
  const parsed = Number.parseInt(env.SIGUR_EVENTS_DAILY_WINDOW_DAYS, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 2;
  return parsed;
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let lastRunYmdMsk: string | null = null;
let runInFlight: Promise<void> | null = null;

function getMoscowParts(now: Date): { ymd: string; hour: number } {
  const formatter = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const get = (type: string): string => parts.find(p => p.type === type)?.value ?? '';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hourStr = get('hour');
  const hour = Number.parseInt(hourStr === '24' ? '0' : hourStr, 10);
  return { ymd: `${year}-${month}-${day}`, hour };
}

// Окно catchup для daily-sync. Раньше было «весь текущий месяц», что давало
// долгие тики (десятки минут на больших организациях). Polling сам ловит
// 7-дневный catchup при рестарте, а backfillUnmatchedEvents добивает события,
// прилетевшие до создания сотрудника. Поэтому 2 дней страховки достаточно.
function getDailyWindowStartYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(n => Number.parseInt(n, 10));
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - Math.max(0, days - 1));
  const yy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

async function runDailySyncCycle(ymd: string): Promise<void> {
  if (runInFlight) return;

  runInFlight = (async () => {
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();
    const windowDays = resolveWindowDays();
    const startDate = getDailyWindowStartYmd(ymd, windowDays);
    const endDate = ymd;
    const targetHour = resolveTargetHourMsk();
    let cronStatus: CronRunStatus = 'ok';

    try {
      await runWithCronMonitor(
        'sigur-events-daily',
        async () => {
          try {
            // Уступаем ручной полной синхронизации, не блокируя при этом фоновый
            // presence-polling (он пишет идемпотентно через UPSERT и не конфликтует
            // с daily). hasEventsSyncLease отсекает параллельный manual events sync.
            if (await hasExclusiveSyncLease()) {
              console.log('[events-daily-scheduler] skipped: exclusive sync in progress, will retry next tick');
              lastRunYmdMsk = null;
              return;
            }
            if (await hasEventsSyncLease()) {
              console.log('[events-daily-scheduler] skipped: manual events sync in progress, will retry next tick');
              lastRunYmdMsk = null;
              return;
            }

            const connection = await sigurService.getBackgroundConnectionType();
            console.log(
              `[events-daily-scheduler] starting daily sync connection=${connection} range=${startDate}..${endDate} startedAt=${startedAtIso} windowDays=${windowDays}`,
            );

            const context: ISyncContext = {};
            const result = await syncEventsLogic(startDate, endDate, connection, () => {}, context);

            const durationMs = Date.now() - startedAt;
            const finishedAtIso = new Date().toISOString();
            console.log(
              `[events-daily-scheduler] done durationMs=${durationMs} startedAt=${startedAtIso} finishedAt=${finishedAtIso} imported=${result.imported} skipped=${result.skipped} filteredByDept=${result.filteredByDept} matched=${result.matched} errors=${result.errors.length}`,
            );

            notifySkudRealtimeChanged({
              source: 'daily_sync',
              from: startDate,
              to: endDate,
              insertedCount: result.imported,
              recalculatedCount: result.matched,
            });

            lastRunYmdMsk = ymd;
            await mergeSigurRuntimeState({
              key: DAILY_STATE_KEY,
              meta: {
                lastRunYmdMsk: ymd,
                lastSuccessAt: finishedAtIso,
                lastStartedAt: startedAtIso,
                lastDurationMs: durationMs,
                lastWindow: { startDate, endDate, windowDays },
                lastResult: {
                  imported: result.imported,
                  skipped: result.skipped,
                  filteredByDept: result.filteredByDept,
                  matched: result.matched,
                  errors: result.errors.length,
                },
              },
            }).catch(err =>
              console.error('[events-daily-scheduler] mergeSigurRuntimeState success error:', (err as Error).message),
            );
          } catch (err) {
            cronStatus = 'error';
            console.error('[events-daily-scheduler] error:', (err as Error).message);
            lastRunYmdMsk = null;
            await mergeSigurRuntimeState({
              key: DAILY_STATE_KEY,
              meta: {
                lastFailureAt: new Date().toISOString(),
                lastError: (err as Error).message,
              },
            }).catch(stateErr =>
              console.error('[events-daily-scheduler] mergeSigurRuntimeState failure error:', (stateErr as Error).message),
            );
          }
          return cronStatus;
        },
        {
          schedule: { type: 'crontab', value: `0 ${targetHour} * * *` },
          checkinMargin: 60,
          maxRuntime: 120,
        },
      );
    } finally {
      runInFlight = null;
    }
  })();

  return runInFlight;
}

function onTick(): void {
  const targetHour = resolveTargetHourMsk();
  const { ymd, hour } = getMoscowParts(new Date());
  // Запускаем при первом тике в час ≥ TARGET_HOUR_MSK, если сегодня ещё не был успех.
  // Catchup ловит ситуацию рестарта в течение дня — если сервер был офлайн
  // в TARGET_HOUR..TARGET_HOUR+1, daily всё равно отработает после старта.
  if (hour < targetHour) return;
  if (lastRunYmdMsk === ymd) return;
  void runDailySyncCycle(ymd);
}

async function loadLastRunFromRuntimeState(): Promise<void> {
  try {
    const state = await getSigurRuntimeState(DAILY_STATE_KEY);
    const stored = state?.meta?.lastRunYmdMsk;
    if (typeof stored === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(stored)) {
      lastRunYmdMsk = stored;
      console.log(`[events-daily-scheduler] loaded last_run_ymd_msk=${stored} from runtime_state`);
    }
  } catch (err) {
    console.error('[events-daily-scheduler] failed to load runtime_state:', (err as Error).message);
  }
}

export async function startSigurEventsDailyScheduler(): Promise<void> {
  if (schedulerTimer) return;
  if (!(await sigurService.isConfigured())) {
    console.log('[events-daily-scheduler] Sigur not configured, skipping');
    return;
  }
  if (!isSigurRuntimeAllowed()) {
    logSigurRuntimeGuardSkip('events-daily-scheduler');
    return;
  }
  await loadLastRunFromRuntimeState();
  const targetHour = resolveTargetHourMsk();
  const windowDays = resolveWindowDays();
  console.log(
    `[events-daily-scheduler] started (daily ≥${String(targetHour).padStart(2, '0')}:00 MSK with catchup, windowDays=${windowDays})`,
  );
  schedulerTimer = setInterval(onTick, CHECK_INTERVAL_MS);
  // Первый тик сразу — на случай рестарта сервера после TARGET_HOUR.
  onTick();
}

export function stopSigurEventsDailyScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    console.log('[events-daily-scheduler] stopped');
  }
}
