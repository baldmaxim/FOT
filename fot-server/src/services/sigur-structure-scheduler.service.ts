import { sigurService } from './sigur.service.js';
import {
  acquirePresencePollingLock,
  releasePresencePollingLock,
  ManualSyncInProgressError,
} from './presence-polling.service.js';
import {
  syncDepartmentsLogic,
  syncPositionsFromSigurLogic,
  seedPositionsLogic,
  syncEmployeesLogic,
} from './sigur-sync.service.js';
import type { ISyncContext } from './sigur-sync-shared.js';

const STRUCTURE_SYNC_INTERVAL = 60 * 60_000; // 1 час
const STARTUP_DELAY = 30_000; // 30 секунд после старта

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let startupTimeout: ReturnType<typeof setTimeout> | null = null;
let syncInFlight: Promise<void> | null = null;

async function runStructureSyncCycle(): Promise<void> {
  if (syncInFlight) return;

  syncInFlight = (async () => {
    let lockAcquired = false;
    try {
      await acquirePresencePollingLock();
      lockAcquired = true;

      const context: ISyncContext = {};
      console.log('[structure-scheduler] starting hourly sync: departments + positions + employees');

      await syncDepartmentsLogic(undefined, context);
      await syncPositionsFromSigurLogic(undefined, context);
      await seedPositionsLogic();
      await syncEmployeesLogic(undefined, () => {}, context, false);

      console.log('[structure-scheduler] hourly sync done');
    } catch (err) {
      if (err instanceof ManualSyncInProgressError) {
        console.log('[structure-scheduler] skipped: manual sync in progress');
      } else {
        console.error('[structure-scheduler] error:', (err as Error).message);
      }
    } finally {
      if (lockAcquired) releasePresencePollingLock();
      syncInFlight = null;
    }
  })();

  return syncInFlight;
}

export function startStructureSyncScheduler(): void {
  if (schedulerTimer || startupTimeout) return;
  if (!sigurService.isConfigured()) {
    console.log('[structure-scheduler] Sigur not configured, skipping');
    return;
  }
  console.log('[structure-scheduler] started (interval: 1h)');
  startupTimeout = setTimeout(() => {
    startupTimeout = null;
    void runStructureSyncCycle();
  }, STARTUP_DELAY);
  schedulerTimer = setInterval(() => {
    void runStructureSyncCycle();
  }, STRUCTURE_SYNC_INTERVAL);
}

export function stopStructureSyncScheduler(): void {
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    console.log('[structure-scheduler] stopped');
  }
}
