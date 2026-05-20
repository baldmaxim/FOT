import * as Sentry from '@sentry/node';
import { sigurService } from './sigur.service.js';
import { IS_PRODUCTION } from '../config/features.js';
import { env } from '../config/env.js';
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
import { notifySigurStructureChanged } from './skud-realtime.service.js';
import type { ISyncContext } from './sigur-sync-shared.js';
import { isSigurRuntimeAllowed, logSigurRuntimeGuardSkip } from './sigur-runtime-guard.service.js';
import { runWithCronMonitor, type CronRunStatus } from '../utils/sentry-cron.js';

const MIN_STRUCTURE_SYNC_INTERVAL = 60_000; // 1 минута — нижний предел против самой Sigur API
// 2 часа — структура (отделы/должности/сотрудники) меняется в основном через нашу
// админку, при этом admin CRUD уже шлёт Socket.IO push structure_updated, и фронт
// обновляется мгновенно. Scheduler нужен лишь чтобы подхватить редкие внешние
// изменения непосредственно в Sigur — раз в 2 часа более чем достаточно, и это
// освобождает слоты SigurRequestLimiter для polling.
const DEFAULT_STRUCTURE_SYNC_INTERVAL = 2 * 60 * 60_000;

function resolveStructureSyncInterval(): number {
  const parsed = Number.parseInt(env.SIGUR_STRUCTURE_SYNC_INTERVAL_MS, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_STRUCTURE_SYNC_INTERVAL) return DEFAULT_STRUCTURE_SYNC_INTERVAL;
  return parsed;
}

const STARTUP_DELAY = 30_000; // 30 секунд после старта
const RUN_STARTUP_SYNC = process.env.SIGUR_STRUCTURE_SYNC_ON_STARTUP === 'true' || IS_PRODUCTION;

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let startupTimeout: ReturnType<typeof setTimeout> | null = null;
let syncInFlight: Promise<void> | null = null;

async function runStructureSyncCycle(): Promise<void> {
  if (syncInFlight) return;

  syncInFlight = (async () => {
    let lockAcquired = false;
    let cronStatus: CronRunStatus = 'ok';
    const startedAt = Date.now();
    await runWithCronMonitor(
      'sigur-structure-sync',
      async () => {
        try {
          await acquireStructureSyncSchedulerLock();
          lockAcquired = true;

          const connectionType = await sigurService.getBackgroundConnectionType();
          const context: ISyncContext = {};
          console.log(`[structure-scheduler] starting sync connection=${connectionType}: departments + positions + employees`);

          await syncDepartmentsLogic(connectionType, context);
          await syncPositionsFromSigurLogic(connectionType, context);
          await seedPositionsLogic();
          await syncEmployeesLogic(connectionType, () => {}, context, true);

          // Сбрасываем все кэши структуры, чтобы карточка сотрудника не мигала
          // между старыми и новыми именами отделов/должностей, а dept tree
          // и sync filter не отдавали стейл данные.
          invalidateOrgStructureCaches();
          notifySigurStructureChanged({ source: 'scheduler', scope: 'all' });

          const durationMs = Date.now() - startedAt;
          console.log(`[structure-scheduler] sync done connection=${connectionType} durationMs=${durationMs}`);
        } catch (err) {
          if (err instanceof ManualSyncInProgressError) {
            console.log('[structure-scheduler] skipped: manual or concurrent sync in progress');
          } else {
            cronStatus = 'error';
            console.error('[structure-scheduler] error:', (err as Error).message);
            Sentry.captureException(err, { tags: { service: 'structure-scheduler' } });
          }
        } finally {
          if (lockAcquired) await releaseStructureSyncSchedulerLock();
        }
        return cronStatus;
      },
      {
        schedule: { type: 'interval', value: 120, unit: 'minute' },
        checkinMargin: 30,
        maxRuntime: 60,
      },
    );
    syncInFlight = null;
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
  const intervalMs = resolveStructureSyncInterval();
  console.log(`[structure-scheduler] started (interval: ${Math.round(intervalMs / 1000)}s)`);
  if (RUN_STARTUP_SYNC) {
    startupTimeout = setTimeout(() => {
      startupTimeout = null;
      void runStructureSyncCycle();
    }, STARTUP_DELAY);
  }
  schedulerTimer = setInterval(() => {
    void runStructureSyncCycle();
  }, intervalMs);
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
