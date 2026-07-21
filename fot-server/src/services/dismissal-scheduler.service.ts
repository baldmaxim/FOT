import * as Sentry from '@sentry/node';
import { query, execute } from '../config/postgres.js';
import { getMoscowDismissalTiming } from '../utils/date.utils.js';
import { auditService } from './audit.service.js';
import { employeeCache } from './employee-cache.service.js';
import {
  applyDismissalImmediately,
  insertDismissalHistory,
  loadEmployeeLifecycleRow,
} from '../controllers/employee-lifecycle.controller.js';
import { runWithCronMonitor, type CronRunStatus } from '../utils/sentry-cron.js';

const TICK_INTERVAL_MS = 5 * 60_000;
const STARTUP_DELAY_MS = 45_000;
/** Просроченный lease перезахватывается (процесс упал между claim и применением). */
const LEASE_MINUTES = 30;
/** Ограничители одного цикла: длинная очередь не должна перекрывать интервал тика. */
const MAX_PER_CYCLE = 500;
const CYCLE_BUDGET_MS = 4 * 60_000;

let tickTimer: ReturnType<typeof setInterval> | null = null;
let startupTimeout: ReturnType<typeof setTimeout> | null = null;
let runInFlight: Promise<void> | null = null;

interface IDismissalClaim {
  id: number;
  /** timestamptz как текст: pg парсит OID 1184 в Date, теряя микросекунды PG. */
  claimed_at: string;
}

/**
 * Атомарно захватывает ОДНУ запись, готовую к применению, прямо перед её обработкой.
 * SKIP LOCKED + условие по lease защищают от повторного применения вторым инстансом бэка,
 * а поштучный захват оставляет отмену доступной всем, до кого очередь ещё не дошла.
 */
async function claimNextDueEmployee(dueCutoff: string): Promise<IDismissalClaim | null> {
  const rows = await query<IDismissalClaim>(
    `WITH candidate AS (
       SELECT id
         FROM employees
        WHERE employment_status = 'active'
          AND dismissal_date IS NOT NULL
          AND dismissal_date <= $1::date
          AND (dismissal_apply_started_at IS NULL
               OR dismissal_apply_started_at < now() - ($2 || ' minutes')::interval)
        ORDER BY dismissal_date, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE employees e
        SET dismissal_apply_started_at = now()
       FROM candidate c
      WHERE e.id = c.id
     RETURNING e.id, e.dismissal_apply_started_at::text AS claimed_at`,
    [dueCutoff, String(LEASE_MINUTES)],
  );
  return rows[0] ?? null;
}

/** Условный сброс lease: старый worker не должен затирать чужой свежий claim. */
async function releaseClaim(employeeId: number, claimedAt: string): Promise<void> {
  try {
    await execute(
      `UPDATE employees
          SET dismissal_apply_started_at = NULL
        WHERE id = $1
          AND employment_status = 'active'
          AND dismissal_apply_started_at = $2::timestamptz`,
      [employeeId, claimedAt],
    );
  } catch (error) {
    console.error(`[dismissal-scheduler] failed to release claim for employee=${employeeId}:`, error);
  }
}

async function applyForEmployee(employeeId: number, claimedAt: string): Promise<void> {
  const existing = await loadEmployeeLifecycleRow(employeeId);
  if (!existing || existing.employment_status !== 'active' || !existing.dismissal_date) {
    await releaseClaim(employeeId, claimedAt);
    return;
  }

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
    await releaseClaim(employeeId, claimedAt);
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
            // dueCutoff: сегодня — только после 23:00 МСК, иначе вчера.
            const { dueCutoff } = getMoscowDismissalTiming();
            const startedAt = Date.now();

            for (let processed = 0; processed < MAX_PER_CYCLE; processed++) {
              if (Date.now() - startedAt > CYCLE_BUDGET_MS) {
                console.warn('[dismissal-scheduler] cycle budget exhausted, rest goes to next tick');
                break;
              }
              const claim = await claimNextDueEmployee(dueCutoff);
              if (!claim) break;
              await applyForEmployee(Number(claim.id), claim.claimed_at);
            }
          } catch (error) {
            cronStatus = 'error';
            console.error('[dismissal-scheduler] cycle error:', error instanceof Error ? error.message : error);
            Sentry.captureException(error, { tags: { service: 'dismissal-scheduler', stage: 'cycle' } });
          }
          return cronStatus;
        },
        {
          schedule: { type: 'interval', value: 5, unit: 'minute' },
          checkinMargin: 2,
          maxRuntime: 5,
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

  console.log('[dismissal-scheduler] started (tick: 5m)');
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
