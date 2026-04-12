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
import type { ConnectionType } from './sigur.service.js';

const POLL_INTERVAL = 60_000;
const EMPLOYEE_CACHE_TTL = 10 * 60_000;
const BATCH_SIZE = 500;
export const POLL_OVERLAP_MS = 2 * 60_000;

let pollingTimer: ReturnType<typeof setInterval> | null = null;
let startupTimeout: ReturnType<typeof setTimeout> | null = null;
let manualSyncLocks = 0;
let pollInFlight: Promise<void> | null = null;
let lastSuccessfulPollAt: Date | null = null;

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

type PollCheckpointSource = 'memory' | 'db' | 'fallback';

interface PollingWindow {
  startTime: string;
  endTime: string;
  startDate: string;
  endDate: string;
  checkpointSource: PollCheckpointSource;
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
  let checkpoint = lastSuccessfulPollAt;

  if (checkpoint) {
    checkpointSource = 'memory';
  } else {
    checkpoint = await getLatestStoredEventTimestamp();
    if (checkpoint) {
      checkpointSource = 'db';
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

  // Лог catch-up при значительном gap
  if (checkpoint && checkpointSource === 'db') {
    const gapMinutes = Math.round((now.getTime() - checkpoint.getTime()) / 60_000);
    if (gapMinutes > 5) {
      console.log(`[presence-polling] catch-up: recovering ${gapMinutes}m gap from ${formatLocalDateTime(checkpoint)} to ${formatLocalDateTime(now)}`);
    }
  }

  return {
    startTime: formatLocalDateTime(start),
    endTime: formatLocalDateTime(now),
    startDate: formatLocalDate(start),
    endDate: formatLocalDate(now),
    checkpointSource,
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
  lastSuccessfulPollAt = null;
  employeeCache = null;
}

export async function pollEventsOnce(now = new Date()): Promise<void> {
  const cycleStartedAt = Date.now();
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

    for (const raw of rawEvents) {
      const mapped = mapSigurEvent(raw as Record<string, unknown>);
      if (!mapped || !mapped.physicalPerson) continue;

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
        event_at: buildMoscowEventTimestamp(mapped.eventDate, mapped.eventTime),
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
    for (let i = 0; i < inserts.length; i += BATCH_SIZE) {
      const batch = inserts.slice(i, i + BATCH_SIZE);
      const { error } = await supabase
        .from('skud_events')
        .upsert(batch, { onConflict: 'dedup_hash,event_date', ignoreDuplicates: true });
      if (error) {
        console.error('[presence-polling] insert error:', error.message);
      } else {
        totalInserted += batch.length;
      }
    }

    if (summariesToUpdate.size > 0) {
      const pairs = [...summariesToUpdate].map(key => {
        const [empId, date] = key.split(':');
        return { emp_id: parseInt(empId, 10), date };
      });
      await supabase.rpc('batch_recalculate_skud_daily_summary', { p_pairs: pairs });
    }

    // После успешного цикла сбрасываем кэши presence/dashboard, чтобы пользователи
    // увидели актуальные входы/выходы. Без этого данные отстают до TTL.
    if (totalInserted > 0 || summariesToUpdate.size > 0) {
      invalidatePresenceCache();
      invalidateDashboardCache();
    }

    lastSuccessfulPollAt = now;
    const monitorCheckedAt = new Date();
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
        connectionType,
        checkpointSource: window.checkpointSource,
        windowStart: window.startTime,
        windowEnd: window.endTime,
        fetched: rawEvents.length,
        inserted: totalInserted,
        unmatched: storedUnmatched,
        summaries: summariesToUpdate.size,
      },
    }).catch(error => {
      console.error('[presence-polling] monitor success hook error:', (error as Error).message);
    });
  } catch (error) {
    console.error('[presence-polling] error:', (error as Error).message);
    const monitorCheckedAt = new Date();
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
    markPresencePollingCycleStarted(new Date());
    try {
      await pollEvents();
      await backfillUnmatchedEvents();
    } catch (err) {
      console.error('[presence-polling] cycle error:', (err as Error).message);
    } finally {
      markPresencePollingCycleFinished();
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
  stopPresencePolling();
  if (pollInFlight) {
    await pollInFlight;
  }
}

export function releasePresencePollingLock(): void {
  if (manualSyncLocks === 0) {
    return;
  }

  manualSyncLocks = 0;
  if (manualSyncLocks === 0) {
    startPresencePolling();
  }
}
