import { sigurService } from './sigur.service.js';
import { supabase } from '../config/database.js';
import { mapSigurEvent } from '../utils/sigur.mapper.js';
import { computeDedupHash } from '../utils/dedup.utils.js';
import { buildMoscowEventTimestamp } from '../utils/date.utils.js';
import { backfillUnmatchedEvents } from './skud-backfill.service.js';
import { normalizePersonName } from './sigur-sync-shared.js';
import { invalidatePresenceCache } from './skud-presence.service.js';
import { invalidateDashboardCache } from './skud-dashboard.service.js';
import {
  markPresencePollingCycleFinished,
  markPresencePollingCycleStarted,
  recordSigurMonitorFailure,
  recordSigurMonitorSuccess,
} from './sigur-monitor.service.js';
import {
  SIGUR_POLLING_LEASE_TTL_SECONDS,
  SIGUR_POLLING_STATE_KEY,
  getSigurRuntimeOwner,
  getSigurRuntimeState,
  mergeSigurRuntimeState,
  releaseSigurRuntimeLease,
  startSigurRuntimeLeaseHeartbeat,
  tryAcquireSigurRuntimeLease,
} from './sigur-runtime-state.service.js';
import type { ConnectionType } from './sigur.service.js';

const POLL_INTERVAL = 60_000;
const EMPLOYEE_CACHE_TTL = 10 * 60_000;
const BATCH_SIZE = 500;
export const POLL_OVERLAP_MS = 2 * 60_000;
const POLL_MAX_WINDOW_MS = 10 * 60_000;

let pollingTimer: ReturnType<typeof setInterval> | null = null;
let startupTimeout: ReturnType<typeof setTimeout> | null = null;
let manualSyncLocks = 0;
let pollInFlight: Promise<void> | null = null;
let manualSyncLeaseHeartbeatStop: (() => void) | null = null;

const POLLING_LEASE_OWNER = getSigurRuntimeOwner(SIGUR_POLLING_STATE_KEY);
const MANUAL_SYNC_LEASE_OWNER = `${POLLING_LEASE_OWNER}:manual`;

export class ManualSyncInProgressError extends Error {
  readonly code = 'SYNC_IN_PROGRESS';
  readonly status = 409;

  constructor(message = 'Ручная синхронизация уже выполняется. Дождитесь завершения текущего запуска.') {
    super(message);
    this.name = 'ManualSyncInProgressError';
  }
}

let employeeCache: {
  byName: Map<string, { id: number }>;
  bySigurId: Map<number, { id: number }>;
  byUniqueName: Map<string, { id: number }>;
  fetchedAt: number;
} | null = null;

interface EmployeeMaps {
  byName: Map<string, { id: number }>;
  bySigurId: Map<number, { id: number }>;
  byUniqueName: Map<string, { id: number }>;
}

type PollCheckpointSource = 'runtime_state' | 'stored_events' | 'fallback';

interface PollingWindow {
  startAt: Date;
  endAt: Date;
  startTime: string;
  endTime: string;
  startDate: string;
  endDate: string;
  checkpointSource: PollCheckpointSource;
  windowTruncated: boolean;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatLocalDateTime(date: Date): string {
  return `${formatLocalDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function parseStoredEventTimestamp(eventDate: string, eventTime: string): Date | null {
  const parsed = new Date(`${eventDate}T${eventTime}+03:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function getEmployeeMaps(): Promise<EmployeeMaps> {
  if (employeeCache && (Date.now() - employeeCache.fetchedAt) < EMPLOYEE_CACHE_TTL) {
    return employeeCache;
  }

  const { data } = await supabase
    .from('employees')
    .select('id, full_name, sigur_employee_id')
    .eq('is_archived', false);

  const byName = new Map<string, { id: number }>();
  const bySigurId = new Map<number, { id: number }>();
  const byUniqueName = new Map<string, { id: number }>();
  const nameCounts = new Map<string, number>();

  for (const emp of data || []) {
    const name = normalizePersonName(emp.full_name || '');
    const ref = { id: emp.id };
    if (!byName.has(name)) byName.set(name, ref);
    if (emp.sigur_employee_id != null) bySigurId.set(emp.sigur_employee_id, ref);
    nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
    byUniqueName.set(name, ref);
  }

  for (const [name, count] of nameCounts) {
    if (count !== 1) {
      byUniqueName.delete(name);
    }
  }

  employeeCache = { byName, bySigurId, byUniqueName, fetchedAt: Date.now() };
  console.log(`[presence-polling] cached ${byName.size} employees`);
  return employeeCache;
}

async function getLatestStoredEventTimestamp(): Promise<Date | null> {
  const { data, error } = await supabase
    .from('skud_events')
    .select('event_date, event_time')
    .order('event_date', { ascending: false })
    .order('event_time', { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(`[presence-polling] failed to read latest stored event: ${error.message}`);
  }

  const latest = data?.[0];
  if (!latest?.event_date || !latest?.event_time) {
    return null;
  }

  return parseStoredEventTimestamp(latest.event_date, latest.event_time);
}

export async function resolvePollingWindow(now = new Date()): Promise<PollingWindow> {
  let checkpointSource: PollCheckpointSource = 'fallback';
  let checkpoint: Date | null = null;

  const runtimeState = await getSigurRuntimeState(SIGUR_POLLING_STATE_KEY);
  if (runtimeState?.checkpoint_at) {
    const parsed = new Date(runtimeState.checkpoint_at);
    if (!Number.isNaN(parsed.getTime())) {
      checkpoint = parsed;
      checkpointSource = 'runtime_state';
    }
  }

  if (!checkpoint) {
    checkpoint = await getLatestStoredEventTimestamp();
    if (checkpoint) {
      checkpointSource = 'stored_events';
    }
  }

  // Если checkpoint старше 12 часов — начинаем от начала сегодня
  const todayStart = startOfLocalDay(now);
  if (checkpoint && (now.getTime() - checkpoint.getTime()) > 12 * 60 * 60 * 1000) {
    const gapMinutes = Math.round((now.getTime() - checkpoint.getTime()) / 60_000);
    console.log(`[presence-polling] catch-up: gap ${gapMinutes}m (>12h), starting from today`);
    checkpoint = todayStart;
    checkpointSource = 'fallback';
  }

  const rawStart = checkpoint
    ? new Date(checkpoint.getTime() - POLL_OVERLAP_MS)
    : todayStart;
  const start = rawStart.getTime() > now.getTime() ? new Date(now) : rawStart;
  const maxEnd = new Date(start.getTime() + POLL_MAX_WINDOW_MS);
  const end = maxEnd.getTime() < now.getTime() ? maxEnd : now;
  const windowTruncated = end.getTime() < now.getTime();

  // Лог catch-up при значительном gap
  if (checkpoint && checkpointSource !== 'fallback') {
    const gapMinutes = Math.round((now.getTime() - checkpoint.getTime()) / 60_000);
    if (gapMinutes > 5) {
      console.log(`[presence-polling] catch-up: recovering ${gapMinutes}m gap from ${formatLocalDateTime(checkpoint)} to ${formatLocalDateTime(now)}`);
    }
  }

  return {
    startAt: start,
    endAt: end,
    startTime: formatLocalDateTime(start),
    endTime: formatLocalDateTime(end),
    startDate: formatLocalDate(start),
    endDate: formatLocalDate(end),
    checkpointSource,
    windowTruncated,
  };
}

export function resetPresencePollingStateForTests(): void {
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }

  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }

  manualSyncLocks = 0;
  pollInFlight = null;
  if (manualSyncLeaseHeartbeatStop) {
    manualSyncLeaseHeartbeatStop();
    manualSyncLeaseHeartbeatStop = null;
  }
  employeeCache = null;
}

export async function pollEventsOnce(now = new Date()): Promise<void> {
  const cycleStartedAt = Date.now();
  const cycleStartedAtIso = new Date(cycleStartedAt).toISOString();
  let window: PollingWindow | null = null;
  let connectionType: ConnectionType | null = null;

  try {
    if (!sigurService.isConfigured()) return;
    connectionType = sigurService.getBackgroundConnectionType();

    window = await resolvePollingWindow(now);
    console.log(
      `[presence-polling] window source=${window.checkpointSource} connection=${connectionType} start=${window.startTime} end=${window.endTime}`,
    );

    const rawEvents = await sigurService.getEvents(window.startTime, window.endTime, connectionType, 'PASS_DETECTED');
    console.log(
      `[presence-polling] fetched=${rawEvents.length} source=${window.checkpointSource} connection=${connectionType} start=${window.startTime} end=${window.endTime}`,
    );

    const { byName, bySigurId, byUniqueName } = await getEmployeeMaps();

    // Дедупликация выполняется на уровне БД через UNIQUE (dedup_hash, event_date)
    // + upsert с ignoreDuplicates: true (ниже). Пред-проверка убрана, так как
    // на горячих диапазонах дат она выкачивала тысячи hash-строк за цикл (60 сек).
    // In-memory Set нужен только для дедупликации внутри текущей пачки событий.
    const existingSet = new Set<string>();

    const inserts: Array<{
      physical_person: string;
      card_number: string | null;
      event_date: string;
      event_time: string;
      event_at: string;
      access_point: string | null;
      direction: 'entry' | 'exit' | null;
      employee_id: number | null;
      dedup_hash: string;
    }> = [];
    const summariesToUpdate = new Set<string>();
    let storedUnmatched = 0;
    let latestObservedEventAt: Date | null = null;

    for (const raw of rawEvents) {
      const mapped = mapSigurEvent(raw as Record<string, unknown>);
      if (!mapped || !mapped.physicalPerson) continue;
      const eventAt = buildMoscowEventTimestamp(mapped.eventDate, mapped.eventTime);
      const observedAt = new Date(eventAt);
      if (!Number.isNaN(observedAt.getTime()) && (!latestObservedEventAt || observedAt.getTime() > latestObservedEventAt.getTime())) {
        latestObservedEventAt = observedAt;
      }

      const dedupHash = computeDedupHash(
        mapped.physicalPerson,
        mapped.eventDate,
        mapped.eventTime,
        mapped.accessPoint,
        mapped.direction,
      );
      if (existingSet.has(dedupHash)) continue;
      existingSet.add(dedupHash);

      const nameKey = normalizePersonName(mapped.physicalPerson);
      let emp: { id: number } | undefined;
      if (mapped.employeeId != null) {
        emp = bySigurId.get(mapped.employeeId);
      }
      if (!emp) {
        emp = byUniqueName.get(nameKey);
      }
      if (!emp) {
        emp = byName.get(nameKey);
      }

      inserts.push({
        physical_person: mapped.physicalPerson,
        card_number: mapped.cardNumber || null,
        event_date: mapped.eventDate,
        event_time: mapped.eventTime,
        event_at: eventAt,
        access_point: mapped.accessPoint,
        direction: mapped.direction,
        employee_id: emp?.id || null,
        dedup_hash: dedupHash,
      });

      if (emp) {
        summariesToUpdate.add(`${emp.id}:${mapped.eventDate}`);
      } else {
        storedUnmatched++;
      }
    }

    let totalInserted = 0;
    const persistenceErrors: string[] = [];
    for (let i = 0; i < inserts.length; i += BATCH_SIZE) {
      const batch = inserts.slice(i, i + BATCH_SIZE);
      const { error } = await supabase
        .from('skud_events')
        .upsert(batch, { onConflict: 'dedup_hash,event_date', ignoreDuplicates: true });
      if (error) {
        console.error('[presence-polling] insert error:', error.message);
        persistenceErrors.push(error.message);
      } else {
        totalInserted += batch.length;
      }
    }

    if (persistenceErrors.length > 0) {
      throw new Error(`Failed to persist Sigur events: ${persistenceErrors[0]}`);
    }

    if (summariesToUpdate.size > 0) {
      const pairs = [...summariesToUpdate].map(key => {
        const [empId, date] = key.split(':');
        return { emp_id: parseInt(empId, 10), date };
      });
      const { error: summaryError } = await supabase.rpc('batch_recalculate_skud_daily_summary', { p_pairs: pairs });
      if (summaryError) {
        throw new Error(`[presence-polling] summary recalc error: ${summaryError.message}`);
      }
    }

    // После успешного цикла сбрасываем кэши presence/dashboard, чтобы пользователи
    // увидели актуальные входы/выходы. Без этого данные отстают до TTL.
    if (totalInserted > 0 || summariesToUpdate.size > 0) {
      invalidatePresenceCache();
      invalidateDashboardCache();
    }

    const monitorCheckedAt = new Date();
    const cycleFinishedAt = new Date();
    const cycleMeta = {
      connectionType,
      checkpointSource: window.checkpointSource,
      windowStart: window.startTime,
      windowEnd: window.endTime,
      windowStartUtc: window.startAt.toISOString(),
      windowEndUtc: window.endAt.toISOString(),
      windowTruncated: window.windowTruncated,
      cycleStartedAt: cycleStartedAtIso,
      cycleFinishedAt: cycleFinishedAt.toISOString(),
      leaseOwner: POLLING_LEASE_OWNER,
      fetched: rawEvents.length,
      inserted: totalInserted,
      unmatched: storedUnmatched,
      summaries: summariesToUpdate.size,
      latestObservedEventAt: latestObservedEventAt?.toISOString() || null,
    };
    await mergeSigurRuntimeState({
      key: SIGUR_POLLING_STATE_KEY,
      owner: POLLING_LEASE_OWNER,
      checkpointAt: window.endAt,
      meta: {
        lastSignalAt: monitorCheckedAt.toISOString(),
        lastSuccessAt: monitorCheckedAt.toISOString(),
        lastCycle: cycleMeta,
        lastError: null,
        ...(latestObservedEventAt ? { lastEventFlowAt: latestObservedEventAt.toISOString() } : {}),
      },
    });
    console.log(
      `[presence-polling] cycle done source=${window.checkpointSource} connection=${connectionType} start=${window.startTime} end=${window.endTime} fetched=${rawEvents.length} inserted=${totalInserted} unmatched=${storedUnmatched} summaries=${summariesToUpdate.size}`,
    );
    void recordSigurMonitorSuccess({
      source: 'presence_polling',
      checkedAt: monitorCheckedAt,
      connectionType,
      responseMs: Date.now() - cycleStartedAt,
      eventsLastWindow: rawEvents.length,
      meta: {
        ...cycleMeta,
      },
    }).catch(error => {
      console.error('[presence-polling] monitor success hook error:', (error as Error).message);
    });
  } catch (error) {
    console.error('[presence-polling] error:', (error as Error).message);
    const monitorCheckedAt = new Date();
    const cycleFinishedAt = new Date();
    await mergeSigurRuntimeState({
      key: SIGUR_POLLING_STATE_KEY,
      owner: POLLING_LEASE_OWNER,
      meta: {
        lastSignalAt: monitorCheckedAt.toISOString(),
        lastFailureAt: monitorCheckedAt.toISOString(),
        lastError: (error as Error).message,
        lastFailedCycle: {
          connectionType,
          checkpointSource: window?.checkpointSource || null,
          windowStart: window?.startTime || null,
          windowEnd: window?.endTime || null,
          windowStartUtc: window?.startAt.toISOString() || null,
          windowEndUtc: window?.endAt.toISOString() || null,
          windowTruncated: window?.windowTruncated || false,
          cycleStartedAt: cycleStartedAtIso,
          cycleFinishedAt: cycleFinishedAt.toISOString(),
          leaseOwner: POLLING_LEASE_OWNER,
        },
      },
    }).catch(runtimeError => {
      console.error('[presence-polling] runtime state failure hook error:', (runtimeError as Error).message);
    });
    void recordSigurMonitorFailure({
      source: 'presence_polling',
      checkedAt: monitorCheckedAt,
      connectionType,
      responseMs: Date.now() - cycleStartedAt,
      errorMessage: (error as Error).message,
      meta: {
        connectionType,
        checkpointSource: window?.checkpointSource || null,
        windowStart: window?.startTime || null,
        windowEnd: window?.endTime || null,
        windowStartUtc: window?.startAt.toISOString() || null,
        windowEndUtc: window?.endAt.toISOString() || null,
        windowTruncated: window?.windowTruncated || false,
        cycleStartedAt: cycleStartedAtIso,
        cycleFinishedAt: cycleFinishedAt.toISOString(),
        leaseOwner: POLLING_LEASE_OWNER,
      },
    }).catch(monitorError => {
      console.error('[presence-polling] monitor failure hook error:', (monitorError as Error).message);
    });
  }
}

async function pollEvents(): Promise<void> {
  await pollEventsOnce(new Date());
}

async function runPollCycle(): Promise<void> {
  if (manualSyncLocks > 0) {
    return;
  }
  if (pollInFlight) {
    return pollInFlight;
  }

  pollInFlight = (async () => {
    let leaseAcquired = false;
    let leaseStartedAt: Date | null = null;
    let stopHeartbeat: (() => void) | null = null;

    try {
      leaseStartedAt = new Date();
      const leaseStartedAtIso = leaseStartedAt.toISOString();
      const lease = await tryAcquireSigurRuntimeLease({
        key: SIGUR_POLLING_STATE_KEY,
        owner: POLLING_LEASE_OWNER,
        ttlSeconds: SIGUR_POLLING_LEASE_TTL_SECONDS,
        meta: {
          leaseMode: 'background_poll',
          inFlightStartedAt: leaseStartedAtIso,
          leaderOwner: POLLING_LEASE_OWNER,
        },
      });
      if (!lease.acquired) {
        return;
      }

      leaseAcquired = true;
      markPresencePollingCycleStarted(leaseStartedAt);
      stopHeartbeat = startSigurRuntimeLeaseHeartbeat({
        key: SIGUR_POLLING_STATE_KEY,
        owner: POLLING_LEASE_OWNER,
        ttlSeconds: SIGUR_POLLING_LEASE_TTL_SECONDS,
        getMeta: () => ({
          leaseMode: 'background_poll',
          inFlightStartedAt: leaseStartedAtIso,
          leaderOwner: POLLING_LEASE_OWNER,
        }),
        onError: error => {
          console.error('[presence-polling] lease heartbeat error:', error.message);
        },
      });

      await pollEvents();
      await backfillUnmatchedEvents();
    } catch (err) {
      console.error('[presence-polling] cycle error:', (err as Error).message);
    } finally {
      if (stopHeartbeat) {
        stopHeartbeat();
      }
      if (leaseAcquired) {
        await mergeSigurRuntimeState({
          key: SIGUR_POLLING_STATE_KEY,
          owner: POLLING_LEASE_OWNER,
          meta: {
            inFlightStartedAt: null,
            lastLeaseReleasedAt: new Date().toISOString(),
          },
        }).catch(error => {
          console.error('[presence-polling] runtime state release hook error:', (error as Error).message);
        });
        await releaseSigurRuntimeLease({
          key: SIGUR_POLLING_STATE_KEY,
          owner: POLLING_LEASE_OWNER,
        }).catch(error => {
          console.error('[presence-polling] lease release error:', (error as Error).message);
        });
        markPresencePollingCycleFinished();
      }
      pollInFlight = null;
    }
  })();

  return pollInFlight;
}

export function startPresencePolling(): void {
  if (pollingTimer || startupTimeout) return;
  if (!sigurService.isConfigured()) {
    console.log('[presence-polling] Sigur not configured, skipping');
    return;
  }
  if (manualSyncLocks > 0) {
    console.log(`[presence-polling] start skipped, locked by manual sync (${manualSyncLocks})`);
    return;
  }
  console.log('[presence-polling] started (interval: 60s)');
  startupTimeout = setTimeout(() => {
    startupTimeout = null;
    void runPollCycle();
  }, 10_000);
  pollingTimer = setInterval(() => {
    void runPollCycle();
  }, POLL_INTERVAL);
}

export function stopPresencePolling(): void {
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
    console.log('[presence-polling] stopped');
  }
}

export async function acquirePresencePollingLock(): Promise<void> {
  if (manualSyncLocks > 0) {
    throw new ManualSyncInProgressError();
  }

  manualSyncLocks = 1;

  try {
    stopPresencePolling();
    if (pollInFlight) {
      await pollInFlight;
    }

    const lockedAt = new Date().toISOString();
    const lease = await tryAcquireSigurRuntimeLease({
      key: SIGUR_POLLING_STATE_KEY,
      owner: MANUAL_SYNC_LEASE_OWNER,
      ttlSeconds: SIGUR_POLLING_LEASE_TTL_SECONDS,
      meta: {
        leaseMode: 'manual_sync',
        manualSyncLockedAt: lockedAt,
        leaderOwner: MANUAL_SYNC_LEASE_OWNER,
      },
    });

    if (!lease.acquired) {
      throw new ManualSyncInProgressError('Фоновая синхронизация Sigur уже выполняется. Дождитесь завершения текущего запуска.');
    }

    manualSyncLeaseHeartbeatStop = startSigurRuntimeLeaseHeartbeat({
      key: SIGUR_POLLING_STATE_KEY,
      owner: MANUAL_SYNC_LEASE_OWNER,
      ttlSeconds: SIGUR_POLLING_LEASE_TTL_SECONDS,
      getMeta: () => ({
        leaseMode: 'manual_sync',
        manualSyncLockedAt: lockedAt,
        leaderOwner: MANUAL_SYNC_LEASE_OWNER,
      }),
      onError: error => {
        console.error('[presence-polling] manual sync lease heartbeat error:', error.message);
      },
    });
  } catch (error) {
    manualSyncLocks = 0;
    startPresencePolling();
    throw error;
  }
}

export async function releasePresencePollingLock(): Promise<void> {
  if (manualSyncLocks === 0) {
    return;
  }

  if (manualSyncLeaseHeartbeatStop) {
    manualSyncLeaseHeartbeatStop();
    manualSyncLeaseHeartbeatStop = null;
  }

  await mergeSigurRuntimeState({
    key: SIGUR_POLLING_STATE_KEY,
    owner: MANUAL_SYNC_LEASE_OWNER,
    meta: {
      manualSyncLockedAt: null,
      lastManualSyncReleasedAt: new Date().toISOString(),
    },
  }).catch(error => {
    console.error('[presence-polling] manual sync release hook error:', (error as Error).message);
  });
  await releaseSigurRuntimeLease({
    key: SIGUR_POLLING_STATE_KEY,
    owner: MANUAL_SYNC_LEASE_OWNER,
  }).catch(error => {
    console.error('[presence-polling] manual sync lease release error:', (error as Error).message);
  });

  manualSyncLocks = 0;
  if (manualSyncLocks === 0) {
    startPresencePolling();
  }
}
