import * as Sentry from '@sentry/node';
import { query } from '../config/postgres.js';
import { auditService } from './audit.service.js';
import { employeeCache } from './employee-cache.service.js';
import {
  applyDismissalImmediately,
  insertDismissalHistory,
  loadEmployeeLifecycleRow,
} from '../controllers/employee-lifecycle.controller.js';
import { runWithCronMonitor, type CronRunStatus } from '../utils/sentry-cron.js';

const TICK_INTERVAL_MS = 30 * 60_000;
const STARTUP_DELAY_MS = 45_000;

let tickTimer: ReturnType<typeof setInterval> | null = null;
let startupTimeout: ReturnType<typeof setTimeout> | null = null;
let runInFlight: Promise<void> | null = null;

async function loadDueEmployeeIds(): Promise<number[]> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await query<{ id: number }>(
    `SELECT id
       FROM employees
      WHERE employment_status = 'active'
        AND dismissal_date IS NOT NULL
        AND dismissal_date <= $1::date`,
    [today],
  );
  return rows.map(r => Number(r.id)).filter(Number.isFinite);
}

async function applyForEmployee(employeeId: number): Promise<void> {
  const existing = await loadEmployeeLifecycleRow(employeeId);
  if (!existing) return;
  if (existing.employment_status !== 'active' || !existing.dismissal_date) return;

  const dismissalDate = existing.dismissal_date;

  try {
    const { fromDepartmentId } = await applyDismissalImmediately({
      employeeId,
      existing,
      dismissalDate,
      userId: null,
    });
    employeeCache.invalidate(employeeId);

    await insertDismissalHistory(employeeId, dismissalDate, {
      scheduled: false,
      appliedFromScheduled: true,
      createdBy: null,
      fromDepartmentId,
    });

    await auditService.log({
      user_id: null,
      action: 'FIRE_EMPLOYEE_APPLIED',
      entity_type: 'employee',
      entity_id: String(employeeId),
      details: {
        dismissal_date: dismissalDate,
        source: existing.sigur_employee_id ? 'sigur' : 'portal',
        triggered_by: 'scheduler',
      },
    });

    console.log(`[dismissal-scheduler] applied dismissal for employee=${employeeId} date=${dismissalDate}`);
  } catch (error) {
    console.error(`[dismissal-scheduler] failed for employee=${employeeId}:`, error);
    Sentry.captureException(error, {
      tags: { service: 'dismissal-scheduler' },
      extra: { employeeId, dismissalDate },
    });
  }
}

async function runCycle(): Promise<void> {
  if (runInFlight) return;

  runInFlight = (async () => {
    let cronStatus: CronRunStatus = 'ok';
    try {
      await runWithCronMonitor(
        'dismissal-scheduler',
        async () => {
          try {
            const ids = await loadDueEmployeeIds();
            if (ids.length === 0) return cronStatus;

            for (const id of ids) {
              await applyForEmployee(id);
            }
          } catch (error) {
            cronStatus = 'error';
            console.error('[dismissal-scheduler] cycle error:', error instanceof Error ? error.message : error);
            Sentry.captureException(error, { tags: { service: 'dismissal-scheduler', stage: 'cycle' } });
          }
          return cronStatus;
        },
        {
          schedule: { type: 'interval', value: 30, unit: 'minute' },
          checkinMargin: 5,
          maxRuntime: 10,
        },
      );
    } finally {
      runInFlight = null;
    }
  })();

  return runInFlight;
}

export function startDismissalScheduler(): void {
  if (tickTimer || startupTimeout) return;

  console.log('[dismissal-scheduler] started (tick: 30m)');
  startupTimeout = setTimeout(() => {
    startupTimeout = null;
    void runCycle();
  }, STARTUP_DELAY_MS);

  tickTimer = setInterval(() => {
    void runCycle();
  }, TICK_INTERVAL_MS);
}

export function stopDismissalScheduler(): void {
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
    console.log('[dismissal-scheduler] stopped');
  }
}
