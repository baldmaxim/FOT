import { query, queryOne } from '../config/postgres.js';
import { sigurService } from './sigur.service.js';
import { settingsService, type ISigurMonitorSettings } from './settings.service.js';
import {
  SIGUR_MONITOR_LEASE_TTL_SECONDS,
  SIGUR_MONITOR_STATE_KEY,
  SIGUR_POLLING_STATE_KEY,
  getSigurRuntimeOwner,
  getSigurRuntimeState,
  releaseSigurRuntimeLease,
  startSigurRuntimeLeaseHeartbeat,
  tryAcquireSigurRuntimeLease,
} from './sigur-runtime-state.service.js';
import { isSigurRuntimeAllowed, logSigurRuntimeGuardSkip } from './sigur-runtime-guard.service.js';
import { runWithCronMonitor } from '../utils/sentry-cron.js';

type SigurConnectionType = 'internal' | 'external' | null;
export type SigurMonitorSource = 'presence_polling' | 'monitor_probe' | 'silence_detector';
export type SigurMonitorCheckStatus = 'success' | 'failure' | 'silence';
export type SigurIncidentStatus = 'open' | 'resolved';
export type SigurIncidentSeverity = 'warning' | 'critical';

export interface ISigurHealthCheck {
  id: number;
  checked_at: string;
  source: SigurMonitorSource;
  status: SigurMonitorCheckStatus;
  connection_type: SigurConnectionType;
  response_ms: number | null;
  events_last_window: number | null;
  baseline_events: number | null;
  consecutive_failures: number;
  error_message: string | null;
  meta: Record<string, unknown>;
}

export interface ISigurIncident {
  id: number;
  status: SigurIncidentStatus;
  severity: SigurIncidentSeverity;
  detected_by: SigurMonitorSource;
  started_at: string;
  resolved_at: string | null;
  last_success_at: string | null;
  affected_from: string | null;
  affected_to: string | null;
  connection_type: SigurConnectionType;
  error_message: string | null;
  meta: Record<string, unknown>;
  opened_notification_sent_at: string | null;
  resolved_notification_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

interface IRuntimeState {
  initialized: boolean;
  lastSignalAt: Date | null;
  lastSuccessfulSignalAt: Date | null;
  lastEventFlowAt: Date | null;
  presencePollingInFlightStartedAt: Date | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  consecutiveEventFlowSuccesses: number;
  activeIncident: ISigurIncident | null;
}

interface IHealthSignalInput {
  source: Extract<SigurMonitorSource, 'presence_polling' | 'monitor_probe'>;
  checkedAt?: Date;
  connectionType?: SigurConnectionType;
  responseMs?: number | null;
  eventsLastWindow?: number | null;
  errorMessage?: string | null;
  meta?: Record<string, unknown>;
}

interface IListParams {
  limit: number;
  offset: number;
  status?: string;
  source?: string;
  startDate?: string;
  endDate?: string;
}

const MONITOR_INTERVAL_MS = 60_000;
const MONITOR_STARTUP_DELAY_MS = 15_000;
const MONITOR_STALE_SIGNAL_MS = 2 * 60_000;
const SIGUR_MONITOR_MIGRATION_HINT = 'Таблицы мониторинга Sigur не созданы. Примените миграцию 015_sigur_monitoring.sql';

let monitorTimer: ReturnType<typeof setInterval> | null = null;
let startupTimeout: ReturnType<typeof setTimeout> | null = null;
let cycleInFlight: Promise<void> | null = null;
let monitorStorageAvailable = true;
let monitorStorageWarningLogged = false;
const MONITOR_LEASE_OWNER = getSigurRuntimeOwner(SIGUR_MONITOR_STATE_KEY);
let runtimeState: IRuntimeState = {
  initialized: false,
  lastSignalAt: null,
  lastSuccessfulSignalAt: null,
  lastEventFlowAt: null,
  presencePollingInFlightStartedAt: null,
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
  consecutiveEventFlowSuccesses: 0,
  activeIncident: null,
};

const weekdayMap: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function getFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  });
}

function getDateParts(date: Date, timezone: string) {
  const parts = getFormatter(timezone).formatToParts(date);
  const values: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      values[part.type] = part.value;
    }
  }

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    weekday: weekdayMap[values.weekday] ?? 0,
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}:${values.second}`,
  };
}

function zonedLocalDateTimeToUtc(dateStr: string, timeStr: string, timezone: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, minute, second = 0] = timeStr.split(':').map(Number);
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const localParts = getDateParts(utcGuess, timezone);
  const desiredUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const observedUtcMs = Date.UTC(
    localParts.year,
    localParts.month - 1,
    localParts.day,
    localParts.hour,
    localParts.minute,
    localParts.second,
  );

  return new Date(utcGuess.getTime() + (desiredUtcMs - observedUtcMs));
}

function parseStoredEventTimestamp(eventDate: string, eventTime: string, timezone: string): Date {
  return zonedLocalDateTimeToUtc(eventDate, eventTime, timezone);
}

function addMinutesToTime(time: string, minutesToAdd: number): string {
  const [hours, minutes, seconds = 0] = time.split(':').map(Number);
  const totalMinutes = hours * 60 + minutes + minutesToAdd;
  const safeMinutes = Math.max(0, Math.min(totalMinutes, 24 * 60 - 1));
  const nextHours = Math.floor(safeMinutes / 60);
  const nextMinutes = safeMinutes % 60;

  return `${String(nextHours).padStart(2, '0')}:${String(nextMinutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }

  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function parseOptionalIsoDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildLookbackDates(localDate: string, localWeekday: number, lookbackDays: number): string[] {
  const cursor = new Date(`${localDate}T00:00:00Z`);
  const result: string[] = [];

  for (let i = 1; i <= lookbackDays; i++) {
    const candidate = new Date(cursor);
    candidate.setUTCDate(candidate.getUTCDate() - i);
    if (candidate.getUTCDay() !== localWeekday) continue;
    result.push(candidate.toISOString().slice(0, 10));
  }

  return result;
}

function isMissingMonitorTableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: string; message?: string | null; details?: string | null };

  return candidate.code === '42P01'
    || candidate.code === 'PGRST205'
    || candidate.message?.includes('schema cache')
    || candidate.message?.includes('does not exist')
    || candidate.details?.includes('does not exist')
    || false;
}

function markMonitorStorageUnavailable(error: unknown): void {
  monitorStorageAvailable = false;
  runtimeState.initialized = true;

  if (monitorStorageWarningLogged) return;
  monitorStorageWarningLogged = true;

  const message = error instanceof Error ? error.message : SIGUR_MONITOR_MIGRATION_HINT;
  console.warn(`[sigur-monitor] storage disabled: ${message}. ${SIGUR_MONITOR_MIGRATION_HINT}`);
}

function ensureMonitorStorageAvailableOrThrow(): void {
  if (!monitorStorageAvailable) {
    throw new Error(SIGUR_MONITOR_MIGRATION_HINT);
  }
}

async function getOpenIncident(): Promise<ISigurIncident | null> {
  try {
    const row = await queryOne<ISigurIncident>(
      `SELECT * FROM sigur_incidents WHERE status = 'open' ORDER BY started_at DESC LIMIT 1`,
    );
    return row;
  } catch (error) {
    throw new Error(`Failed to load active Sigur incident: ${(error as Error).message}`);
  }
}

async function getLatestSuccessCheck(): Promise<ISigurHealthCheck | null> {
  try {
    const row = await queryOne<ISigurHealthCheck>(
      `SELECT * FROM sigur_health_checks WHERE status = 'success' ORDER BY checked_at DESC LIMIT 1`,
    );
    return row;
  } catch (error) {
    throw new Error(`Failed to load latest Sigur success check: ${(error as Error).message}`);
  }
}

async function getRecentChecks(limit: number): Promise<ISigurHealthCheck[]> {
  try {
    const rows = await query<ISigurHealthCheck>(
      `SELECT * FROM sigur_health_checks ORDER BY checked_at DESC LIMIT $1`,
      [limit],
    );
    return rows;
  } catch (error) {
    throw new Error(`Failed to load recent Sigur health checks: ${(error as Error).message}`);
  }
}

async function getLatestEventFlowAt(timezone: string): Promise<Date | null> {
  try {
    const latest = await queryOne<{ event_date: string; event_time: string }>(
      `SELECT event_date, event_time FROM skud_events
       ORDER BY event_date DESC, event_time DESC LIMIT 1`,
    );
    if (!latest?.event_date || !latest?.event_time) return null;
    return parseStoredEventTimestamp(latest.event_date, latest.event_time, timezone);
  } catch (error) {
    throw new Error(`Failed to load latest Sigur event timestamp: ${(error as Error).message}`);
  }
}

async function ensureRuntimeStateLoaded(): Promise<void> {
  if (runtimeState.initialized) return;

  const config = await settingsService.getSigurMonitorConfig();
  let activeIncident: ISigurIncident | null = null;
  let recentChecks: ISigurHealthCheck[] = [];
  let latestSuccess: ISigurHealthCheck | null = null;
  let lastEventFlowAt: Date | null = null;

  try {
    [activeIncident, recentChecks, latestSuccess, lastEventFlowAt] = await Promise.all([
      getOpenIncident(),
      getRecentChecks(10),
      getLatestSuccessCheck(),
      getLatestEventFlowAt(config.timezone),
    ]);
  } catch (error) {
    if (isMissingMonitorTableError(error)) {
      markMonitorStorageUnavailable(error);
      runtimeState.activeIncident = null;
      runtimeState.lastSignalAt = null;
      runtimeState.lastSuccessfulSignalAt = null;
      runtimeState.lastEventFlowAt = null;
      runtimeState.presencePollingInFlightStartedAt = null;
      runtimeState.consecutiveFailures = 0;
      runtimeState.consecutiveSuccesses = 0;
      runtimeState.consecutiveEventFlowSuccesses = 0;
      return;
    }
    throw error;
  }

  const latestCheck = recentChecks[0] || null;
  runtimeState.activeIncident = activeIncident;
  runtimeState.lastSignalAt = latestCheck ? new Date(latestCheck.checked_at) : null;
  runtimeState.lastSuccessfulSignalAt = latestSuccess ? new Date(latestSuccess.checked_at) : null;
  runtimeState.lastEventFlowAt = lastEventFlowAt;
  runtimeState.consecutiveFailures = latestCheck?.status === 'success' ? 0 : (latestCheck?.consecutive_failures || 0);
  runtimeState.consecutiveSuccesses = 0;
  runtimeState.consecutiveEventFlowSuccesses = 0;

  for (const check of recentChecks) {
    if (check.status !== 'success') break;
    runtimeState.consecutiveSuccesses++;
    if ((check.events_last_window || 0) > 0) {
      runtimeState.consecutiveEventFlowSuccesses++;
    } else {
      break;
    }
  }

  runtimeState.initialized = true;
}

async function refreshRuntimeStateFromPollingState(now = new Date(), timezone?: string): Promise<{
  lastSignalAt: Date | null;
  lastSuccessfulSignalAt: Date | null;
  lastEventFlowAt: Date | null;
  isPresencePollingInFlight: boolean;
  isPresencePollingCatchUpInProgress: boolean;
}> {
  const pollingState = await getSigurRuntimeState(SIGUR_POLLING_STATE_KEY);
  const pollingMeta = pollingState?.meta || {};
  const pollingLastCycle = typeof pollingMeta.lastCycle === 'object' && pollingMeta.lastCycle !== null
    ? pollingMeta.lastCycle as Record<string, unknown>
    : {};
  const lastSignalAt = parseOptionalIsoDate(pollingMeta.lastSignalAt) || runtimeState.lastSignalAt;
  const lastSuccessfulSignalAt = parseOptionalIsoDate(pollingMeta.lastSuccessAt) || runtimeState.lastSuccessfulSignalAt;
  const sharedLastEventFlowAt = parseOptionalIsoDate(pollingMeta.lastEventFlowAt);
  const lastEventFlowAt = sharedLastEventFlowAt || runtimeState.lastEventFlowAt || (timezone ? await getLatestEventFlowAt(timezone) : null);
  const checkpointAt = parseOptionalIsoDate(pollingState?.checkpoint_at);
  const leaseExpiresAt = parseOptionalIsoDate(pollingState?.lease_expires_at);
  const isPresencePollingInFlight = !!(pollingState?.lease_owner && leaseExpiresAt && leaseExpiresAt.getTime() > now.getTime());
  const isPresencePollingCatchUpInProgress = !isPresencePollingInFlight
    && pollingLastCycle.windowTruncated === true
    && !!checkpointAt
    && !!lastSignalAt
    && (now.getTime() - lastSignalAt.getTime()) < MONITOR_STALE_SIGNAL_MS
    && checkpointAt.getTime() < now.getTime();

  runtimeState.lastSignalAt = lastSignalAt;
  runtimeState.lastSuccessfulSignalAt = lastSuccessfulSignalAt;
  runtimeState.lastEventFlowAt = lastEventFlowAt;
  runtimeState.presencePollingInFlightStartedAt = isPresencePollingInFlight
    ? (parseOptionalIsoDate(pollingMeta.inFlightStartedAt) || now)
    : null;

  return {
    lastSignalAt,
    lastSuccessfulSignalAt,
    lastEventFlowAt,
    isPresencePollingInFlight,
    isPresencePollingCatchUpInProgress,
  };
}

async function insertHealthCheck(row: Omit<ISigurHealthCheck, 'id' | 'checked_at'> & { checked_at?: string }): Promise<ISigurHealthCheck> {
  try {
    const data = await queryOne<ISigurHealthCheck>(
      `INSERT INTO sigur_health_checks
       (checked_at, source, status, connection_type, response_ms, events_last_window,
        baseline_events, consecutive_failures, error_message, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       RETURNING *`,
      [
        row.checked_at || new Date().toISOString(),
        row.source,
        row.status,
        row.connection_type,
        row.response_ms ?? null,
        row.events_last_window ?? null,
        row.baseline_events ?? null,
        row.consecutive_failures,
        row.error_message ?? null,
        JSON.stringify(row.meta ?? {}),
      ],
    );
    if (!data) throw new Error('No row returned after insert');
    return data;
  } catch (error) {
    throw new Error(`Failed to insert Sigur health check: ${(error as Error).message}`);
  }
}

async function updateIncident(id: number, patch: Partial<ISigurIncident>): Promise<ISigurIncident> {
  try {
    const fullPatch = { ...patch, updated_at: new Date().toISOString() };
    const keys = Object.keys(fullPatch);
    if (keys.length === 0) {
      const existing = await queryOne<ISigurIncident>(
        'SELECT * FROM sigur_incidents WHERE id = $1',
        [id],
      );
      if (!existing) throw new Error('Incident not found');
      return existing;
    }
    const setParts: string[] = [];
    const params: unknown[] = [];
    for (const key of keys) {
      const value = (fullPatch as Record<string, unknown>)[key];
      params.push(key === 'meta' ? JSON.stringify(value ?? {}) : value);
      const cast = key === 'meta' ? '::jsonb' : '';
      setParts.push(`${key} = $${params.length}${cast}`);
    }
    params.push(id);
    const data = await queryOne<ISigurIncident>(
      `UPDATE sigur_incidents SET ${setParts.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    if (!data) throw new Error('Incident not found after update');
    return data;
  } catch (error) {
    throw new Error(`Failed to update Sigur incident: ${(error as Error).message}`);
  }
}

async function openIncident(params: {
  severity: SigurIncidentSeverity;
  detectedBy: SigurMonitorSource;
  checkedAt: Date;
  connectionType: SigurConnectionType;
  errorMessage: string | null;
  affectedFrom: Date | null;
  meta?: Record<string, unknown>;
}): Promise<ISigurIncident> {
  const payload = {
    status: 'open',
    severity: params.severity,
    detected_by: params.detectedBy,
    started_at: params.checkedAt.toISOString(),
    resolved_at: null,
    last_success_at: runtimeState.lastSuccessfulSignalAt?.toISOString() || null,
    affected_from: params.affectedFrom?.toISOString() || null,
    affected_to: null,
    connection_type: params.connectionType,
    error_message: params.errorMessage,
    meta: params.meta || {},
  };

  try {
    const data = await queryOne<ISigurIncident>(
      `INSERT INTO sigur_incidents
       (status, severity, detected_by, started_at, resolved_at, last_success_at,
        affected_from, affected_to, connection_type, error_message, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       RETURNING *`,
      [
        payload.status,
        payload.severity,
        payload.detected_by,
        payload.started_at,
        payload.resolved_at,
        payload.last_success_at,
        payload.affected_from,
        payload.affected_to,
        payload.connection_type,
        payload.error_message,
        JSON.stringify(payload.meta ?? {}),
      ],
    );
    if (!data) throw new Error('No row returned after insert');
    runtimeState.activeIncident = data;
    return runtimeState.activeIncident;
  } catch (error) {
    throw new Error(`Failed to open Sigur incident: ${(error as Error).message}`);
  }
}

async function resolveIncident(incident: ISigurIncident, checkedAt: Date): Promise<ISigurIncident> {
  const resolved = await updateIncident(incident.id, {
    status: 'resolved',
    resolved_at: checkedAt.toISOString(),
    affected_to: checkedAt.toISOString(),
    last_success_at: checkedAt.toISOString(),
  });

  runtimeState.activeIncident = null;
  return resolved;
}

async function promoteOpenIncidentToCritical(incident: ISigurIncident, params: {
  checkedAt: Date;
  source: Extract<SigurMonitorSource, 'presence_polling' | 'monitor_probe'>;
  connectionType: SigurConnectionType;
  errorMessage: string | null;
  meta?: Record<string, unknown>;
}): Promise<ISigurIncident> {
  const updated = await updateIncident(incident.id, {
    severity: 'critical',
    detected_by: params.source,
    connection_type: params.connectionType,
    error_message: params.errorMessage,
    meta: {
      ...(incident.meta || {}),
      ...(params.meta || {}),
      escalated_at: params.checkedAt.toISOString(),
    },
  });

  runtimeState.activeIncident = updated;
  return updated;
}

function getIncidentRecoveryCount(incident: ISigurIncident): number {
  return incident.detected_by === 'silence_detector'
    ? runtimeState.consecutiveEventFlowSuccesses
    : runtimeState.consecutiveSuccesses;
}

async function maybeOpenFailureIncident(input: Required<Pick<IHealthSignalInput, 'source'>> & {
  checkedAt: Date;
  connectionType: SigurConnectionType;
  errorMessage: string | null;
  meta?: Record<string, unknown>;
}, settings: ISigurMonitorSettings): Promise<void> {
  const activeIncident = runtimeState.activeIncident;
  if (activeIncident) {
    if (activeIncident.severity !== 'critical') {
      await promoteOpenIncidentToCritical(activeIncident, {
        checkedAt: input.checkedAt,
        source: input.source,
        connectionType: input.connectionType,
        errorMessage: input.errorMessage,
        meta: input.meta,
      });
    }
    return;
  }

  if (runtimeState.consecutiveFailures < settings.failureThreshold) {
    return;
  }

  const incident = await openIncident({
    severity: 'critical',
    detectedBy: input.source,
    checkedAt: input.checkedAt,
    connectionType: input.connectionType,
    errorMessage: input.errorMessage,
    affectedFrom: runtimeState.lastSuccessfulSignalAt,
    meta: input.meta,
  });

  runtimeState.activeIncident = incident;
}

async function maybeResolveIncident(settings: ISigurMonitorSettings, checkedAt: Date): Promise<void> {
  const activeIncident = runtimeState.activeIncident;
  if (!activeIncident) return;

  if (getIncidentRecoveryCount(activeIncident) < settings.recoveryThreshold) {
    return;
  }

  await resolveIncident(activeIncident, checkedAt);
}

async function computeSilenceBaseline(now: Date, settings: ISigurMonitorSettings): Promise<{ baselineEvents: number; sampleCount: number; slotStart: string; slotEnd: string }> {
  const localNow = getDateParts(now, settings.timezone);
  const slotMinute = Math.floor(localNow.minute / settings.silenceWindowMinutes) * settings.silenceWindowMinutes;
  const slotStart = `${String(localNow.hour).padStart(2, '0')}:${String(slotMinute).padStart(2, '0')}:00`;
  const slotEnd = addMinutesToTime(slotStart, settings.silenceWindowMinutes);
  const lookbackDates = buildLookbackDates(localNow.date, localNow.weekday, settings.baselineLookbackDays);

  if (lookbackDates.length === 0) {
    return { baselineEvents: 0, sampleCount: 0, slotStart, slotEnd };
  }

  let data: { event_date: string | null }[];
  try {
    data = await query<{ event_date: string | null }>(
      `SELECT event_date FROM skud_events
       WHERE event_date = ANY($1::date[]) AND event_time >= $2 AND event_time < $3`,
      [lookbackDates, slotStart, slotEnd],
    );
  } catch (error) {
    throw new Error(`Failed to compute Sigur silence baseline: ${(error as Error).message}`);
  }

  const counts = new Map<string, number>();
  for (const date of lookbackDates) {
    counts.set(date, 0);
  }

  for (const row of data || []) {
    if (!row.event_date) continue;
    counts.set(row.event_date, (counts.get(row.event_date) || 0) + 1);
  }

  const values = [...counts.values()];
  return {
    baselineEvents: computeMedian(values),
    sampleCount: values.length,
    slotStart,
    slotEnd,
  };
}

async function maybeDetectSilence(now = new Date()): Promise<void> {
  await ensureRuntimeStateLoaded();
  if (!monitorStorageAvailable) return;
  const settings = await settingsService.getSigurMonitorConfig();
  if (!settings.enabled || !runtimeState.lastEventFlowAt || runtimeState.activeIncident) {
    return;
  }

  const silenceMs = now.getTime() - runtimeState.lastEventFlowAt.getTime();
  if (silenceMs < settings.silenceWindowMinutes * 60_000) {
    return;
  }

  const baseline = await computeSilenceBaseline(now, settings);
  if (baseline.baselineEvents < settings.baselineMinEvents) {
    return;
  }

  const errorMessage = `Нет событий Sigur ${Math.round(silenceMs / 60_000)} мин при baseline ${baseline.baselineEvents} событий за слот ${baseline.slotStart}-${baseline.slotEnd}`;
  await insertHealthCheck({
    checked_at: now.toISOString(),
    source: 'silence_detector',
    status: 'silence',
    connection_type: null,
    response_ms: null,
    events_last_window: 0,
    baseline_events: baseline.baselineEvents,
    consecutive_failures: runtimeState.consecutiveFailures,
    error_message: errorMessage,
    meta: {
      sampleCount: baseline.sampleCount,
      slotStart: baseline.slotStart,
      slotEnd: baseline.slotEnd,
      lastEventFlowAt: runtimeState.lastEventFlowAt.toISOString(),
    },
  });

  const incident = await openIncident({
    severity: 'warning',
    detectedBy: 'silence_detector',
    checkedAt: now,
    connectionType: null,
    errorMessage,
    affectedFrom: runtimeState.lastEventFlowAt,
    meta: {
      baselineEvents: baseline.baselineEvents,
      sampleCount: baseline.sampleCount,
      slotStart: baseline.slotStart,
      slotEnd: baseline.slotEnd,
    },
  });

  runtimeState.activeIncident = incident;
}

async function performDirectProbe(now = new Date()): Promise<void> {
  const connectionType = await sigurService.getBackgroundConnectionType();
  const startedAt = Date.now();
  const result = await sigurService.testConnection(connectionType);
  const responseMs = Date.now() - startedAt;
  const checkedAt = new Date();

  if (result.success) {
    await recordSigurMonitorSuccess({
      source: 'monitor_probe',
      checkedAt,
      connectionType: (result.connection || null) as SigurConnectionType,
      responseMs,
      eventsLastWindow: 0,
      meta: {
        probe: true,
        probeStartedAt: now.toISOString(),
        message: result.message,
      },
    });
    return;
  }

  await recordSigurMonitorFailure({
    source: 'monitor_probe',
    checkedAt,
    connectionType: (result.connection || null) as SigurConnectionType,
    responseMs,
    errorMessage: result.message,
    meta: {
      probe: true,
      probeStartedAt: now.toISOString(),
      message: result.message,
    },
  });
}

export function markPresencePollingCycleStarted(startedAt = new Date()): void {
  runtimeState.presencePollingInFlightStartedAt = startedAt;
}

export function markPresencePollingCycleFinished(): void {
  runtimeState.presencePollingInFlightStartedAt = null;
}

export async function recordSigurMonitorSuccess(input: IHealthSignalInput): Promise<void> {
  await ensureRuntimeStateLoaded();

  const settings = await settingsService.getSigurMonitorConfig();
  if (!settings.enabled) return;

  const checkedAt = input.checkedAt || new Date();
  const eventsLastWindow = input.eventsLastWindow ?? 0;
  const lastEventFlowAtFromMeta = parseOptionalIsoDate(input.meta?.lastEventFlowAt)
    || parseOptionalIsoDate(input.meta?.latestObservedEventAt);
  runtimeState.lastSignalAt = checkedAt;
  runtimeState.lastSuccessfulSignalAt = checkedAt;
  runtimeState.consecutiveFailures = 0;
  runtimeState.consecutiveSuccesses += 1;
  if (lastEventFlowAtFromMeta) {
    runtimeState.lastEventFlowAt = lastEventFlowAtFromMeta;
    runtimeState.consecutiveEventFlowSuccesses += 1;
  } else if (eventsLastWindow > 0) {
    runtimeState.lastEventFlowAt = checkedAt;
    runtimeState.consecutiveEventFlowSuccesses += 1;
  } else {
    runtimeState.consecutiveEventFlowSuccesses = 0;
  }

  if (!monitorStorageAvailable) {
    return;
  }

  await insertHealthCheck({
    checked_at: checkedAt.toISOString(),
    source: input.source,
    status: 'success',
    connection_type: input.connectionType ?? null,
    response_ms: input.responseMs ?? null,
    events_last_window: eventsLastWindow,
    baseline_events: null,
    consecutive_failures: 0,
    error_message: null,
    meta: input.meta || {},
  });

  await maybeResolveIncident(settings, checkedAt);
}

export async function recordSigurMonitorFailure(input: IHealthSignalInput): Promise<void> {
  await ensureRuntimeStateLoaded();

  const settings = await settingsService.getSigurMonitorConfig();
  if (!settings.enabled) return;

  const checkedAt = input.checkedAt || new Date();
  runtimeState.lastSignalAt = checkedAt;
  runtimeState.consecutiveFailures += 1;
  runtimeState.consecutiveSuccesses = 0;
  runtimeState.consecutiveEventFlowSuccesses = 0;

  if (!monitorStorageAvailable) {
    return;
  }

  await insertHealthCheck({
    checked_at: checkedAt.toISOString(),
    source: input.source,
    status: 'failure',
    connection_type: input.connectionType ?? null,
    response_ms: input.responseMs ?? null,
    events_last_window: input.eventsLastWindow ?? null,
    baseline_events: null,
    consecutive_failures: runtimeState.consecutiveFailures,
    error_message: input.errorMessage ?? 'Ошибка канала Sigur',
    meta: input.meta || {},
  });

  await maybeOpenFailureIncident({
    source: input.source,
    checkedAt,
    connectionType: input.connectionType ?? null,
    errorMessage: input.errorMessage ?? 'Ошибка канала Sigur',
    meta: input.meta,
  }, settings);
}

export async function getSigurMonitorStatus(): Promise<{
  enabled: boolean;
  latestCheck: ISigurHealthCheck | null;
  activeIncident: ISigurIncident | null;
  lastSignalAt: string | null;
  lastSuccessfulSignalAt: string | null;
  lastEventFlowAt: string | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  consecutiveEventFlowSuccesses: number;
  currentStatus: 'disabled' | 'ok' | 'incident_open';
  settings: ISigurMonitorSettings;
}> {
  await ensureRuntimeStateLoaded();
  const settings = await settingsService.getSigurMonitorConfig();

  if (!monitorStorageAvailable) {
    return {
      enabled: false,
      latestCheck: null,
      activeIncident: null,
      lastSignalAt: runtimeState.lastSignalAt?.toISOString() || null,
      lastSuccessfulSignalAt: runtimeState.lastSuccessfulSignalAt?.toISOString() || null,
      lastEventFlowAt: runtimeState.lastEventFlowAt?.toISOString() || null,
      consecutiveFailures: runtimeState.consecutiveFailures,
      consecutiveSuccesses: runtimeState.consecutiveSuccesses,
      consecutiveEventFlowSuccesses: runtimeState.consecutiveEventFlowSuccesses,
      currentStatus: 'disabled',
      settings,
    };
  }

  const [latestCheck, activeIncident] = await Promise.all([
    getRecentChecks(1).then(rows => rows[0] || null),
    getOpenIncident(),
  ]);

  runtimeState.activeIncident = activeIncident;

  return {
    enabled: settings.enabled,
    latestCheck,
    activeIncident,
    lastSignalAt: runtimeState.lastSignalAt?.toISOString() || null,
    lastSuccessfulSignalAt: runtimeState.lastSuccessfulSignalAt?.toISOString() || null,
    lastEventFlowAt: runtimeState.lastEventFlowAt?.toISOString() || null,
    consecutiveFailures: runtimeState.consecutiveFailures,
    consecutiveSuccesses: runtimeState.consecutiveSuccesses,
    consecutiveEventFlowSuccesses: runtimeState.consecutiveEventFlowSuccesses,
    currentStatus: !settings.enabled ? 'disabled' : (activeIncident ? 'incident_open' : 'ok'),
    settings,
  };
}

export async function listSigurIncidents(params: IListParams): Promise<{ data: ISigurIncident[]; count: number }> {
  ensureMonitorStorageAvailableOrThrow();

  const conditions: string[] = [];
  const qParams: unknown[] = [];

  if (params.status && params.status !== 'all') {
    qParams.push(params.status);
    conditions.push(`status = $${qParams.length}`);
  }
  if (params.source) {
    qParams.push(params.source);
    conditions.push(`detected_by = $${qParams.length}`);
  }
  if (params.startDate) {
    qParams.push(params.startDate);
    conditions.push(`started_at >= $${qParams.length}`);
  }
  if (params.endDate) {
    qParams.push(params.endDate);
    conditions.push(`started_at <= $${qParams.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const rows = await query<ISigurIncident & { full_count: number }>(
      `SELECT *, count(*) OVER ()::int AS full_count
       FROM sigur_incidents
       ${whereClause}
       ORDER BY started_at DESC
       LIMIT ${params.limit} OFFSET ${params.offset}`,
      qParams,
    );
    const count = rows[0]?.full_count ?? 0;
    return {
      data: rows.map(({ full_count: _omit, ...rest }) => rest as unknown as ISigurIncident),
      count,
    };
  } catch (error) {
    throw new Error(`Failed to list Sigur incidents: ${(error as Error).message}`);
  }
}

export async function getSigurIncidentDetails(id: number): Promise<{ incident: ISigurIncident; checks: ISigurHealthCheck[] }> {
  ensureMonitorStorageAvailableOrThrow();

  let incident: ISigurIncident | null;
  try {
    incident = await queryOne<ISigurIncident>(
      'SELECT * FROM sigur_incidents WHERE id = $1',
      [id],
    );
  } catch (error) {
    throw new Error((error as Error).message || 'Sigur incident not found');
  }
  if (!incident) throw new Error('Sigur incident not found');

  const startWindow = new Date(incident.started_at);
  startWindow.setMinutes(startWindow.getMinutes() - 30);
  const endWindow = incident.resolved_at ? new Date(incident.resolved_at) : new Date();
  endWindow.setMinutes(endWindow.getMinutes() + 30);

  let checks: ISigurHealthCheck[];
  try {
    checks = await query<ISigurHealthCheck>(
      `SELECT * FROM sigur_health_checks
       WHERE checked_at >= $1 AND checked_at <= $2
       ORDER BY checked_at DESC
       LIMIT 200`,
      [startWindow.toISOString(), endWindow.toISOString()],
    );
  } catch (checksError) {
    throw new Error(`Failed to load Sigur incident checks: ${(checksError as Error).message}`);
  }

  return {
    incident,
    checks,
  };
}

export async function listSigurHealthChecks(params: IListParams): Promise<{ data: ISigurHealthCheck[]; count: number }> {
  ensureMonitorStorageAvailableOrThrow();

  const conditions: string[] = [];
  const qParams: unknown[] = [];

  if (params.status && params.status !== 'all') {
    qParams.push(params.status);
    conditions.push(`status = $${qParams.length}`);
  }
  if (params.source) {
    qParams.push(params.source);
    conditions.push(`source = $${qParams.length}`);
  }
  if (params.startDate) {
    qParams.push(params.startDate);
    conditions.push(`checked_at >= $${qParams.length}`);
  }
  if (params.endDate) {
    qParams.push(params.endDate);
    conditions.push(`checked_at <= $${qParams.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const rows = await query<ISigurHealthCheck & { full_count: number }>(
      `SELECT *, count(*) OVER ()::int AS full_count
       FROM sigur_health_checks
       ${whereClause}
       ORDER BY checked_at DESC
       LIMIT ${params.limit} OFFSET ${params.offset}`,
      qParams,
    );
    const count = rows[0]?.full_count ?? 0;
    return {
      data: rows.map(({ full_count: _omit, ...rest }) => rest as unknown as ISigurHealthCheck),
      count,
    };
  } catch (error) {
    throw new Error(`Failed to list Sigur health checks: ${(error as Error).message}`);
  }
}

export async function runSigurMonitorCycleNow(now = new Date()): Promise<void> {
  await ensureRuntimeStateLoaded();
  if (!monitorStorageAvailable) return;
  const settings = await settingsService.getSigurMonitorConfig();
  if (!settings.enabled || !(await sigurService.isConfigured())) return;

  const pollingSnapshot = await refreshRuntimeStateFromPollingState(now, settings.timezone);
  const lastSignalAge = pollingSnapshot.lastSignalAt
    ? now.getTime() - pollingSnapshot.lastSignalAt.getTime()
    : Number.POSITIVE_INFINITY;
  const isPresencePollingInFlight = pollingSnapshot.isPresencePollingInFlight;
  const isPresencePollingCatchUpInProgress = pollingSnapshot.isPresencePollingCatchUpInProgress;
  if (!isPresencePollingInFlight && lastSignalAge >= MONITOR_STALE_SIGNAL_MS) {
    await performDirectProbe(now);
  }

  if (isPresencePollingInFlight || isPresencePollingCatchUpInProgress) {
    return;
  }

  await maybeDetectSilence(now);
}

async function runSigurMonitorCycleAsLeader(now = new Date()): Promise<void> {
  const leaseStartedAtIso = now.toISOString();
  const lease = await tryAcquireSigurRuntimeLease({
    key: SIGUR_MONITOR_STATE_KEY,
    owner: MONITOR_LEASE_OWNER,
    ttlSeconds: SIGUR_MONITOR_LEASE_TTL_SECONDS,
    meta: {
      leaseMode: 'monitor',
      inFlightStartedAt: leaseStartedAtIso,
      leaderOwner: MONITOR_LEASE_OWNER,
    },
  });

  if (!lease.acquired) {
    return;
  }

  const stopHeartbeat = startSigurRuntimeLeaseHeartbeat({
    key: SIGUR_MONITOR_STATE_KEY,
    owner: MONITOR_LEASE_OWNER,
    ttlSeconds: SIGUR_MONITOR_LEASE_TTL_SECONDS,
    getMeta: () => ({
      leaseMode: 'monitor',
      inFlightStartedAt: leaseStartedAtIso,
      leaderOwner: MONITOR_LEASE_OWNER,
    }),
    onError: error => {
      console.error('[sigur-monitor] lease heartbeat error:', error.message);
    },
  });

  try {
    await runSigurMonitorCycleNow(now);
  } finally {
    stopHeartbeat();
    await releaseSigurRuntimeLease({
      key: SIGUR_MONITOR_STATE_KEY,
      owner: MONITOR_LEASE_OWNER,
    }).catch(error => {
      console.error('[sigur-monitor] lease release error:', (error as Error).message);
    });
  }
}

export async function startSigurMonitor(): Promise<void> {
  if (monitorTimer || startupTimeout) return;
  if (!(await sigurService.isConfigured())) {
    console.log('[sigur-monitor] Sigur not configured, skipping');
    return;
  }
  if (!isSigurRuntimeAllowed()) {
    logSigurRuntimeGuardSkip('sigur-monitor');
    return;
  }

  console.log('[sigur-monitor] started (interval: 60s)');
  startupTimeout = setTimeout(() => {
    startupTimeout = null;
    void runSigurMonitorCycleWithCronMonitor().catch(error => {
      console.error('[sigur-monitor] startup error:', (error as Error).message);
    });
  }, MONITOR_STARTUP_DELAY_MS);

  monitorTimer = setInterval(() => {
    if (cycleInFlight) return;
    cycleInFlight = runSigurMonitorCycleWithCronMonitor()
      .catch(error => {
        console.error('[sigur-monitor] cycle error:', (error as Error).message);
      })
      .finally(() => {
        cycleInFlight = null;
      });
  }, MONITOR_INTERVAL_MS);
}

async function runSigurMonitorCycleWithCronMonitor(now = new Date()): Promise<void> {
  await runWithCronMonitor(
    'sigur-monitor',
    () => runSigurMonitorCycleAsLeader(now),
    {
      schedule: { type: 'interval', value: 1, unit: 'minute' },
      checkinMargin: 2,
      maxRuntime: 5,
    },
  );
}

export function stopSigurMonitor(): void {
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}

export function resetSigurMonitorStateForTests(): void {
  stopSigurMonitor();
  cycleInFlight = null;
  monitorStorageAvailable = true;
  monitorStorageWarningLogged = false;
  runtimeState = {
    initialized: false,
    lastSignalAt: null,
    lastSuccessfulSignalAt: null,
    lastEventFlowAt: null,
    presencePollingInFlightStartedAt: null,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    consecutiveEventFlowSuccesses: 0,
    activeIncident: null,
  };
}
