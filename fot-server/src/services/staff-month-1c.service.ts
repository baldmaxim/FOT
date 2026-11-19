/**
 * API для ЗУП3 «сотрудники месяца» — снимки месяца в памяти процесса, страницы, бригады, объекты.
 *
 * Снимок собирается целиком в одной транзакции только для чтения (withReadOnlySnapshot) и дальше не меняется:
 * страницы, /brigades и /objects одного обхода читают один снимок (snapshot_id в курсоре). Новый снимок месяца
 * строится, когда сменился отпечаток закрытой части, у снимка с живыми днями открытого месяца (или подачами на
 * доработке) прошло 5 минут, у остальных — 60 минут. Снимок живёт 30 минут после последнего обращения, в памяти —
 * не больше 4. Сборка — одна на процесс; запрос ждёт её до 25 секунд, дальше — 503 snapshot_building.
 *
 * Хранилище — память одного процесса: прод — один процесс PM2 (ecosystem.config.cjs, fork, instances: 1). При
 * нескольких процессах курсоры перестанут находить снимки (409 snapshot_expired).
 */
import { createHash } from 'node:crypto';

import { getPool, withReadOnlySnapshot } from '../config/postgres.js';
import { env } from '../config/env.js';
import { loadClosedFingerprint, monthBoundsOf } from './staff-month-1c.load.js';
import {
  decodeStaffMonthCursor,
  encodeStaffMonthCursor,
  matchesFilters,
  pageAfter,
  sameFilters,
  type IStaffMonthFilters,
} from './staff-month-1c.rules.js';
import { buildStaffMonthSnapshot, type IStaffMonthRow, type IStaffMonthSnapshot } from './staff-month-1c.snapshot.js';

export const STAFF_MONTH_FIRST = '2026-06';
const MAX_SNAPSHOTS = 4;
const IDLE_TTL_MS = 30 * 60_000;
const LIVE_STALE_MS = 5 * 60_000;
const CLOSED_STALE_MS = 60 * 60_000;
const WAIT_MS = 25_000;
export const RETRY_AFTER_SECONDS = 15;

export class StaffMonthApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

interface IEntry {
  snapshot: IStaffMonthSnapshot;
  lastAccess: number;
}

const snapshots = new Map<string, IEntry>();
const latestByMonth = new Map<string, string>();
const builds = new Map<string, Promise<IStaffMonthSnapshot>>();
let buildChain: Promise<unknown> = Promise.resolve();

/** Ключ подписи курсора — из серверного секрета с отдельной меткой. */
const cursorSecret = (): string => createHash('sha256').update(`staff-month-cursor|${env.JWT_SECRET}`).digest('hex');

const evict = (now: number): void => {
  for (const [id, entry] of snapshots) {
    if (now - entry.lastAccess > IDLE_TTL_MS) snapshots.delete(id);
  }
  while (snapshots.size > MAX_SNAPSHOTS) {
    const oldest = [...snapshots].sort(([, a], [, b]) => a.lastAccess - b.lastAccess)[0];
    snapshots.delete(oldest[0]);
  }
  for (const [month, id] of latestByMonth) if (!snapshots.has(id)) latestByMonth.delete(month);
};

const isStale = (snapshot: IStaffMonthSnapshot, now: number): boolean => {
  const age = now - Date.parse(snapshot.generatedAt);
  const live = snapshot.hasLive && (snapshot.bounds.open || snapshot.preliminary);
  return age > (live ? LIVE_STALE_MS : CLOSED_STALE_MS);
};

/** Сборка месяца: одна на процесс (цепочка), запросы того же месяца ждут её же. */
const startBuild = (month: string): Promise<IStaffMonthSnapshot> => {
  const running = builds.get(month);
  if (running) return running;
  const promise = buildChain.then(() => withReadOnlySnapshot(client => buildStaffMonthSnapshot(client, monthBoundsOf(month))))
    .then(snapshot => {
      snapshots.set(snapshot.id, { snapshot, lastAccess: Date.now() });
      latestByMonth.set(month, snapshot.id);
      evict(Date.now());
      return snapshot;
    })
    .finally(() => builds.delete(month));
  buildChain = promise.catch(() => undefined);
  builds.set(month, promise);
  return promise;
};

const waitFor = async (promise: Promise<IStaffMonthSnapshot>): Promise<IStaffMonthSnapshot> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), WAIT_MS); });
  try {
    const result = await Promise.race([promise, timeout]);
    if (result === null) {
      throw new StaffMonthApiError(503, 'snapshot_building', 'Снимок месяца ещё собирается — повторите запрос позже', true);
    }
    return result;
  } catch (err) {
    if (err instanceof StaffMonthApiError) throw err;
    console.error('[staff-month] сборка снимка не удалась:', err);
    throw new StaffMonthApiError(503, 'calculation_failed', 'Не удалось собрать данные месяца — повторите запрос позже', true);
  } finally {
    clearTimeout(timer);
  }
};

/** Действующий снимок месяца или новый. */
const currentSnapshot = async (month: string): Promise<IStaffMonthSnapshot> => {
  const now = Date.now();
  evict(now);
  const id = latestByMonth.get(month);
  const entry = id ? snapshots.get(id) : undefined;
  if (entry && !isStale(entry.snapshot, now) && !builds.has(month)) {
    const fingerprint = await loadClosedFingerprint(getPool(), entry.snapshot.bounds.start);
    if (fingerprint === entry.snapshot.fingerprint) {
      entry.lastAccess = now;
      return entry.snapshot;
    }
  }
  const building = startBuild(month);
  building.catch(() => undefined);
  return waitFor(building);
};

/** Снимок по id: удалён или чужого месяца — 409 snapshot_expired. */
const snapshotById = (id: string, month: string): IStaffMonthSnapshot => {
  evict(Date.now());
  const entry = snapshots.get(id);
  if (!entry || entry.snapshot.month !== month) {
    throw new StaffMonthApiError(409, 'snapshot_expired', 'Снимок месяца устарел — начните обход заново без cursor и snapshot_id', false);
  }
  entry.lastAccess = Date.now();
  return entry.snapshot;
};

const resolveSnapshot = async (month: string, snapshotId: string | null): Promise<IStaffMonthSnapshot> => (
  snapshotId ? snapshotById(snapshotId, month) : currentSnapshot(month)
);

export interface IStaffMonthPage {
  snapshot: IStaffMonthSnapshot;
  rows: Array<Omit<IStaffMonthRow, 'days'> & { days?: IStaffMonthRow['days'] }>;
  total: number;
  nextCursor: string | null;
}

/** Страница сотрудников: курсор держит снимок и фильтры. */
export const listStaffMonthEmployees = async (params: {
  month: string;
  filters: IStaffMonthFilters;
  limit: number;
  cursor: string | null;
  snapshotId: string | null;
}): Promise<IStaffMonthPage> => {
  const secret = cursorSecret();
  let afterId: number | null = null;
  let snapshotId = params.snapshotId;
  if (params.cursor) {
    const decoded = decodeStaffMonthCursor(params.cursor, secret);
    if (!decoded || decoded.month !== params.month || !sameFilters(decoded.filters, params.filters)
      || (snapshotId !== null && snapshotId !== decoded.snapshotId)) {
      throw new StaffMonthApiError(400, 'invalid_cursor', 'Некорректный cursor: другой месяц, фильтры или подпись — начните обход заново', false);
    }
    afterId = decoded.lastEmployeeId;
    snapshotId = decoded.snapshotId;
  }
  const snapshot = await resolveSnapshot(params.month, snapshotId);
  const matched = snapshot.rows.filter(row => {
    const index = snapshot.index.get(row.employee_id)!;
    return matchesFilters({ employee_id: row.employee_id, category: row.category, mainKey: index.mainKey, factByObject: index.factByObject }, params.filters);
  });
  const { page, hasMore } = pageAfter(matched, afterId, params.limit);
  const last = page[page.length - 1];
  return {
    snapshot,
    rows: page.map(row => (params.filters.days ? row : (({ days: _days, ...rest }) => rest)(row))),
    total: matched.length,
    nextCursor: hasMore && last
      ? encodeStaffMonthCursor({ month: params.month, snapshotId: snapshot.id, filters: params.filters, lastEmployeeId: last.employee_id }, secret)
      : null,
  };
};

export const getStaffMonthSnapshot = (month: string, snapshotId: string | null): Promise<IStaffMonthSnapshot> => (
  resolveSnapshot(month, snapshotId)
);

/** Только для тестов: очистить хранилище. */
export const resetStaffMonthSnapshots = (): void => {
  snapshots.clear();
  latestByMonth.clear();
  builds.clear();
  buildChain = Promise.resolve();
};
