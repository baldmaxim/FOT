import * as Sentry from '@sentry/node';
import { sigurService } from './sigur.service.js';
import { IS_PRODUCTION } from '../config/features.js';
import {
  acquireStructureSyncSchedulerLock,
  releaseStructureSyncSchedulerLock,
  ManualSyncInProgressError,
} from './presence-polling.service.js';
import {
  syncDepartmentsLogic,
  syncPositionsFromSigurLogic,
  seedPositionsLogic,
  syncEmployeesLogic,
} from './sigur-sync.service.js';
import { invalidateOrgStructureCaches } from './employee-mapper.service.js';
import type { ISyncContext } from './sigur-sync-shared.js';
import { isSigurRuntimeAllowed, logSigurRuntimeGuardSkip } from './sigur-runtime-guard.service.js';

const STRUCTURE_SYNC_INTERVAL = 60 * 60_000; // 1 час
const STARTUP_DELAY = 30_000; // 30 секунд после старта
const RUN_STARTUP_SYNC = process.env.SIGUR_STRUCTURE_SYNC_ON_STARTUP === 'true' || IS_PRODUCTION;

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let startupTimeout: ReturnType<typeof setTimeout> | null = null;
let syncInFlight: Promise<void> | null = null;

async function runStructureSyncCycle(): Promise<void> {
  if (syncInFlight) return;

  syncInFlight = (async () => {
    let lockAcquired = false;
    try {
      await acquireStructureSyncSchedulerLock();
      lockAcquired = true;

      const connectionType = await sigurService.getBackgroundConnectionType();
      const context: ISyncContext = {};
      console.log(`[structure-scheduler] starting hourly sync connection=${connectionType}: departments + positions + employees`);

      await syncDepartmentsLogic(connectionType, context);
      await syncPositionsFromSigurLogic(connectionType, context);
      await seedPositionsLogic();
      await syncEmployeesLogic(connectionType, () => {}, context, true);

      // Сбрасываем все кэши структуры, чтобы карточка сотрудника не мигала
      // между старыми и новыми именами отделов/должностей, а dept tree
      // и sync filter не отдавали стейл данные ещё 5 минут после sync.
      invalidateOrgStructureCaches();

      console.log(`[structure-scheduler] hourly sync done connection=${connectionType}`);
    } catch (err) {
      if (err instanceof ManualSyncInProgressError) {
        console.log('[structure-scheduler] skipped: manual or concurrent sync in progress');
      } else {
        console.error('[structure-scheduler] error:', (err as Error).message);
        Sentry.captureException(err, { tags: { service: 'structure-scheduler' } });
      }
    } finally {
      if (lockAcquired) await releaseStructureSyncSchedulerLock();
      syncInFlight = null;
    }
  })();

  return syncInFlight;
}

export async function startStructureSyncScheduler(): Promise<void> {
  if (schedulerTimer || startupTimeout) return;
  if (!(await sigurService.isConfigured())) {
    console.log('[structure-scheduler] Sigur not configured, skipping');
    return;
  }
  if (!isSigurRuntimeAllowed()) {
    logSigurRuntimeGuardSkip('structure-scheduler');
    return;
  }
  console.log('[structure-scheduler] started (interval: 1h)');
  if (RUN_STARTUP_SYNC) {
    startupTimeout = setTimeout(() => {
      startupTimeout = null;
      void runStructureSyncCycle();
    }, STARTUP_DELAY);
  }
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
