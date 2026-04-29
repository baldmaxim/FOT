import { sigurService } from './sigur.service.js';
import {
  acquirePresencePollingLock,
  releasePresencePollingLock,
  ManualSyncInProgressError,
} from './presence-polling.service.js';
import { syncEventsLogic } from './sigur-sync-events.service.js';
import type { ISyncContext } from './sigur-sync-shared.js';
import {
  getSigurRuntimeState,
  mergeSigurRuntimeState,
} from './sigur-runtime-state.service.js';
import { isSigurRuntimeAllowed, logSigurRuntimeGuardSkip } from './sigur-runtime-guard.service.js';

const CHECK_INTERVAL_MS = 60_000;
const TARGET_HOUR_MSK = 5;
const DAILY_STATE_KEY = 'sigur_events_daily';

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

function getMonthStartYmd(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

async function runDailySyncCycle(ymd: string): Promise<void> {
  if (runInFlight) return;

  runInFlight = (async () => {
    let lockAcquired = false;
    const startDate = getMonthStartYmd(ymd);
    const endDate = ymd;

    try {
      const connection = await sigurService.getBackgroundConnectionType();
      console.log(
        `[events-daily-scheduler] starting daily sync connection=${connection} range=${startDate}..${endDate}`,
      );

      await acquirePresencePollingLock();
      lockAcquired = true;

      const context: ISyncContext = {};
      const result = await syncEventsLogic(startDate, endDate, connection, () => {}, context);

      console.log(
        `[events-daily-scheduler] done: imported=${result.imported}, skipped=${result.skipped}, filteredByDept=${result.filteredByDept}, matched=${result.matched}, errors=${result.errors.length}`,
      );

      // Закрепляем успех в runtime_state, чтобы катчап после рестарта не запускал
      // тот же цикл повторно в течение MSK-суток.
      lastRunYmdMsk = ymd;
      await mergeSigurRuntimeState({
        key: DAILY_STATE_KEY,
        meta: {
          lastRunYmdMsk: ymd,
          lastSuccessAt: new Date().toISOString(),
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
      if (err instanceof ManualSyncInProgressError) {
        console.log('[events-daily-scheduler] skipped: manual sync in progress, will retry next tick');
        lastRunYmdMsk = null;
      } else {
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
    } finally {
      if (lockAcquired) {
        try {
          await releasePresencePollingLock();
        } catch (releaseErr) {
          console.error('[events-daily-scheduler] releasePresencePollingLock error:', releaseErr);
        }
      }
      runInFlight = null;
    }
  })();

  return runInFlight;
}

function onTick(): void {
  const { ymd, hour } = getMoscowParts(new Date());
  // Запускаем при первом тике в час ≥ 5:00 MSK, если сегодня ещё не был успех.
  // Раньше окно было только 5:00–5:59: если сервер был офлайн, синхрон пропускался
  // на сутки. Теперь катчап ловит ситуацию рестарта в течение дня.
  if (hour < TARGET_HOUR_MSK) return;
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
  console.log('[events-daily-scheduler] started (daily ≥05:00 MSK with catchup)');
  schedulerTimer = setInterval(onTick, CHECK_INTERVAL_MS);
  // Первый тик сразу — на случай рестарта сервера после 5:00.
  onTick();
}

export function stopSigurEventsDailyScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    console.log('[events-daily-scheduler] stopped');
  }
}
