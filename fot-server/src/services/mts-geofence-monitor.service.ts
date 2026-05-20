/**
 * Поллер геозон: каждые MTS_GEOFENCE_POLL_MS проверяет активные назначения
 * (employee × geofence) и для тех сотрудников, что сейчас на смене, классифицирует
 * последний снимок позиции. По dwell-счётчику открывает/закрывает запись
 * нарушения и шлёт уведомление администраторам.
 *
 * Lease через sigur_runtime_state (ключ 'mts_geofence_monitor'), как у
 * mts-location-poller — при нескольких инстансах PM2 крутит только один.
 */
import * as Sentry from '@sentry/node';
import { query } from '../config/postgres.js';
import { encryptionService } from './encryption.service.js';
import {
  classifySnapshot,
  getActiveShiftWindow,
  type IGeoPoint,
} from './mts-geofence-geometry.js';
import { mtsGeofenceService } from './mts-geofence.service.js';
import { notificationService } from './notification.service.js';
import {
  tryAcquireSigurRuntimeLease,
  releaseSigurRuntimeLease,
  getSigurRuntimeOwner,
} from './sigur-runtime-state.service.js';
import { runWithCronMonitor, type CronRunStatus } from '../utils/sentry-cron.js';
import { settingsService } from './settings.service.js';

const LEASE_KEY = 'mts_geofence_monitor';
const LEASE_TTL_SECONDS = 180;
const STARTUP_DELAY_MS = 60_000;

const DEFAULT_POLL_MS = 300_000;
const DEFAULT_REPEAT_MIN = 30;
const DEFAULT_SNAPSHOT_MAX_AGE_MIN = 15;
const DWELL_OUTSIDE_THRESHOLD = 2;
const DWELL_INSIDE_THRESHOLD = 1;

interface IDwellState {
  outside: number;
  inside: number;
}

const dwell = new Map<string, IDwellState>();
const dwellKey = (employeeId: number, geofenceId: string): string => `${employeeId}:${geofenceId}`;

let timer: NodeJS.Timeout | null = null;
let stopped = false;

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

interface ILatestSnapshot {
  subscriberId: number;
  recordedAt: Date;
  point: IGeoPoint;
  accuracyMeters: number | null;
  source: string | null;
}

interface ISubscriberLink {
  subscriberId: number;
  employeeId: number;
}

async function loadSubscriberLinks(employeeIds: number[]): Promise<ISubscriberLink[]> {
  if (employeeIds.length === 0) return [];
  const rows = await query<{ subscriber_id: number; employee_id: number }>(
    `SELECT subscriber_id, employee_id
       FROM mts_subscriber_map
      WHERE employee_id = ANY($1::int[])`,
    [employeeIds],
  );
  return rows.map(r => ({ subscriberId: r.subscriber_id, employeeId: r.employee_id }));
}

async function loadLatestSnapshots(subscriberIds: number[], maxAgeMs: number): Promise<Map<number, ILatestSnapshot>> {
  if (subscriberIds.length === 0) return new Map();
  // DISTINCT ON по subscriber_id → последний снимок на каждого.
  const minAt = new Date(Date.now() - maxAgeMs).toISOString();
  const rows = await query<{
    subscriber_id: number;
    recorded_at: string;
    lat_enc: string | null;
    lon_enc: string | null;
    accuracy_m_enc: string | null;
    source_enc: string | null;
  }>(
    `SELECT DISTINCT ON (subscriber_id)
            subscriber_id, recorded_at, lat_enc, lon_enc, accuracy_m_enc, source_enc
       FROM mts_location_snapshots
      WHERE subscriber_id = ANY($1::bigint[])
        AND recorded_at >= $2::timestamptz
      ORDER BY subscriber_id, recorded_at DESC`,
    [subscriberIds, minAt],
  );

  const result = new Map<number, ILatestSnapshot>();
  for (const row of rows) {
    const lat = Number(encryptionService.decryptField(row.lat_enc));
    const lng = Number(encryptionService.decryptField(row.lon_enc));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const accuracyRaw = encryptionService.decryptField(row.accuracy_m_enc);
    const accuracy = accuracyRaw == null || accuracyRaw === '' ? null : Number(accuracyRaw);
    result.set(row.subscriber_id, {
      subscriberId: row.subscriber_id,
      recordedAt: new Date(row.recorded_at),
      point: { lat, lng },
      accuracyMeters: Number.isFinite(accuracy) ? (accuracy as number) : null,
      source: encryptionService.decryptField(row.source_enc),
    });
  }
  return result;
}

async function loadSuperAdminUserIds(): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT u.id
       FROM app_auth.users u
       LEFT JOIN user_profiles p ON p.id = u.id
      WHERE p.position_type IN ('super_admin')`,
  );
  return rows.map(r => r.id);
}

interface ITickContext {
  now: Date;
  notifyRecipients: string[];
}

async function evaluatePair(
  ctx: ITickContext,
  employeeId: number,
  geofence: { id: string; name: string; geometry: IGeoPoint[] },
  snapshot: ILatestSnapshot,
): Promise<void> {
  const classification = classifySnapshot(snapshot.point, snapshot.accuracyMeters, geofence.geometry);
  const key = dwellKey(employeeId, geofence.id);
  const state = dwell.get(key) || { outside: 0, inside: 0 };

  if (classification === 'outside') {
    state.outside++;
    state.inside = 0;
  } else if (classification === 'inside') {
    state.inside++;
    state.outside = 0;
  } else {
    // ambiguous — не меняем счётчики
    dwell.set(key, state);
    return;
  }
  dwell.set(key, state);

  if (classification === 'outside' && state.outside >= DWELL_OUTSIDE_THRESHOLD) {
    const open = await mtsGeofenceService.findOpenViolation(geofence.id, employeeId);
    if (!open) {
      const created = await mtsGeofenceService.openViolation({
        geofenceId: geofence.id,
        employeeId,
        startedAt: ctx.now,
        latitude: snapshot.point.lat,
        longitude: snapshot.point.lng,
        accuracyMeters: snapshot.accuracyMeters,
        source: snapshot.source,
      });
      await notifyViolation(ctx, created.id, employeeId, geofence);
    } else {
      const repeatMs = envInt('MTS_GEOFENCE_REPEAT_MIN', DEFAULT_REPEAT_MIN) * 60_000;
      const since = open.lastNotifiedAt ? Date.now() - Date.parse(open.lastNotifiedAt) : Infinity;
      if (since >= repeatMs) {
        await notifyViolation(ctx, open.id, employeeId, geofence);
      }
    }
  } else if (classification === 'inside' && state.inside >= DWELL_INSIDE_THRESHOLD) {
    const open = await mtsGeofenceService.findOpenViolation(geofence.id, employeeId);
    if (open) {
      await mtsGeofenceService.closeViolation(open.id, ctx.now);
    }
  }
}

async function notifyViolation(
  ctx: ITickContext,
  violationId: string,
  employeeId: number,
  geofence: { id: string; name: string },
): Promise<void> {
  if (ctx.notifyRecipients.length === 0) return;
  const empRow = await query<{ full_name: string | null }>(
    'SELECT full_name FROM employees WHERE id = $1',
    [employeeId],
  );
  const fullName = empRow[0]?.full_name || `сотрудник #${employeeId}`;
  const title = 'МТС: выход из геозоны';
  const body = `${fullName} вне зоны «${geofence.name}»`;
  await notificationService.createMany(
    ctx.notifyRecipients.map(userId => ({
      userId,
      type: 'MTS_GEOFENCE_VIOLATION',
      title,
      body,
      metadata: {
        violationId,
        geofenceId: geofence.id,
        geofenceName: geofence.name,
        employeeId,
      },
    })),
  );
  await mtsGeofenceService.markNotified(violationId);
}

export async function runGeofenceMonitorTick(): Promise<void> {
  const now = new Date();
  const { geofences, assignmentsByEmployee } = await mtsGeofenceService.loadActiveGeofencesWithAssignments();
  if (geofences.size === 0 || assignmentsByEmployee.size === 0) return;

  const employeeIds = Array.from(assignmentsByEmployee.keys());

  // Какие сотрудники сейчас на смене?
  const onShift = new Set<number>();
  await Promise.all(
    employeeIds.map(async empId => {
      const win = await getActiveShiftWindow(empId, now);
      if (win) onShift.add(empId);
    }),
  );
  if (onShift.size === 0) return;

  const links = await loadSubscriberLinks(Array.from(onShift));
  const subToEmp = new Map<number, number>();
  for (const l of links) subToEmp.set(l.subscriberId, l.employeeId);
  if (subToEmp.size === 0) return;

  const maxAgeMs = envInt('MTS_GEOFENCE_SNAPSHOT_MAX_AGE_MIN', DEFAULT_SNAPSHOT_MAX_AGE_MIN) * 60_000;
  const snapshots = await loadLatestSnapshots(Array.from(subToEmp.keys()), maxAgeMs);
  if (snapshots.size === 0) return;

  const recipients = await loadSuperAdminUserIds();
  const ctx: ITickContext = { now, notifyRecipients: recipients };

  for (const [subscriberId, snapshot] of snapshots) {
    const employeeId = subToEmp.get(subscriberId);
    if (!employeeId) continue;
    const geofenceIds = assignmentsByEmployee.get(employeeId) || [];
    for (const gId of geofenceIds) {
      const geofence = geofences.get(gId);
      if (!geofence || geofence.geometry.length < 3) continue;
      try {
        await evaluatePair(ctx, employeeId, geofence, snapshot);
      } catch (err) {
        console.error('[mts-geofence-monitor] evaluatePair failed:', (err as Error).message);
        Sentry.captureException(err, { tags: { module: 'mts-geofence-monitor', employeeId: String(employeeId) } });
      }
    }
  }
}

async function tick(owner: string): Promise<void> {
  // Если МТС-токен не настроен — без снимков смысла крутить нет.
  const config = await settingsService.getResolvedMtsConfig();
  if (!config) return;

  const acq = await tryAcquireSigurRuntimeLease({
    key: LEASE_KEY,
    owner,
    ttlSeconds: LEASE_TTL_SECONDS,
    meta: { tickedAt: new Date().toISOString() },
  });
  if (!acq.acquired) return;

  let cronStatus: CronRunStatus = 'ok';
  try {
    await runWithCronMonitor(
      'mts-geofence-monitor',
      async () => {
        try {
          await runGeofenceMonitorTick();
          console.log('[mts-geofence-monitor] tick: ok');
        } catch (err) {
          cronStatus = 'error';
          console.error('[mts-geofence-monitor] tick failed:', err instanceof Error ? err.message : 'unknown');
          Sentry.captureException(err);
        }
        return cronStatus;
      },
      {
        schedule: { type: 'interval', value: 5, unit: 'minute' },
        checkinMargin: 5,
        maxRuntime: 10,
      },
    );
  } finally {
    await releaseSigurRuntimeLease({ key: LEASE_KEY, owner }).catch(err =>
      console.error('[mts-geofence-monitor] release lease failed:', (err as Error).message),
    );
  }
}

export function startMtsGeofenceMonitor(): void {
  if (timer) return;
  stopped = false;
  const intervalMs = Math.max(60_000, envInt('MTS_GEOFENCE_POLL_MS', DEFAULT_POLL_MS));
  const owner = getSigurRuntimeOwner('mts_geofence_monitor');

  console.log(`[mts-geofence-monitor] starting (interval=${Math.round(intervalMs / 1000)}s, owner=${owner})`);

  const run = (): void => {
    if (stopped) return;
    void tick(owner);
  };

  setTimeout(run, STARTUP_DELAY_MS);
  timer = setInterval(run, intervalMs);
}

export function stopMtsGeofenceMonitor(): void {
  stopped = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  dwell.clear();
}

/** Только для тестов: ресет внутренних счётчиков. */
export function __resetGeofenceMonitorForTests(): void {
  dwell.clear();
  stopped = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
