import { sigurService } from './sigur.service.js';
import {
  acquirePresencePollingLock,
  releasePresencePollingLock,
  ManualSyncInProgressError,
} from './presence-polling.service.js';
import { syncEventsLogic } from './sigur-sync-events.service.js';
import type { ISyncContext } from './sigur-sync-shared.js';

const CHECK_INTERVAL_MS = 60_000;
const TARGET_HOUR_MSK = 5;

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

async function runDailySyncCycle(): Promise<void> {
  if (runInFlight) return;

  runInFlight = (async () => {
    let lockAcquired = false;
    const { ymd } = getMoscowParts(new Date());
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
    } catch (err) {
      if (err instanceof ManualSyncInProgressError) {
        console.log('[events-daily-scheduler] skipped: manual sync in progress, will retry next tick');
        lastRunYmdMsk = null;
      } else {
        console.error('[events-daily-scheduler] error:', (err as Error).message);
        lastRunYmdMsk = null;
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
  if (hour !== TARGET_HOUR_MSK) return;
  if (lastRunYmdMsk === ymd) return;
  lastRunYmdMsk = ymd;
  void runDailySyncCycle();
}

export async function startSigurEventsDailyScheduler(): Promise<void> {
  if (schedulerTimer) return;
  if (!(await sigurService.isConfigured())) {
    console.log('[events-daily-scheduler] Sigur not configured, skipping');
    return;
  }
  console.log('[events-daily-scheduler] started (daily 05:00 MSK)');
  schedulerTimer = setInterval(onTick, CHECK_INTERVAL_MS);
}

export function stopSigurEventsDailyScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    console.log('[events-daily-scheduler] stopped');
  }
}
