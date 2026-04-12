import { supabase } from '../config/database.js';
import { sigurService } from './sigur.service.js';
import { notificationService } from './notification.service.js';
import { settingsService, type ISigurMonitorSettings } from './settings.service.js';

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
  const { data, error } = await supabase
    .from('sigur_incidents')
    .select('*')
    .eq('status', 'open')
    .order('started_at', { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(`Failed to load active Sigur incident: ${error.message}`);
  }

  return ((data || [])[0] || null) as ISigurIncident | null;
}

async function getLatestSuccessCheck(): Promise<ISigurHealthCheck | null> {
  const { data, error } = await supabase
    .from('sigur_health_checks')
    .select('*')
    .eq('status', 'success')
    .order('checked_at', { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(`Failed to load latest Sigur success check: ${error.message}`);
  }

  return ((data || [])[0] || null) as ISigurHealthCheck | null;
}

async function getRecentChecks(limit: number): Promise<ISigurHealthCheck[]> {
  const { data, error } = await supabase
    .from('sigur_health_checks')
    .select('*')
    .order('checked_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to load recent Sigur health checks: ${error.message}`);
  }

  return (data || []) as ISigurHealthCheck[];
}

async function getLatestEventFlowAt(timezone: string): Promise<Date | null> {
  const { data, error } = await supabase
    .from('skud_events')
    .select('event_date, event_time')
    .order('event_date', { ascending: false })
    .order('event_time', { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(`Failed to load latest Sigur event timestamp: ${error.message}`);
  }

  const latest = data?.[0];
  if (!latest?.event_date || !latest?.event_time) {
    return null;
  }

  return parseStoredEventTimestamp(latest.event_date, latest.event_time, timezone);
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

async function insertHealthCheck(row: Omit<ISigurHealthCheck, 'id' | 'checked_at'> & { checked_at?: string }): Promise<ISigurHealthCheck> {
  const payload = {
    checked_at: row.checked_at || new Date().toISOString(),
    source: row.source,
    status: row.status,
    connection_type: row.connection_type,
    response_ms: row.response_ms ?? null,
    events_last_window: row.events_last_window ?? null,
    baseline_events: row.baseline_events ?? null,
    consecutive_failures: row.consecutive_failures,
    error_message: row.error_message ?? null,
    meta: row.meta ?? {},
  };

  const { data, error } = await supabase
    .from('sigur_health_checks')
    .insert(payload)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to insert Sigur health check: ${error.message}`);
  }

  return data as ISigurHealthCheck;
}

async function updateIncident(id: number, patch: Partial<ISigurIncident>): Promise<ISigurIncident> {
  const { data, error } = await supabase
    .from('sigur_incidents')
    .update({
      ...patch,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update Sigur incident: ${error.message}`);
  }

  return data as ISigurIncident;
}

async function listAlertRecipients(): Promise<string[]> {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('id')
    .eq('is_approved', true)
    .in('position_type', ['admin', 'super_admin']);

  if (error) {
    throw new Error(`Failed to load Sigur incident recipients: ${error.message}`);
  }

  return (data || []).map(user => user.id);
}

async function shouldSendOpenNotification(now: Date, settings: ISigurMonitorSettings): Promise<boolean> {
  const { data, error } = await supabase
    .from('sigur_incidents')
    .select('opened_notification_sent_at')
    .not('opened_notification_sent_at', 'is', null)
    .order('opened_notification_sent_at', { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(`Failed to load Sigur notification cooldown state: ${error.message}`);
  }

  const lastSentAt = data?.[0]?.opened_notification_sent_at;
  if (!lastSentAt) return true;

  return now.getTime() - new Date(lastSentAt).getTime() >= settings.alertCooldownMinutes * 60_000;
}

async function sendIncidentOpenedNotification(incident: ISigurIncident, settings: ISigurMonitorSettings): Promise<ISigurIncident> {
  if (!(await shouldSendOpenNotification(new Date(), settings))) {
    return incident;
  }

  const recipients = await listAlertRecipients();
  if (recipients.length === 0) return incident;

  const title = incident.severity === 'critical'
    ? 'Сбой подключения к Sigur'
    : 'Аномалия потока событий Sigur';

  const body = incident.severity === 'critical'
    ? 'Канал Sigur недоступен или отвечает с ошибкой. Проверьте интеграцию и журнал мониторинга.'
    : 'В ожидаемое рабочее окно пропали события Sigur. Проверьте журнал и затронутое окно времени.';

  await notificationService.createMany(recipients.map(userId => ({
    userId,
    type: 'sigur_incident_opened',
    title,
    body,
    metadata: {
      incidentId: incident.id,
      severity: incident.severity,
      detectedBy: incident.detected_by,
      startedAt: incident.started_at,
      affectedFrom: incident.affected_from,
    },
  })));

  return updateIncident(incident.id, {
    opened_notification_sent_at: new Date().toISOString(),
  });
}

async function sendIncidentResolvedNotification(incident: ISigurIncident): Promise<ISigurIncident> {
  const recipients = await listAlertRecipients();
  if (recipients.length === 0) return incident;

  await notificationService.createMany(recipients.map(userId => ({
    userId,
    type: 'sigur_incident_resolved',
    title: 'Sigur восстановлен',
    body: 'Канал Sigur снова работает. Проверьте журнал инцидента и при необходимости скорректируйте табель.',
    metadata: {
      incidentId: incident.id,
      severity: incident.severity,
      resolvedAt: incident.resolved_at,
      affectedFrom: incident.affected_from,
      affectedTo: incident.affected_to,
    },
  })));

  return updateIncident(incident.id, {
    resolved_notification_sent_at: new Date().toISOString(),
  });
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

  const { data, error } = await supabase
    .from('sigur_incidents')
    .insert(payload)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to open Sigur incident: ${error.message}`);
  }

  runtimeState.activeIncident = data as ISigurIncident;
  return runtimeState.activeIncident;
}

async function resolveIncident(incident: ISigurIncident, checkedAt: Date): Promise<ISigurIncident> {
  const resolved = await updateIncident(incident.id, {
    status: 'resolved',
    resolved_at: checkedAt.toISOString(),
    affected_to: checkedAt.toISOString(),
    last_success_at: checkedAt.toISOString(),
  });

  runtimeState.activeIncident = null;
  return sendIncidentResolvedNotification(resolved);
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

  runtimeState.activeIncident = await sendIncidentOpenedNotification(incident, settings);
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

  const { data, error } = await supabase
    .from('skud_events')
    .select('event_date')
    .in('event_date', lookbackDates)
    .gte('event_time', slotStart)
    .lt('event_time', slotEnd);

  if (error) {
    throw new Error(`Failed to compute Sigur silence baseline: ${error.message}`);
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

  runtimeState.activeIncident = await sendIncidentOpenedNotification(incident, settings);
}

async function performDirectProbe(now = new Date()): Promise<void> {
  const connectionType = sigurService.getBackgroundConnectionType();
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
  runtimeState.lastSignalAt = checkedAt;
  runtimeState.lastSuccessfulSignalAt = checkedAt;
  runtimeState.consecutiveFailures = 0;
  runtimeState.consecutiveSuccesses += 1;
  if (eventsLastWindow > 0) {
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

  let query = supabase
    .from('sigur_incidents')
    .select('*', { count: 'exact' })
    .order('started_at', { ascending: false })
    .range(params.offset, params.offset + params.limit - 1);

  if (params.status && params.status !== 'all') {
    query = query.eq('status', params.status);
  }
  if (params.source) {
    query = query.eq('detected_by', params.source);
  }
  if (params.startDate) {
    query = query.gte('started_at', params.startDate);
  }
  if (params.endDate) {
    query = query.lte('started_at', params.endDate);
  }

  const { data, error, count } = await query;
  if (error) {
    throw new Error(`Failed to list Sigur incidents: ${error.message}`);
  }

  return {
    data: (data || []) as ISigurIncident[],
    count: count || 0,
  };
}

export async function getSigurIncidentDetails(id: number): Promise<{ incident: ISigurIncident; checks: ISigurHealthCheck[] }> {
  ensureMonitorStorageAvailableOrThrow();

  const { data, error } = await supabase
    .from('sigur_incidents')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) {
    throw new Error(error?.message || 'Sigur incident not found');
  }

  const incident = data as ISigurIncident;
  const startWindow = new Date(incident.started_at);
  startWindow.setMinutes(startWindow.getMinutes() - 30);
  const endWindow = incident.resolved_at ? new Date(incident.resolved_at) : new Date();
  endWindow.setMinutes(endWindow.getMinutes() + 30);

  const { data: checks, error: checksError } = await supabase
    .from('sigur_health_checks')
    .select('*')
    .gte('checked_at', startWindow.toISOString())
    .lte('checked_at', endWindow.toISOString())
    .order('checked_at', { ascending: false })
    .limit(200);

  if (checksError) {
    throw new Error(`Failed to load Sigur incident checks: ${checksError.message}`);
  }

  return {
    incident,
    checks: (checks || []) as ISigurHealthCheck[],
  };
}

export async function listSigurHealthChecks(params: IListParams): Promise<{ data: ISigurHealthCheck[]; count: number }> {
  ensureMonitorStorageAvailableOrThrow();

  let query = supabase
    .from('sigur_health_checks')
    .select('*', { count: 'exact' })
    .order('checked_at', { ascending: false })
    .range(params.offset, params.offset + params.limit - 1);

  if (params.status && params.status !== 'all') {
    query = query.eq('status', params.status);
  }
  if (params.source) {
    query = query.eq('source', params.source);
  }
  if (params.startDate) {
    query = query.gte('checked_at', params.startDate);
  }
  if (params.endDate) {
    query = query.lte('checked_at', params.endDate);
  }

  const { data, error, count } = await query;
  if (error) {
    throw new Error(`Failed to list Sigur health checks: ${error.message}`);
  }

  return {
    data: (data || []) as ISigurHealthCheck[],
    count: count || 0,
  };
}

export async function runSigurMonitorCycleNow(now = new Date()): Promise<void> {
  await ensureRuntimeStateLoaded();
  if (!monitorStorageAvailable) return;
  const settings = await settingsService.getSigurMonitorConfig();
  if (!settings.enabled || !sigurService.isConfigured()) return;

  const lastSignalAge = runtimeState.lastSignalAt ? now.getTime() - runtimeState.lastSignalAt.getTime() : Number.POSITIVE_INFINITY;
  const isPresencePollingInFlight = runtimeState.presencePollingInFlightStartedAt !== null;
  if (!isPresencePollingInFlight && lastSignalAge >= MONITOR_STALE_SIGNAL_MS) {
    await performDirectProbe(now);
  }

  await maybeDetectSilence(now);
}

export function startSigurMonitor(): void {
  if (monitorTimer || startupTimeout) return;
  if (!sigurService.isConfigured()) {
    console.log('[sigur-monitor] Sigur not configured, skipping');
    return;
  }

  console.log('[sigur-monitor] started (interval: 60s)');
  startupTimeout = setTimeout(() => {
    startupTimeout = null;
    void runSigurMonitorCycleNow().catch(error => {
      console.error('[sigur-monitor] startup error:', (error as Error).message);
    });
  }, MONITOR_STARTUP_DELAY_MS);

  monitorTimer = setInterval(() => {
    if (cycleInFlight) return;
    cycleInFlight = runSigurMonitorCycleNow()
      .catch(error => {
        console.error('[sigur-monitor] cycle error:', (error as Error).message);
      })
      .finally(() => {
        cycleInFlight = null;
      });
  }, MONITOR_INTERVAL_MS);
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
