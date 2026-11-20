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
import { loadStaffMonthExportInfo, persistStaffMonthStates } from './staff-month-1c.export-state.js';
import {
  staffMonthExportState,
  staffMonthRowHash,
  type IStaffMonthAck,
  type StaffMonthExportState,
} from './staff-month-1c.export-state.rules.js';
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
/** Отпечаток закрытой части последней сборки месяца — для фонового обновления статусов. */
const builtFingerprints = new Map<string, string>();
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
    .then(async snapshot => {
      // Ревизии строк — до выдачи снимка: GET отдаёт их 1С, ACK проверяет по ним.
      const hashed = snapshot.rows.map(row => ({ employeeId: row.employee_id, preliminary: row.preliminary, contentHash: staffMonthRowHash(row) }));
      const states = await persistStaffMonthStates(month, hashed);
      snapshot.exportRows = new Map(hashed.map(row => [row.employeeId, {
        revision: states.get(row.employeeId)?.revision ?? 0, contentHash: row.contentHash,
      }]));
      builtFingerprints.set(month, snapshot.fingerprint);
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

/** Поля выгрузки в ЗУП3 у строки ответа. */
export interface IStaffMonthExportFields {
  state_revision: number;
  content_hash: string | null;
  export_state: StaffMonthExportState | null;
  ready_for_export: boolean;
  last_export: { state_revision: number; acked_at: string; document_ref: string | null } | null;
}

type StaffMonthPageRow =
  | (Omit<IStaffMonthRow, 'days'> & { days?: IStaffMonthRow['days']; present: true } & IStaffMonthExportFields)
  | ({ employee_id: number; present: false } & IStaffMonthExportFields);

export interface IStaffMonthPage {
  snapshot: IStaffMonthSnapshot;
  rows: StaffMonthPageRow[];
  total: number;
  nextCursor: string | null;
  exportCounts: Record<StaffMonthExportState, number>;
  monthReady: boolean;
}

const lastExportOf = (ack: IStaffMonthAck | undefined): IStaffMonthExportFields['last_export'] => (
  ack ? { state_revision: ack.revision, acked_at: ack.ackedAt, document_ref: ack.documentRef } : null
);

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
  // Статус строки — ревизия этого снимка против последнего подтверждения (подтверждения — на момент ответа).
  const info = await loadStaffMonthExportInfo(params.month);
  const counts: Record<StaffMonthExportState, number> = { not_ready: 0, ready: 0, exported: 0, changed: 0 };
  const exportOf = (row: IStaffMonthRow): IStaffMonthExportFields => {
    const own = snapshot.exportRows?.get(row.employee_id);
    const ack = info.acks.get(row.employee_id);
    const state = staffMonthExportState(own
      ? { revision: own.revision, present: true, preliminary: row.preliminary, contentHash: own.contentHash }
      : undefined, ack);
    return {
      state_revision: own?.revision ?? 0,
      content_hash: own?.contentHash ?? null,
      export_state: state,
      ready_for_export: !row.preliminary,
      last_export: lastExportOf(ack),
    };
  };
  const present = snapshot.rows.map(row => ({ row, exported: exportOf(row) }));
  for (const item of present) if (item.exported.export_state) counts[item.exported.export_state] += 1;
  // Надгробия: строка, которую 1С получала, пропала из месяца — её надо удалить в ЗУП3.
  const inSnapshot = new Set(snapshot.rows.map(row => row.employee_id));
  const tombstones: StaffMonthPageRow[] = [];
  for (const [employeeId, state] of info.states) {
    if (state.present || inSnapshot.has(employeeId)) continue;
    const exportState = staffMonthExportState(state, info.acks.get(employeeId));
    if (exportState !== 'changed') continue;
    counts.changed += 1;
    tombstones.push({
      employee_id: employeeId, present: false, state_revision: state.revision, content_hash: null,
      export_state: exportState, ready_for_export: true, last_export: lastExportOf(info.acks.get(employeeId)),
    });
  }
  const wanted = params.filters.export_state ? new Set(params.filters.export_state) : null;
  const matched: StaffMonthPageRow[] = present
    .filter(({ row, exported }) => {
      const index = snapshot.index.get(row.employee_id)!;
      return matchesFilters({ employee_id: row.employee_id, category: row.category, mainKey: index.mainKey, factByObject: index.factByObject }, params.filters)
        && (!wanted || (exported.export_state !== null && wanted.has(exported.export_state)));
    })
    .map(({ row, exported }): StaffMonthPageRow => {
      const base = params.filters.days ? row : (({ days: _days, ...rest }) => rest)(row);
      return { ...base, present: true, ...exported };
    });
  // Надгробия — только в режиме «что забрать» без отбора по объекту, категории и сотруднику.
  if (wanted?.has('changed') && params.filters.object_key === null && params.filters.category === null) {
    matched.push(...tombstones.filter(item => params.filters.employee_id === null || item.employee_id === params.filters.employee_id));
    matched.sort((a, b) => a.employee_id - b.employee_id);
  }
  const { page, hasMore } = pageAfter(matched, afterId, params.limit);
  const last = page[page.length - 1];
  return {
    snapshot,
    rows: page,
    total: matched.length,
    nextCursor: hasMore && last
      ? encodeStaffMonthCursor({ month: params.month, snapshotId: snapshot.id, filters: params.filters, lastEmployeeId: last.employee_id }, secret)
      : null,
    exportCounts: counts,
    monthReady: counts.not_ready === 0 && tombstones.length === 0,
  };
};

/**
 * Фоновое обновление статусов: пересобрать месяц, если изменилась закрытая часть (или force — ночной и первый
 * прогон). Сборка — в той же очереди, что и запросы 1С.
 */
export const refreshStaffMonth = async (month: string, force: boolean): Promise<boolean> => {
  if (!force) {
    const known = builtFingerprints.get(month);
    if (known !== undefined && known === await loadClosedFingerprint(getPool(), `${month}-01`)) return false;
  }
  await startBuild(month);
  return true;
};

export const getStaffMonthSnapshot = (month: string, snapshotId: string | null): Promise<IStaffMonthSnapshot> => (
  resolveSnapshot(month, snapshotId)
);

/** Только для тестов: очистить хранилище. */
export const resetStaffMonthSnapshots = (): void => {
  snapshots.clear();
  latestByMonth.clear();
  builds.clear();
  builtFingerprints.clear();
  buildChain = Promise.resolve();
};
