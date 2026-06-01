import * as Sentry from '@sentry/node';
import { sigurService } from './sigur.service.js';
import { query, queryOne, execute } from '../config/postgres.js';
import { getDbInflight, withDbSlot } from '../config/db-instrumentation.js';
import { env } from '../config/env.js';
import { mapSigurEvent } from '../utils/sigur.mapper.js';
import { computeDedupHash, computeFailureDedupHash } from '../utils/dedup.utils.js';
import { buildMoscowEventTimestamp } from '../utils/date.utils.js';
import { backfillUnmatchedEvents } from './skud-backfill.service.js';
import { normalizePersonName } from './sigur-sync-shared.js';
import { notifySkudRealtimeChanged } from './skud-realtime.service.js';
import {
  getEmployeeCache,
  setEmployeeCache,
  invalidatePresencePollingEmployeeCache,
} from './presence-polling-cache.service.js';
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
import {
  assertSigurRuntimeAllowed,
  logSigurRuntimeGuardSkip,
} from './sigur-runtime-guard.service.js';
import type { ConnectionType } from './sigur.service.js';
import { runWithCronMonitor } from '../utils/sentry-cron.js';

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MIN_POLL_INTERVAL_MS = 5_000;
const POLL_IDLE_INTERVAL_MS = 30_000;
const POLL_IDLE_THRESHOLD = 5;
const EMPLOYEE_CACHE_TTL = 10 * 60_000;
const BATCH_SIZE = 200;
const BATCH_DELAY_MS = 75;
const SUMMARY_BATCH = 100;
const SUMMARY_DELAY_MS = 100;
const BATCH_CONCURRENCY = 2;
// Backpressure-пороги: сравнение с инструментированным счётчиком inflight Supabase-запросов.
// При SOFT — занижаем concurrency до 1 и ждём 200мс перед следующим батчем (даём UI пройти).
// При HARD — ранний break outer-цикла; partial checkpoint подберёт остаток на следующем тике.
// Поднято после инцидента «отделы пропадают на /timesheet, бэк не успевает обрабатывать».
const SLOT_SOFT_LIMIT = 8;
const SLOT_HARD_LIMIT = 13;
// Останавливаем обработку батчей в цикле, если он перешёл этот порог: дальнейшие
// UPSERT-вызовы продолжают занимать connection slots Supabase и блокируют UI-запросы
// (selector отделов на /timesheet, /api/skud/presence). Partial checkpoint логика
// уже умеет завершить цикл с lastSuccessfulEventAt и доделать остаток на следующем тике.
// Бюджет на ВЕСЬ цикл (fetch + insert + summary). Реальный tFetch от Sigur
// 5-10s даже на 5 событий (lastId-mode) — это вне нашего кода. 25s оставляет
// нам ~15s на запись/recalc и не превращает каждый Sigur-тормоз в partial.
const CYCLE_TIME_BUDGET_MS = 25_000;
const RETRY_BACKOFF_MS = [400, 1200];
export const POLL_OVERLAP_MS = 2 * 60_000;
const POLL_MAX_WINDOW_MS = 10 * 60_000;
const SIGUR_EXCLUSIVE_SYNC_STATE_KEY = 'sigur_exclusive_sync';
const SIGUR_EVENTS_SYNC_STATE_KEY = 'sigur_events_sync';
const SIGUR_STRUCTURE_SYNC_STATE_KEY = 'sigur_structure_sync';
const EXCLUSIVE_SYNC_ACQUIRE_TIMEOUT_MS = 45_000;
const STRUCTURE_SYNC_WAIT_TIMEOUT_MS = 10 * 60_000;
const EXCLUSIVE_SYNC_ACQUIRE_RETRY_MS = 1_000;

let pollingTimer: ReturnType<typeof setTimeout> | null = null;
let pollingActive = false;
let consecutiveEmptyTicks = 0;
// Sigur стабильно отдаёт ~3 мусорных события на 1000 (event_date='2000-01-01' и т.п.).
// Без rate-limit Sentry получает warning на каждом активном тике — заглушает
// видимость реальных проблем. Раз в час достаточно, чтобы заметить «стало хуже».
let lastQuarantineSentryAt = 0;
const QUARANTINE_SENTRY_INTERVAL_MS = 60 * 60_000;
// Sigur 46.38.49.169:9555 моргает ECONNREFUSED/503 — внешний сервис. Без rate-limit
// presence-polling шлёт error на каждом тике (FOT-SERVER-15: 135+ событий/неделю).
// Сводим к одному warning раз в 5 минут на процесс: видимость остаётся, шум падает.
const SIGUR_UNREACHABLE_CAPTURE_INTERVAL_MS = 5 * 60_000;
let lastSigurUnreachableCaptureAt = 0;

const SIGUR_NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

const SIGUR_NETWORK_HTTP_STATUS = new Set([502, 503, 504]);

function isSigurNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: string; response?: { status?: number }; message?: string };
  if (e.code && SIGUR_NETWORK_ERROR_CODES.has(e.code)) return true;
  if (e.response && typeof e.response.status === 'number' && SIGUR_NETWORK_HTTP_STATUS.has(e.response.status)) return true;
  // axios иногда не сохраняет code на дочерней ошибке после нескольких ретраев —
  // ловим по сообщению "connect ECONNREFUSED ip:port" / "Request failed with status code 503".
  const msg = e.message || '';
  if (/ECONN(REFUSED|RESET)|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(msg)) return true;
  if (/status code (502|503|504)/i.test(msg)) return true;
  return false;
}
let startupTimeout: ReturnType<typeof setTimeout> | null = null;
let manualSyncLocks = 0;
let pollInFlight: Promise<void> | null = null;
let manualSyncLeaseHeartbeatStop: (() => void) | null = null;
let exclusiveSyncLeaseHeartbeatStop: (() => void) | null = null;
let eventsSyncLeaseHeartbeatStop: (() => void) | null = null;
let structureSyncLeaseHeartbeatStop: (() => void) | null = null;
let eventsSyncLocks = 0;

const POLLING_LEASE_OWNER = getSigurRuntimeOwner(SIGUR_POLLING_STATE_KEY);
const EXCLUSIVE_SYNC_LEASE_OWNER = getSigurRuntimeOwner(SIGUR_EXCLUSIVE_SYNC_STATE_KEY);
const EVENTS_SYNC_LEASE_OWNER = getSigurRuntimeOwner(SIGUR_EVENTS_SYNC_STATE_KEY);
const STRUCTURE_SYNC_LEASE_OWNER = getSigurRuntimeOwner(SIGUR_STRUCTURE_SYNC_STATE_KEY);
const MANUAL_SYNC_LEASE_OWNER = `${POLLING_LEASE_OWNER}:manual`;

export class ManualSyncInProgressError extends Error {
  readonly code = 'SYNC_IN_PROGRESS';
  readonly status = 409;

  constructor(message = 'Ручная синхронизация уже выполняется. Дождитесь завершения текущего запуска.') {
    super(message);
    this.name = 'ManualSyncInProgressError';
  }
}

interface EmployeeMaps {
  byName: Map<string, { id: number }>;
  bySigurId: Map<number, { id: number }>;
  byUniqueName: Map<string, { id: number }>;
}

export { invalidatePresencePollingEmployeeCache };

type PollCheckpointSource = 'runtime_state' | 'stored_events' | 'fallback' | 'last_event_id';

interface PollingWindow {
  // 'lastId': incremental polling по cursor (быстрый, default после первого тика).
  // 'window': первый старт без lastEventId — fallback на окно по времени.
  mode: 'lastId' | 'window';
  lastEventId: number | null;
  startAt: Date;
  endAt: Date;
  startTime: string;
  endTime: string;
  startDate: string;
  endDate: string;
  checkpointSource: PollCheckpointSource;
  windowTruncated: boolean;
}

export function resolvePresencePollIntervalMs(): number {
  const parsed = Number.parseInt(env.SIGUR_PRESENCE_POLL_INTERVAL_MS, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_POLL_INTERVAL_MS;
  }
  return Math.max(MIN_POLL_INTERVAL_MS, parsed);
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
  const existing = getEmployeeCache();
  if (existing && (Date.now() - existing.fetchedAt) < EMPLOYEE_CACHE_TTL) {
    return existing;
  }

  const data = await query<{ id: number; full_name: string | null; sigur_employee_id: number | null }>(
    'SELECT id, full_name, sigur_employee_id FROM employees WHERE is_archived = false',
  );

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

  const next = { byName, bySigurId, byUniqueName, fetchedAt: Date.now() };
  setEmployeeCache(next);
  console.log(`[presence-polling] cached ${byName.size} employees`);
  return next;
}

async function getLatestStoredEventTimestamp(): Promise<Date | null> {
  let latest: { event_date: string | null; event_time: string | null } | null;
  try {
    latest = await queryOne<{ event_date: string | null; event_time: string | null }>(
      `SELECT event_date, event_time FROM skud_events
       ORDER BY event_date DESC, event_time DESC LIMIT 1`,
    );
  } catch (error) {
    throw new Error(`[presence-polling] failed to read latest stored event: ${(error as Error).message}`);
  }

  if (!latest?.event_date || !latest?.event_time) {
    return null;
  }

  return parseStoredEventTimestamp(latest.event_date, latest.event_time);
}

function readLastEventIdFromMeta(meta: Record<string, unknown> | null | undefined): number | null {
  const raw = meta?.lastEventId;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.floor(raw);
}

export async function resolvePollingWindow(now = new Date()): Promise<PollingWindow> {
  let checkpointSource: PollCheckpointSource = 'fallback';
  let checkpoint: Date | null = null;

  const runtimeState = await getSigurRuntimeState(SIGUR_POLLING_STATE_KEY);

  // Fast path: incremental polling через lastId. Sigur делает индексный seek
  // `WHERE id > X` вместо тяжёлого `WHERE timestamp BETWEEN ?` — на пустых тиках
  // ответ ~миллисекунды. lastEventId сохраняется в meta после каждого успешного цикла.
  const metaLastEventId = readLastEventIdFromMeta(runtimeState?.meta);
  if (metaLastEventId != null) {
    const startTimeStr = formatLocalDateTime(now);
    return {
      mode: 'lastId',
      lastEventId: metaLastEventId,
      startAt: now,
      endAt: now,
      startTime: startTimeStr,
      endTime: startTimeStr,
      startDate: formatLocalDate(now),
      endDate: formatLocalDate(now),
      checkpointSource: 'last_event_id',
      windowTruncated: false,
    };
  }

  if (runtimeState?.checkpoint_at) {
    const parsed = new Date(runtimeState.checkpoint_at);
    if (!Number.isNaN(parsed.getTime())) {
      checkpoint = parsed;
      checkpointSource = 'runtime_state';
    }
  }

  // Защита: если в БД оказался checkpoint в будущем (например, после процесса
  // с рассинхроном часов до фикса), игнорируем его и опираемся на stored_events.
  if (checkpoint && checkpoint.getTime() > now.getTime() + 60_000) {
    console.warn(
      `[presence-polling] runtime_state checkpoint ${checkpoint.toISOString()} is in the future, falling back`,
    );
    checkpoint = null;
    checkpointSource = 'fallback';
  }

  if (!checkpoint) {
    checkpoint = await getLatestStoredEventTimestamp();
    if (checkpoint) {
      checkpointSource = 'stored_events';
    }
  }

  // Если checkpoint старше 7 суток — ограничиваем catch-up последними 7 днями.
  // Раньше было 72ч, но после длительных простоев теряли события «ночной»/выходных.
  // Daily-scheduler параллельно покрывает текущий месяц, а backfill дотянет unmatched.
  const todayStart = startOfLocalDay(now);
  const MAX_CATCHUP_MS = 7 * 24 * 60 * 60 * 1000;
  if (checkpoint && (now.getTime() - checkpoint.getTime()) > MAX_CATCHUP_MS) {
    const gapMinutes = Math.round((now.getTime() - checkpoint.getTime()) / 60_000);
    const floor = new Date(now.getTime() - MAX_CATCHUP_MS);
    console.log(`[presence-polling] catch-up: gap ${gapMinutes}m (>7d), clamping start to ${formatLocalDateTime(floor)}`);
    checkpoint = floor;
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
    mode: 'window',
    lastEventId: null,
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

function isActiveRuntimeLease(leaseExpiresAt: string | null | undefined): boolean {
  if (!leaseExpiresAt) return false;
  const expiresAtMs = Date.parse(leaseExpiresAt);
  if (Number.isNaN(expiresAtMs)) return false;
  return expiresAtMs > Date.now();
}

export async function hasExclusiveSyncLease(): Promise<boolean> {
  const state = await getSigurRuntimeState(SIGUR_EXCLUSIVE_SYNC_STATE_KEY);
  return !!state?.lease_owner && isActiveRuntimeLease(state.lease_expires_at);
}

export async function hasEventsSyncLease(): Promise<boolean> {
  const state = await getSigurRuntimeState(SIGUR_EVENTS_SYNC_STATE_KEY);
  return !!state?.lease_owner && isActiveRuntimeLease(state.lease_expires_at);
}

async function hasStructureSyncLease(): Promise<boolean> {
  const state = await getSigurRuntimeState(SIGUR_STRUCTURE_SYNC_STATE_KEY);
  return !!state?.lease_owner && isActiveRuntimeLease(state.lease_expires_at);
}

function createWaitReporter(
  kind: IManualSyncWaitUpdate['kind'],
  message: string,
  onWait?: (update: IManualSyncWaitUpdate) => void,
): (waitedMs: number) => void {
  let lastReportedBucket = -1;

  return (waitedMs: number) => {
    if (!onWait) return;

    const bucket = Math.floor(waitedMs / 5000);
    if (bucket === lastReportedBucket) {
      return;
    }

    lastReportedBucket = bucket;
    onWait({
      kind,
      waitedMs,
      message,
    });
  };
}

async function waitForStructureSyncLeaseRelease(
  onWait?: (update: IManualSyncWaitUpdate) => void,
): Promise<void> {
  const deadlineAt = Date.now() + STRUCTURE_SYNC_WAIT_TIMEOUT_MS;
  const waitStartedAt = Date.now();
  const reportWait = createWaitReporter(
    'structure_sync',
    'Ожидаем завершения фоновой синхронизации структуры Sigur...',
    onWait,
  );

  while (await hasStructureSyncLease()) {
    reportWait(Date.now() - waitStartedAt);

    if (Date.now() >= deadlineAt) {
      throw new ManualSyncInProgressError(
        'Фоновая синхронизация структуры не завершилась вовремя. Попробуйте повторить через пару минут.',
      );
    }

    await wait(EXCLUSIVE_SYNC_ACQUIRE_RETRY_MS);
  }
}

interface IManualSyncWaitUpdate {
  kind: 'structure_sync' | 'presence_polling';
  waitedMs: number;
  message: string;
}

interface IAcquirePresencePollingLockOptions {
  onWait?: (update: IManualSyncWaitUpdate) => void;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function restartPresencePollingInBackground(reason: string): void {
  void startPresencePolling().catch(error => {
    console.error(`[presence-polling] restart failed after ${reason}:`, (error as Error).message);
  });
}

export function resetPresencePollingStateForTests(): void {
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }

  if (pollingTimer) {
    clearTimeout(pollingTimer);
    pollingTimer = null;
  }

  pollingActive = false;
  consecutiveEmptyTicks = 0;
  lastQuarantineSentryAt = 0;
  manualSyncLocks = 0;
  eventsSyncLocks = 0;
  pollInFlight = null;
  currentSkipStreak = null;
  if (manualSyncLeaseHeartbeatStop) {
    manualSyncLeaseHeartbeatStop();
    manualSyncLeaseHeartbeatStop = null;
  }
  if (exclusiveSyncLeaseHeartbeatStop) {
    exclusiveSyncLeaseHeartbeatStop();
    exclusiveSyncLeaseHeartbeatStop = null;
  }
  if (eventsSyncLeaseHeartbeatStop) {
    eventsSyncLeaseHeartbeatStop();
    eventsSyncLeaseHeartbeatStop = null;
  }
  if (structureSyncLeaseHeartbeatStop) {
    structureSyncLeaseHeartbeatStop();
    structureSyncLeaseHeartbeatStop = null;
  }
  invalidatePresencePollingEmployeeCache();
}

function isTransientDbError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes('statement timeout')
    || m.includes('canceling statement')
    || m.includes('502')
    || m.includes('504')
    || m.includes('<!doctype')
    || m.includes('fetch failed')
    || m.includes('econnreset')
    || m.includes('etimedout');
}

export async function pollEventsOnce(now = new Date()): Promise<void> {
  const cycleStartedAt = Date.now();
  const cycleStartedAtIso = new Date(cycleStartedAt).toISOString();
  let window: PollingWindow | null = null;
  let connectionType: ConnectionType | null = null;

  try {
    if (!(await sigurService.isConfigured())) return;
    connectionType = await sigurService.getBackgroundConnectionType();

    window = await resolvePollingWindow(now);
    console.log(
      `[presence-polling] window mode=${window.mode} source=${window.checkpointSource} connection=${connectionType}` +
      (window.mode === 'lastId'
        ? ` lastEventId=${window.lastEventId}`
        : ` start=${window.startTime} end=${window.endTime}`),
    );

    const tFetchStart = Date.now();
    const fetched = window.mode === 'lastId' && window.lastEventId != null
      ? await sigurService.getEventsByLastIdWithFailures(window.lastEventId, connectionType)
      : await sigurService.getEventsWithFailures(window.startTime, window.endTime, connectionType);
    const rawEvents = fetched.pass;
    const rawFailures = fetched.failures;
    const tFetch = Date.now() - tFetchStart;
    // Adaptive interval: считаем пустые тики, чтобы планировщик переключался на
    // idle-интервал (30с) после нескольких пустых подряд. Любая активность
    // (включая ошибочные события) моментально возвращает к base-интервалу.
    if (rawEvents.length === 0 && rawFailures.length === 0) {
      consecutiveEmptyTicks++;
    } else {
      consecutiveEmptyTicks = 0;
    }
    console.log(
      `[presence-polling] fetched=${rawEvents.length} failures=${rawFailures.length} mode=${window.mode} source=${window.checkpointSource} connection=${connectionType} tFetch=${tFetch}ms`,
    );

    let tEmpRefresh = 0;
    let maps = await getEmployeeMaps();

    // Lazy-refresh: если среди событий есть неизвестный physicalPerson и кэшу > 30с —
    // инвалидируем и перечитываем один раз за цикл. Нужно, чтобы первые события нового
    // сотрудника сразу попадали с employee_id, а не ждали истечения 10-минутного TTL.
    const hasUnknown = rawEvents.some(raw => {
      const m = mapSigurEvent(raw as Record<string, unknown>);
      if (!m || !m.physicalPerson) return false;
      if (m.employeeId != null && maps.bySigurId.get(m.employeeId)) return false;
      const nk = normalizePersonName(m.physicalPerson);
      return !maps.byUniqueName.get(nk) && !maps.byName.get(nk);
    });
    if (hasUnknown) {
      const cached = getEmployeeCache();
      const cacheAgeMs = cached ? Date.now() - cached.fetchedAt : Number.POSITIVE_INFINITY;
      if (cacheAgeMs > 30_000) {
        const tEmpStart = Date.now();
        invalidatePresencePollingEmployeeCache();
        maps = await getEmployeeMaps();
        tEmpRefresh = Date.now() - tEmpStart;
      }
    }
    const { byName, bySigurId, byUniqueName } = maps;

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
    const candidateSummaryKeys = new Set<string>();
    let storedUnmatched = 0;
    let latestObservedEventAt: Date | null = null;
    let maxObservedEventId: number | null = null;
    let quarantinedByDate = 0;

    // Защита от мусорных дат от Sigur (например event_date=2000-01-01).
    // Без этого guard'а одна такая запись валит весь UPSERT batch с ошибкой
    // `no partition of relation "skud_events" found for row`, и lastEventId
    // не двигается. Партицирование skud_events идёт по диапазонам, поэтому
    // отбрасываем всё за пределами [now-30d, now+1d] — это заведомо мусор.
    const dateGuardFloorMs = now.getTime() - 30 * 24 * 60 * 60 * 1000;
    const dateGuardCeilMs = now.getTime() + 24 * 60 * 60 * 1000;

    for (const raw of rawEvents) {
      const rawId = (raw as Record<string, unknown>).id;
      if (typeof rawId === 'number' && Number.isFinite(rawId)) {
        if (maxObservedEventId === null || rawId > maxObservedEventId) {
          maxObservedEventId = rawId;
        }
      }
      const mapped = mapSigurEvent(raw as Record<string, unknown>);
      if (!mapped || mapped.kind !== 'pass' || !mapped.physicalPerson) continue;
      const eventAt = buildMoscowEventTimestamp(mapped.eventDate, mapped.eventTime);
      const observedAt = new Date(eventAt);
      const observedMs = observedAt.getTime();
      if (Number.isNaN(observedMs) || observedMs < dateGuardFloorMs || observedMs > dateGuardCeilMs) {
        quarantinedByDate++;
        continue;
      }
      if (!latestObservedEventAt || observedMs > latestObservedEventAt.getTime()) {
        latestObservedEventAt = observedAt;
      }

      const dedupHash = computeDedupHash(
        mapped.physicalPerson,
        mapped.eventDate,
        mapped.eventTime,
        mapped.accessPoint,
        mapped.direction,
        mapped.rawId,
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
        candidateSummaryKeys.add(`${emp.id}:${mapped.eventDate}`);
      } else {
        storedUnmatched++;
      }
    }

    // ─── Ошибочные события Sigur (PASS_DENY и т.п.) ───
    // Курсор lastEventId двигаем по объединённому потоку (включая failures), иначе
    // на следующем тике мы заново выкачаем уже обработанные failures. UPSERT в
    // отдельную таблицу: recalc-RPC и realtime-нотификации не дёргаются.
    const failureInserts: Array<{
      physical_person: string | null;
      card_number: string | null;
      event_date: string;
      event_time: string;
      event_at: string;
      access_point: string | null;
      direction: 'entry' | 'exit' | null;
      employee_id: number | null;
      failure_type: string;
      failure_type_id: number | null;
      reason: string | null;
      raw_event_id: number | null;
      dedup_hash: string;
    }> = [];
    const existingFailureSet = new Set<string>();
    let failuresQuarantinedByDate = 0;
    for (const raw of rawFailures) {
      const rawId = (raw as Record<string, unknown>).id;
      if (typeof rawId === 'number' && Number.isFinite(rawId)) {
        if (maxObservedEventId === null || rawId > maxObservedEventId) {
          maxObservedEventId = rawId;
        }
      }
      const mapped = mapSigurEvent(raw as Record<string, unknown>);
      if (!mapped || mapped.kind !== 'failure') continue;

      const eventAt = buildMoscowEventTimestamp(mapped.eventDate, mapped.eventTime);
      const observedAt = new Date(eventAt);
      const observedMs = observedAt.getTime();
      if (Number.isNaN(observedMs) || observedMs < dateGuardFloorMs || observedMs > dateGuardCeilMs) {
        failuresQuarantinedByDate++;
        continue;
      }

      const failureHash = computeFailureDedupHash(
        mapped.physicalPerson,
        mapped.cardNumber,
        mapped.eventDate,
        mapped.eventTime,
        mapped.accessPoint,
        mapped.direction,
        mapped.failureType,
        mapped.rawId,
      );
      if (existingFailureSet.has(failureHash)) continue;
      existingFailureSet.add(failureHash);

      let failureEmp: { id: number } | undefined;
      if (mapped.employeeId != null) failureEmp = bySigurId.get(mapped.employeeId);
      if (!failureEmp && mapped.physicalPerson) {
        const nameKey = normalizePersonName(mapped.physicalPerson);
        failureEmp = byUniqueName.get(nameKey) || byName.get(nameKey);
      }

      failureInserts.push({
        physical_person: mapped.physicalPerson,
        card_number: mapped.cardNumber,
        event_date: mapped.eventDate,
        event_time: mapped.eventTime,
        event_at: eventAt,
        access_point: mapped.accessPoint,
        direction: mapped.direction,
        employee_id: failureEmp?.id || null,
        failure_type: mapped.failureType,
        failure_type_id: mapped.failureTypeId,
        reason: mapped.reason,
        raw_event_id: mapped.rawId,
        dedup_hash: failureHash,
      });
    }

    let totalInserted = 0;
    const insertedSummaryKeys = new Set<string>();
    const insertedEmployeeIds = new Set<number>();
    const persistenceErrors: string[] = [];
    let lastSuccessfulEventAt: Date | null = null;
    let cycleBudgetExceeded = false;
    let insertGroupCount = 0;
    const tInsertStart = Date.now();
    type BatchOutcome = {
      insertedCount: number;
      batchError: string | null;
    };
    // Первичная попытка + повторы при transient-ошибках Supabase (statement timeout / 502 / 504).
    // Без retry единичный таймаут блокировал весь цикл и не давал двигать checkpoint.
    const EVENT_COLUMNS = [
      'physical_person', 'card_number', 'event_date', 'event_time',
      'event_at', 'access_point', 'direction', 'employee_id', 'dedup_hash',
    ];
    const upsertBatchWithRetry = async (batch: typeof inserts): Promise<BatchOutcome> => {
      let attempt = 0;
      let lastError: string | null = null;
      while (attempt <= RETRY_BACKOFF_MS.length) {
        const result = await withDbSlot('presence_polling_upsert', async () => {
          try {
            const params: unknown[] = [];
            const placeholders: string[] = [];
            for (const row of batch) {
              const group: string[] = [];
              for (const col of EVENT_COLUMNS) {
                params.push((row as Record<string, unknown>)[col]);
                group.push(`$${params.length}`);
              }
              placeholders.push(`(${group.join(', ')})`);
            }
            const insertedRows = await query<{ employee_id: number | null; event_date: string | null }>(
              `INSERT INTO skud_events (${EVENT_COLUMNS.join(', ')})
               VALUES ${placeholders.join(', ')}
               ON CONFLICT (dedup_hash, event_date) DO NOTHING
               RETURNING employee_id, event_date`,
              params,
            );
            return { ok: true as const, rows: insertedRows };
          } catch (err) {
            return { ok: false as const, error: err as Error };
          }
        });
        if (result.ok) {
          return { insertedCount: result.rows.length, batchError: null };
        }
        lastError = result.error.message;
        if (!isTransientDbError(result.error.message) || attempt === RETRY_BACKOFF_MS.length) break;
        const jitter = Math.floor(Math.random() * 200);
        await wait(RETRY_BACKOFF_MS[attempt] + jitter);
        attempt++;
      }
      return { insertedCount: 0, batchError: lastError ?? 'unknown error' };
    };
    outer: for (let i = 0; i < inserts.length; i += BATCH_SIZE * BATCH_CONCURRENCY) {
      // Backpressure: при насыщении пула ранний break, чтобы освободить slots для UI-запросов.
      // Шаг цикла фиксированный → не меняем concurrency на лету (иначе пропустим батчи);
      // вместо этого тормозим следующую итерацию задержкой 200мс при SOFT.
      const inflight = getDbInflight();
      if (inflight >= SLOT_HARD_LIMIT) {
        cycleBudgetExceeded = true;
        persistenceErrors.push(`backpressure: inflight=${inflight} >= hard limit ${SLOT_HARD_LIMIT}`);
        break outer;
      }
      if (inflight >= SLOT_SOFT_LIMIT) {
        await wait(200);
      }
      const groupBatches: Array<typeof inserts> = [];
      for (let j = 0; j < BATCH_CONCURRENCY; j++) {
        const start = i + j * BATCH_SIZE;
        if (start >= inserts.length) break;
        groupBatches.push(inserts.slice(start, start + BATCH_SIZE));
      }
      insertGroupCount++;
      // Параллельный запуск пары UPSERT-батчей: вместо последовательной цепочки
      // (6 батчей × tInsertOne) занимаем 2 connection slots на длительность одной
      // пары — wall-time цикла снижается ~2×, UI-запросы (selector отделов на
      // /timesheet, /api/skud/presence) перестают повисать в очереди connection pool.
      const settled = await Promise.allSettled(groupBatches.map(upsertBatchWithRetry));
      let groupHadError = false;
      for (let k = 0; k < settled.length; k++) {
        const result = settled[k];
        const startIdx = i + k * BATCH_SIZE;
        const batch = groupBatches[k];
        if (result.status === 'rejected') {
          const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
          console.error(`[presence-polling] insert rejected (batch ${startIdx}/${inserts.length}):`, reason);
          persistenceErrors.push(reason);
          groupHadError = true;
          continue;
        }
        const { insertedCount, batchError } = result.value;
        if (batchError) {
          console.error(`[presence-polling] insert error (batch ${startIdx}/${inserts.length}):`, batchError);
          persistenceErrors.push(batchError);
          groupHadError = true;
          continue;
        }
        totalInserted += insertedCount;
        // Recalc-ключи берём из ИСХОДНОГО batch, а не из insertedRows: при ignoreDuplicates=true
        // Supabase возвращает только новые строки, и если предыдущий тик упал на recalc-RPC после
        // успешного upsert — повторный тик увидит события дубликатами и пересчёт summary никогда
        // больше не запустится. RPC batch_recalculate_skud_daily_summary идемпотентна (full
        // recompute из событий + ON CONFLICT UPDATE), лишний пересчёт безопасен.
        for (const row of batch) {
          const empId = (row as { employee_id?: number | null }).employee_id;
          const date = (row as { event_date?: string | null }).event_date;
          if (empId != null && date) {
            insertedSummaryKeys.add(`${empId}:${date}`);
            insertedEmployeeIds.add(Number(empId));
          }

          // checkpoint двигаем по ВСЕМ строкам успешного batch (включая unmatched/без employee_id),
          // иначе после fail-ed tail-batch checkpoint не уйдёт вперёд и polling зациклится.
          const t = Date.parse(row.event_at);
          if (!Number.isNaN(t) && (!lastSuccessfulEventAt || t > lastSuccessfulEventAt.getTime())) {
            lastSuccessfulEventAt = new Date(t);
          }
        }
      }
      if (groupHadError) {
        // Останавливаем цикл вставок: следующие батчи скорее всего тоже упадут, лучше
        // финализировать с partial checkpoint и попробовать на следующем тике.
        break outer;
      }
      if (Date.now() - cycleStartedAt > CYCLE_TIME_BUDGET_MS) {
        // Это backpressure-сигнал, а не ошибка БД: следующий тик подберёт остаток
        // через UNIQUE-индекс. НЕ пушим в persistenceErrors → hadFailure остаётся false
        // → lastEventId двигается → polling не зацикливается на одном окне.
        cycleBudgetExceeded = true;
        break outer;
      }
      if (i + BATCH_SIZE * BATCH_CONCURRENCY < inserts.length) await wait(BATCH_DELAY_MS);
    }
    const tInsert = Date.now() - tInsertStart;

    // ─── UPSERT ошибочных событий ───
    // Не двигает курсор, не вызывает recalc-RPC, не отправляет realtime-нотификации.
    // Ошибки тут НЕ блокируют advance lastEventId: следующий тик повторно увидит
    // те же id, UNIQUE-индекс отсеет дубли, не записанные попадут в БД.
    let totalFailuresInserted = 0;
    let failuresPersistenceError: string | null = null;
    if (failureInserts.length > 0) {
      const FAILURE_COLUMNS = [
        'physical_person', 'card_number', 'event_date', 'event_time',
        'event_at', 'access_point', 'direction', 'employee_id',
        'failure_type', 'failure_type_id', 'reason', 'raw_event_id', 'dedup_hash',
      ];
      for (let i = 0; i < failureInserts.length; i += BATCH_SIZE) {
        const batch = failureInserts.slice(i, i + BATCH_SIZE);
        const result = await withDbSlot('presence_polling_upsert_failures', async () => {
          try {
            const params: unknown[] = [];
            const placeholders: string[] = [];
            for (const row of batch) {
              const group: string[] = [];
              for (const col of FAILURE_COLUMNS) {
                params.push((row as Record<string, unknown>)[col]);
                group.push(`$${params.length}`);
              }
              placeholders.push(`(${group.join(', ')})`);
            }
            await execute(
              `INSERT INTO skud_event_failures (${FAILURE_COLUMNS.join(', ')})
               VALUES ${placeholders.join(', ')}
               ON CONFLICT (dedup_hash, event_date) DO NOTHING`,
              params,
            );
            return { ok: true as const };
          } catch (err) {
            return { ok: false as const, error: err as Error };
          }
        });
        if (!result.ok) {
          failuresPersistenceError = result.error.message;
          console.error(`[presence-polling] failure-upsert error (batch ${i}/${failureInserts.length}):`, result.error.message);
          break;
        }
        totalFailuresInserted += batch.length;
        if (i + BATCH_SIZE < failureInserts.length) await wait(BATCH_DELAY_MS);
      }
    }

    let tSummary = 0;
    let summaryError: string | null = null;
    let summaryGroupCount = 0;
    if (insertedSummaryKeys.size > 0) {
      const tSummaryStart = Date.now();
      const allPairs = [...insertedSummaryKeys].map(key => {
        const [empId, date] = key.split(':');
        return { emp_id: parseInt(empId, 10), date };
      });
      const recalcChunkWithRetry = async (chunk: typeof allPairs): Promise<string | null> => {
        let attempt = 0;
        let lastError: string | null = null;
        while (attempt <= RETRY_BACKOFF_MS.length) {
          const result = await withDbSlot('rpc_recalc_summary', async () => {
            try {
              await query(
                'SELECT public.batch_recalculate_skud_daily_summary($1::jsonb)',
                [JSON.stringify(chunk)],
              );
              return { ok: true as const };
            } catch (err) {
              return { ok: false as const, error: err as Error };
            }
          });
          if (result.ok) return null;
          lastError = result.error.message;
          if (!isTransientDbError(result.error.message) || attempt === RETRY_BACKOFF_MS.length) break;
          await wait(RETRY_BACKOFF_MS[attempt] + Math.floor(Math.random() * 200));
          attempt++;
        }
        return lastError ?? 'unknown error';
      };
      summaryOuter: for (let i = 0; i < allPairs.length; i += SUMMARY_BATCH * BATCH_CONCURRENCY) {
        // Backpressure: симметрично upsert-циклу.
        const inflight = getDbInflight();
        if (inflight >= SLOT_HARD_LIMIT) {
          cycleBudgetExceeded = true;
          summaryError = summaryError ?? `backpressure: inflight=${inflight} >= hard limit ${SLOT_HARD_LIMIT}`;
          break summaryOuter;
        }
        if (inflight >= SLOT_SOFT_LIMIT) {
          await wait(200);
        }
        const groupChunks: Array<typeof allPairs> = [];
        for (let j = 0; j < BATCH_CONCURRENCY; j++) {
          const start = i + j * SUMMARY_BATCH;
          if (start >= allPairs.length) break;
          groupChunks.push(allPairs.slice(start, start + SUMMARY_BATCH));
        }
        summaryGroupCount++;
        // Параллельный запуск пары RPC summary-recalc: пары (emp_id, date) независимы,
        // RPC идемпотентна. Снижает wall-time summary stage примерно в 2 раза.
        const settled = await Promise.allSettled(groupChunks.map(recalcChunkWithRetry));
        for (let k = 0; k < settled.length; k++) {
          const result = settled[k];
          const startIdx = i + k * SUMMARY_BATCH;
          if (result.status === 'rejected') {
            const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
            console.error(`[presence-polling] summary recalc rejected (chunk ${startIdx}/${allPairs.length}):`, reason);
            summaryError = reason;
            break summaryOuter;
          }
          if (result.value) {
            console.error(`[presence-polling] summary recalc error (chunk ${startIdx}/${allPairs.length}):`, result.value);
            summaryError = result.value;
            break summaryOuter;
          }
        }
        if (Date.now() - cycleStartedAt > CYCLE_TIME_BUDGET_MS) {
          // backpressure-сигнал, не ошибка: skud-summary-reconcile.service подхватит
          // orphan-пары через 15 мин, а на следующем тике наши вставленные ключи
          // снова попадут в insertedSummaryKeys.
          cycleBudgetExceeded = true;
          break summaryOuter;
        }
        if (i + SUMMARY_BATCH * BATCH_CONCURRENCY < allPairs.length) await wait(SUMMARY_DELAY_MS);
      }
      tSummary = Date.now() - tSummaryStart;
    }

    const hadFailure = persistenceErrors.length > 0 || summaryError !== null;
    // Realtime-уведомление шлём только при РЕАЛЬНЫХ вставках (totalInserted из rows). Если все
    // события — дубликаты, recalc summary мы всё равно прогнали (страхует от потери summary при
    // упавшем recalc предыдущего тика, см. комментарий выше у insertedSummaryKeys), но клиентам
    // refetch-ить нечего: ни одного нового прохода в БД не появилось.
    const presenceChanged = totalInserted > 0;
    const cycleFinishedAt = new Date();

    // После успешного цикла сбрасываем кэши presence/dashboard, чтобы пользователи
    // увидели актуальные входы/выходы. Без этого данные отстают до TTL.
    if (presenceChanged) {
      notifySkudRealtimeChanged({
        at: cycleFinishedAt.toISOString(),
        employeeIds: [...insertedEmployeeIds],
        from: window.startDate,
        to: window.endDate,
        source: 'polling',
        insertedCount: totalInserted,
        recalculatedCount: insertedSummaryKeys.size,
      });
    }

    const monitorCheckedAt = new Date();
    const totalMs = Date.now() - cycleStartedAt;
    const timings = { tFetch, tEmpRefresh, tInsert, tSummary, totalMs };
    const failureMessage = persistenceErrors.length > 0
      ? `Failed to persist Sigur events: ${persistenceErrors[0]}`
      : (summaryError ? `[presence-polling] summary recalc error: ${summaryError}` : null);
    const cycleMeta = {
      connectionType,
      mode: window.mode,
      pollLastEventId: window.lastEventId,
      maxObservedEventId,
      consecutiveEmptyTicks,
      quarantinedByDate,
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
      failuresFetched: rawFailures.length,
      failuresInserted: totalFailuresInserted,
      failuresQuarantinedByDate,
      failuresPersistenceError,
      attemptedInserts: inserts.length,
      inserted: totalInserted,
      duplicates: Math.max(0, inserts.length - totalInserted),
      unmatched: storedUnmatched,
      candidateSummaries: candidateSummaryKeys.size,
      summaries: insertedSummaryKeys.size,
      latestObservedEventAt: latestObservedEventAt?.toISOString() || null,
      durationMs: totalMs,
      checkpointLagMs: Math.max(0, now.getTime() - window.endAt.getTime()),
      persistenceErrors: persistenceErrors.length,
      summaryError,
      cycleBudgetExceeded,
      insertGroupCount,
      summaryGroupCount,
      batchConcurrency: BATCH_CONCURRENCY,
      timings,
    };

    // При partial failure (реальные DB-ошибки) двигаем checkpoint только до последнего
    // успешно записанного event_at (минус 10 сек overlap). При полном провале без единого
    // успешного батча checkpoint не двигаем — пусть следующий цикл попробует то же окно.
    // При cycleBudgetExceeded checkpoint двигается в window.endAt: budget — это
    // backpressure от Sigur-тормоза, не ошибка БД. UNIQUE отсеет дубли, если что
    // не успело записаться — следующий тик подберёт остаток через lastEventId.
    const nextCheckpoint: Date | null = hadFailure
      ? (lastSuccessfulEventAt ? new Date(lastSuccessfulEventAt.getTime() - 10_000) : null)
      : window.endAt;

    // lastEventId двигаем при чистом успехе И при чистом budget-exceeded (без ошибок БД).
    // При реальной partial failure следующий тик повторно запросит те же события —
    // UNIQUE (dedup_hash, event_date) отсеет уже записанные.
    const advanceLastEventId = !hadFailure && maxObservedEventId !== null;

    await mergeSigurRuntimeState({
      key: SIGUR_POLLING_STATE_KEY,
      owner: POLLING_LEASE_OWNER,
      ...(nextCheckpoint ? { checkpointAt: nextCheckpoint } : {}),
      meta: {
        lastSignalAt: monitorCheckedAt.toISOString(),
        ...(hadFailure
          ? { lastFailureAt: monitorCheckedAt.toISOString(), lastError: failureMessage }
          : { lastSuccessAt: monitorCheckedAt.toISOString(), lastError: null }),
        lastCycle: cycleMeta,
        ...(latestObservedEventAt ? { lastEventFlowAt: latestObservedEventAt.toISOString() } : {}),
        ...(advanceLastEventId ? { lastEventId: maxObservedEventId } : {}),
      },
    });
    console.log(
      `[presence-polling] cycle done source=${window.checkpointSource} connection=${connectionType} start=${window.startTime} end=${window.endTime} fetched=${rawEvents.length} failuresFetched=${rawFailures.length} failuresInserted=${totalFailuresInserted} quarantinedByDate=${quarantinedByDate} attempted=${inserts.length} inserted=${totalInserted} duplicates=${Math.max(0, inserts.length - totalInserted)} unmatched=${storedUnmatched} summaries=${insertedSummaryKeys.size} tFetch=${tFetch}ms tEmpRefresh=${tEmpRefresh}ms tInsert=${tInsert}ms tSummary=${tSummary}ms total=${totalMs}ms${hadFailure ? ` PARTIAL_FAILURE=${failureMessage}` : ''}${failuresPersistenceError ? ` FAILURES_ERROR=${failuresPersistenceError}` : ''}`,
    );
    if (quarantinedByDate > 0) {
      const sinceLast = Date.now() - lastQuarantineSentryAt;
      if (sinceLast > QUARANTINE_SENTRY_INTERVAL_MS) {
        lastQuarantineSentryAt = Date.now();
        Sentry.captureMessage('presence-polling events quarantined by date', {
          level: 'warning',
          tags: { service: 'presence-polling', reason: 'date_out_of_range' },
          extra: {
            quarantinedByDate,
            fetched: rawEvents.length,
            mode: window.mode,
            pollLastEventId: window.lastEventId,
            maxObservedEventId,
            sentryRateLimitedMs: QUARANTINE_SENTRY_INTERVAL_MS,
          },
        });
      }
    }
    // Threshold'ы выше типичного tFetch=5-10s от Sigur, иначе каждый активный
    // тик орёт «slow». Реальный сигнал — когда наш код прибавил ещё 5-10s
    // поверх Sigur (CRITICAL >20s ≈ Sigur+наша логика отжали два бюджета).
    if (totalMs > 12_000) {
      const pollIntervalMs = resolvePresencePollIntervalMs();
      const isCritical = totalMs > 20_000;
      console.warn(
        `[presence-polling] ${isCritical ? 'CRITICAL' : 'SLOW'} cycle ${totalMs}ms (tFetch=${tFetch}ms tInsert=${tInsert}ms tSummary=${tSummary}ms) exceeds polling interval ${pollIntervalMs}ms`,
      );
      Sentry.captureMessage(
        isCritical ? 'presence-polling cycle critical slow' : 'presence-polling cycle slow',
        {
          level: isCritical ? 'error' : 'warning',
          tags: {
            service: 'presence-polling',
            severity: isCritical ? 'critical' : 'slow',
            mode: window.mode,
          },
          extra: {
            ...timings,
            pollIntervalMs,
            fetched: rawEvents.length,
            inserted: totalInserted,
            mode: window.mode,
            pollLastEventId: window.lastEventId,
            maxObservedEventId,
          },
        },
      );
    }
    if (hadFailure) {
      Sentry.captureMessage('presence-polling partial success', {
        level: 'warning',
        tags: { service: 'presence-polling', stage: 'persistence' },
        extra: {
          failureMessage,
          persistenceErrors: persistenceErrors.length,
          summaryError,
          inserted: totalInserted,
          attempted: inserts.length,
          lastSuccessfulEventAt: lastSuccessfulEventAt?.toISOString() || null,
          checkpointMoved: nextCheckpoint?.toISOString() || null,
        },
      });
      void recordSigurMonitorFailure({
        source: 'presence_polling',
        checkedAt: monitorCheckedAt,
        connectionType,
        responseMs: totalMs,
        errorMessage: failureMessage || 'unknown',
        meta: {
          ...cycleMeta,
        },
      }).catch(error => {
        console.error('[presence-polling] monitor failure hook error:', (error as Error).message);
      });
    } else {
      // Чистый budget-exceeded — это backpressure, а не ошибка. В Sentry не шумим
      // (видимость и так есть в console.warn ниже + cycleMeta.cycleBudgetExceeded
      // в runtime_state.meta.lastCycle), в monitor-таблицу пишем как success: мы
      // реально записали часть, lastEventId двинется, следующий тик подберёт остаток.
      if (cycleBudgetExceeded) {
        console.warn(
          `[presence-polling] cycle budget exceeded (totalMs=${totalMs}ms tFetch=${tFetch}ms tInsert=${tInsert}ms tSummary=${tSummary}ms inserted=${totalInserted}/${inserts.length}); next tick will resume.`,
        );
      }
      void recordSigurMonitorSuccess({
        source: 'presence_polling',
        checkedAt: monitorCheckedAt,
        connectionType,
        responseMs: totalMs,
        eventsLastWindow: rawEvents.length,
        meta: {
          ...cycleMeta,
        },
      }).catch(error => {
        console.error('[presence-polling] monitor success hook error:', (error as Error).message);
      });
    }
  } catch (error) {
    console.error('[presence-polling] error:', (error as Error).message);
    if (isSigurNetworkError(error)) {
      const now = Date.now();
      if (now - lastSigurUnreachableCaptureAt >= SIGUR_UNREACHABLE_CAPTURE_INTERVAL_MS) {
        lastSigurUnreachableCaptureAt = now;
        const e = error as { code?: string; response?: { status?: number }; message?: string };
        Sentry.captureMessage('sigur_unreachable', {
          level: 'warning',
          tags: { service: 'presence-polling', stage: 'pollEvents' },
          extra: {
            code: e.code || null,
            httpStatus: e.response?.status ?? null,
            message: e.message?.slice(0, 300) || null,
          },
        });
      }
    } else {
      Sentry.captureException(error, { tags: { service: 'presence-polling', stage: 'pollEvents' } });
    }
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

interface IPollSkipStreak {
  reason: string;
  startedAt: string;
  count: number;
  lastAt: string;
}

let currentSkipStreak: IPollSkipStreak | null = null;

function recordPollSkip(reason: string): void {
  const nowIso = new Date().toISOString();
  if (currentSkipStreak && currentSkipStreak.reason === reason) {
    currentSkipStreak.count += 1;
    currentSkipStreak.lastAt = nowIso;
  } else {
    if (currentSkipStreak) {
      const streakDurationMs =
        Date.parse(currentSkipStreak.lastAt) - Date.parse(currentSkipStreak.startedAt);
      console.log(
        `[presence-polling] skip streak ended reason=${currentSkipStreak.reason} count=${currentSkipStreak.count} durationMs=${streakDurationMs}`,
      );
      if (streakDurationMs >= 30_000) {
        Sentry.captureMessage('presence-polling skip streak', {
          level: 'warning',
          tags: { service: 'presence-polling', reason: currentSkipStreak.reason },
          extra: {
            reason: currentSkipStreak.reason,
            count: currentSkipStreak.count,
            durationMs: streakDurationMs,
            startedAt: currentSkipStreak.startedAt,
            endedAt: currentSkipStreak.lastAt,
          },
        });
      }
    }
    currentSkipStreak = { reason, startedAt: nowIso, count: 1, lastAt: nowIso };
  }
  console.log(
    `[presence-polling] cycle skipped reason=${reason} streakCount=${currentSkipStreak.count} streakStartedAt=${currentSkipStreak.startedAt}`,
  );
  void mergeSigurRuntimeState({
    key: SIGUR_POLLING_STATE_KEY,
    owner: POLLING_LEASE_OWNER,
    meta: {
      lastSkip: {
        reason,
        at: nowIso,
        leaseOwner: POLLING_LEASE_OWNER,
        streakCount: currentSkipStreak.count,
        streakStartedAt: currentSkipStreak.startedAt,
      },
    },
  }).catch(error => {
    console.error('[presence-polling] runtime skip hook error:', (error as Error).message);
  });
}

function clearPollSkipStreak(): void {
  if (currentSkipStreak) {
    const streakDurationMs =
      Date.parse(currentSkipStreak.lastAt) - Date.parse(currentSkipStreak.startedAt);
    console.log(
      `[presence-polling] skip streak ended (cycle ran) reason=${currentSkipStreak.reason} count=${currentSkipStreak.count} durationMs=${streakDurationMs}`,
    );
    currentSkipStreak = null;
  }
}

async function runPollCycle(): Promise<void> {
  if (manualSyncLocks > 0) {
    recordPollSkip('manualSyncLocks');
    return;
  }
  if (pollInFlight) {
    recordPollSkip('pollInFlight');
    return pollInFlight;
  }
  if (await hasExclusiveSyncLease()) {
    recordPollSkip('exclusiveLock');
    return;
  }
  if (pollInFlight) {
    recordPollSkip('pollInFlight');
    return pollInFlight;
  }

  clearPollSkipStreak();
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
        recordPollSkip('pollingLeaseBusy');
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
      const tBackfillStart = Date.now();
      await backfillUnmatchedEvents();
      const tBackfill = Date.now() - tBackfillStart;
      if (tBackfill > 1_000) {
        console.log(`[presence-polling] backfill done in ${tBackfill}ms`);
      }
    } catch (err) {
      console.error('[presence-polling] cycle error:', (err as Error).message);
      Sentry.captureException(err, { tags: { service: 'presence-polling', stage: 'cycle' } });
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

function computeNextPollDelay(): number {
  const base = resolvePresencePollIntervalMs();
  if (consecutiveEmptyTicks >= POLL_IDLE_THRESHOLD) {
    return Math.max(base, POLL_IDLE_INTERVAL_MS);
  }
  return base;
}

function scheduleNextPollTick(): void {
  if (!pollingActive) return;
  if (pollingTimer) {
    clearTimeout(pollingTimer);
    pollingTimer = null;
  }
  const delayMs = computeNextPollDelay();
  pollingTimer = setTimeout(() => {
    pollingTimer = null;
    void runPollCycleWithCronCheckin().finally(() => scheduleNextPollTick());
  }, delayMs);
}

// Adaptive polling делает 12 тиков/мин в горячем режиме и 2/мин в idle.
// Шлём cron-чек-ин не на каждом тике (это была бы лавина), а раз в ~2 мин:
// миссед-алёрт сработает, если поллер тихо умрёт.
const PRESENCE_CHECKIN_EVERY_N_TICKS = 24;
let presencePollingTickCounter = 0;

async function runPollCycleWithCronCheckin(): Promise<void> {
  presencePollingTickCounter++;
  if (presencePollingTickCounter < PRESENCE_CHECKIN_EVERY_N_TICKS) {
    await runPollCycle();
    return;
  }
  presencePollingTickCounter = 0;
  await runWithCronMonitor(
    'presence-polling',
    () => runPollCycle(),
    {
      schedule: { type: 'interval', value: 2, unit: 'minute' },
      checkinMargin: 2,
      maxRuntime: 5,
    },
  );
}

export async function startPresencePolling(): Promise<void> {
  if (pollingActive || pollingTimer || startupTimeout) return;
  if (!(await sigurService.isConfigured())) {
    console.log('[presence-polling] Sigur not configured, skipping');
    return;
  }
  if (!isSigurPresenceRuntimeAllowed()) {
    logSigurRuntimeGuardSkip('presence-polling');
    return;
  }
  if (manualSyncLocks > 0) {
    console.log(`[presence-polling] start skipped, locked by manual sync (${manualSyncLocks})`);
    return;
  }
  const pollIntervalMs = resolvePresencePollIntervalMs();
  console.log(
    `[presence-polling] started (base interval: ${Math.round(pollIntervalMs / 1000)}s, idle: ${Math.round(POLL_IDLE_INTERVAL_MS / 1000)}s after ${POLL_IDLE_THRESHOLD} empty ticks)`,
  );
  pollingActive = true;
  consecutiveEmptyTicks = 0;
  startupTimeout = setTimeout(() => {
    startupTimeout = null;
    void runPollCycleWithCronCheckin().finally(() => scheduleNextPollTick());
  }, 10_000);
}

export function stopPresencePolling(): void {
  pollingActive = false;
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }
  if (pollingTimer) {
    clearTimeout(pollingTimer);
    pollingTimer = null;
    console.log('[presence-polling] stopped');
  }
}

export async function acquireSigurEventsSyncLock(
  options: IAcquirePresencePollingLockOptions = {},
): Promise<void> {
  assertSigurRuntimeAllowed('Sigur events sync');
  if (eventsSyncLocks > 0) {
    throw new ManualSyncInProgressError();
  }

  eventsSyncLocks = 1;

  try {
    await waitForStructureSyncLeaseRelease(options.onWait);

    const lockedAt = new Date().toISOString();
    const lease = await tryAcquireSigurRuntimeLease({
      key: SIGUR_EVENTS_SYNC_STATE_KEY,
      owner: EVENTS_SYNC_LEASE_OWNER,
      ttlSeconds: SIGUR_POLLING_LEASE_TTL_SECONDS,
      meta: {
        leaseMode: 'events_sync',
        eventsSyncLockedAt: lockedAt,
        leaderOwner: EVENTS_SYNC_LEASE_OWNER,
      },
    });

    if (!lease.acquired) {
      throw new ManualSyncInProgressError();
    }

    eventsSyncLeaseHeartbeatStop = startSigurRuntimeLeaseHeartbeat({
      key: SIGUR_EVENTS_SYNC_STATE_KEY,
      owner: EVENTS_SYNC_LEASE_OWNER,
      ttlSeconds: SIGUR_POLLING_LEASE_TTL_SECONDS,
      getMeta: () => ({
        leaseMode: 'events_sync',
        eventsSyncLockedAt: lockedAt,
        leaderOwner: EVENTS_SYNC_LEASE_OWNER,
      }),
      onError: error => {
        console.error('[presence-polling] events sync lease heartbeat error:', error.message);
      },
    });
  } catch (error) {
    if (eventsSyncLeaseHeartbeatStop) {
      eventsSyncLeaseHeartbeatStop();
      eventsSyncLeaseHeartbeatStop = null;
    }
    await mergeSigurRuntimeState({
      key: SIGUR_EVENTS_SYNC_STATE_KEY,
      owner: EVENTS_SYNC_LEASE_OWNER,
      meta: {
        eventsSyncLockedAt: null,
        lastEventsSyncReleasedAt: new Date().toISOString(),
      },
    }).catch(runtimeError => {
      console.error('[presence-polling] events sync release hook error:', (runtimeError as Error).message);
    });
    await releaseSigurRuntimeLease({
      key: SIGUR_EVENTS_SYNC_STATE_KEY,
      owner: EVENTS_SYNC_LEASE_OWNER,
    }).catch(releaseError => {
      console.error('[presence-polling] events sync lease release error:', (releaseError as Error).message);
    });
    eventsSyncLocks = 0;
    throw error;
  }
}

export async function releaseSigurEventsSyncLock(): Promise<void> {
  if (eventsSyncLocks === 0) {
    return;
  }

  if (eventsSyncLeaseHeartbeatStop) {
    eventsSyncLeaseHeartbeatStop();
    eventsSyncLeaseHeartbeatStop = null;
  }

  await mergeSigurRuntimeState({
    key: SIGUR_EVENTS_SYNC_STATE_KEY,
    owner: EVENTS_SYNC_LEASE_OWNER,
    meta: {
      eventsSyncLockedAt: null,
      lastEventsSyncReleasedAt: new Date().toISOString(),
    },
  }).catch(error => {
    console.error('[presence-polling] events sync release hook error:', (error as Error).message);
  });
  await releaseSigurRuntimeLease({
    key: SIGUR_EVENTS_SYNC_STATE_KEY,
    owner: EVENTS_SYNC_LEASE_OWNER,
  }).catch(error => {
    console.error('[presence-polling] events sync lease release error:', (error as Error).message);
  });

  eventsSyncLocks = 0;
}

export async function acquirePresencePollingLock(
  options: IAcquirePresencePollingLockOptions = {},
): Promise<void> {
  assertSigurRuntimeAllowed('manual Sigur sync');
  if (manualSyncLocks > 0) {
    throw new ManualSyncInProgressError();
  }

  manualSyncLocks = 1;

  try {
    const lockedAt = new Date().toISOString();
    const exclusiveLease = await tryAcquireSigurRuntimeLease({
      key: SIGUR_EXCLUSIVE_SYNC_STATE_KEY,
      owner: EXCLUSIVE_SYNC_LEASE_OWNER,
      ttlSeconds: SIGUR_POLLING_LEASE_TTL_SECONDS,
      meta: {
        leaseMode: 'exclusive_sync',
        manualSyncLockedAt: lockedAt,
        leaderOwner: EXCLUSIVE_SYNC_LEASE_OWNER,
      },
    });

    if (!exclusiveLease.acquired) {
      throw new ManualSyncInProgressError();
    }

    exclusiveSyncLeaseHeartbeatStop = startSigurRuntimeLeaseHeartbeat({
      key: SIGUR_EXCLUSIVE_SYNC_STATE_KEY,
      owner: EXCLUSIVE_SYNC_LEASE_OWNER,
      ttlSeconds: SIGUR_POLLING_LEASE_TTL_SECONDS,
      getMeta: () => ({
        leaseMode: 'exclusive_sync',
        manualSyncLockedAt: lockedAt,
        leaderOwner: EXCLUSIVE_SYNC_LEASE_OWNER,
      }),
      onError: error => {
        console.error('[presence-polling] exclusive sync lease heartbeat error:', error.message);
      },
    });

    stopPresencePolling();
    if (pollInFlight) {
      await pollInFlight;
    }
    await waitForStructureSyncLeaseRelease(options.onWait);

    const deadlineAt = Date.now() + EXCLUSIVE_SYNC_ACQUIRE_TIMEOUT_MS;
    const pollingWaitStartedAt = Date.now();
    const reportPollingWait = createWaitReporter(
      'presence_polling',
      'Ожидаем завершения фонового polling Sigur...',
      options.onWait,
    );
    let pollingLeaseAcquired = false;
    while (!pollingLeaseAcquired) {
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

      if (lease.acquired) {
        pollingLeaseAcquired = true;
        break;
      }

      reportPollingWait(Date.now() - pollingWaitStartedAt);

      if (Date.now() >= deadlineAt) {
        throw new ManualSyncInProgressError(
          'Фоновая синхронизация Sigur не освободила lock вовремя. Попробуйте повторить через минуту.',
        );
      }

      await wait(EXCLUSIVE_SYNC_ACQUIRE_RETRY_MS);
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
    if (exclusiveSyncLeaseHeartbeatStop) {
      exclusiveSyncLeaseHeartbeatStop();
      exclusiveSyncLeaseHeartbeatStop = null;
    }
    await mergeSigurRuntimeState({
      key: SIGUR_EXCLUSIVE_SYNC_STATE_KEY,
      owner: EXCLUSIVE_SYNC_LEASE_OWNER,
      meta: {
        manualSyncLockedAt: null,
        lastManualSyncReleasedAt: new Date().toISOString(),
      },
    }).catch(runtimeError => {
      console.error('[presence-polling] exclusive sync release hook error:', (runtimeError as Error).message);
    });
    await releaseSigurRuntimeLease({
      key: SIGUR_EXCLUSIVE_SYNC_STATE_KEY,
      owner: EXCLUSIVE_SYNC_LEASE_OWNER,
    }).catch(releaseError => {
      console.error('[presence-polling] exclusive sync lease release error:', (releaseError as Error).message);
    });
    manualSyncLocks = 0;
    restartPresencePollingInBackground('acquire lock failure');
    throw error;
  }
}

export async function acquireStructureSyncSchedulerLock(): Promise<void> {
  assertSigurRuntimeAllowed('Sigur structure scheduler');
  if (manualSyncLocks > 0 || (await hasExclusiveSyncLease())) {
    throw new ManualSyncInProgressError();
  }

  const leaseStartedAt = new Date().toISOString();
  const lease = await tryAcquireSigurRuntimeLease({
    key: SIGUR_STRUCTURE_SYNC_STATE_KEY,
    owner: STRUCTURE_SYNC_LEASE_OWNER,
    ttlSeconds: SIGUR_POLLING_LEASE_TTL_SECONDS,
    meta: {
      leaseMode: 'background_structure_sync',
      startedAt: leaseStartedAt,
      leaderOwner: STRUCTURE_SYNC_LEASE_OWNER,
    },
  });

  if (!lease.acquired) {
    throw new ManualSyncInProgressError('Синхронизация структуры уже выполняется.');
  }

  structureSyncLeaseHeartbeatStop = startSigurRuntimeLeaseHeartbeat({
    key: SIGUR_STRUCTURE_SYNC_STATE_KEY,
    owner: STRUCTURE_SYNC_LEASE_OWNER,
    ttlSeconds: SIGUR_POLLING_LEASE_TTL_SECONDS,
    getMeta: () => ({
      leaseMode: 'background_structure_sync',
      startedAt: leaseStartedAt,
      leaderOwner: STRUCTURE_SYNC_LEASE_OWNER,
    }),
    onError: error => {
      console.error('[presence-polling] structure sync lease heartbeat error:', error.message);
    },
  });
}

export async function releaseStructureSyncSchedulerLock(): Promise<void> {
  if (structureSyncLeaseHeartbeatStop) {
    structureSyncLeaseHeartbeatStop();
    structureSyncLeaseHeartbeatStop = null;
  }

  await mergeSigurRuntimeState({
    key: SIGUR_STRUCTURE_SYNC_STATE_KEY,
    owner: STRUCTURE_SYNC_LEASE_OWNER,
    meta: {
      startedAt: null,
      lastReleasedAt: new Date().toISOString(),
    },
  }).catch(error => {
    console.error('[presence-polling] structure sync release hook error:', (error as Error).message);
  });
  await releaseSigurRuntimeLease({
    key: SIGUR_STRUCTURE_SYNC_STATE_KEY,
    owner: STRUCTURE_SYNC_LEASE_OWNER,
  }).catch(error => {
    console.error('[presence-polling] structure sync lease release error:', (error as Error).message);
  });
}

export async function releasePresencePollingLock(): Promise<void> {
  if (manualSyncLocks === 0) {
    return;
  }

  if (manualSyncLeaseHeartbeatStop) {
    manualSyncLeaseHeartbeatStop();
    manualSyncLeaseHeartbeatStop = null;
  }
  if (exclusiveSyncLeaseHeartbeatStop) {
    exclusiveSyncLeaseHeartbeatStop();
    exclusiveSyncLeaseHeartbeatStop = null;
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
  await mergeSigurRuntimeState({
    key: SIGUR_EXCLUSIVE_SYNC_STATE_KEY,
    owner: EXCLUSIVE_SYNC_LEASE_OWNER,
    meta: {
      manualSyncLockedAt: null,
      lastManualSyncReleasedAt: new Date().toISOString(),
    },
  }).catch(error => {
    console.error('[presence-polling] exclusive sync release hook error:', (error as Error).message);
  });
  await releaseSigurRuntimeLease({
    key: SIGUR_EXCLUSIVE_SYNC_STATE_KEY,
    owner: EXCLUSIVE_SYNC_LEASE_OWNER,
  }).catch(error => {
    console.error('[presence-polling] exclusive sync lease release error:', (error as Error).message);
  });

  manualSyncLocks = 0;
  if (manualSyncLocks === 0) {
    restartPresencePollingInBackground('manual sync release');
  }
}

function isSigurPresenceRuntimeAllowed(): boolean {
  try {
    assertSigurRuntimeAllowed('presence-polling');
    return true;
  } catch {
    return false;
  }
}
