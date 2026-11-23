/**
 * API для ЗУП3 «сотрудники месяца» — снимки месяца в памяти процесса, страницы, бригады, объекты.
 *
 * Статусы выгрузки и подтверждения 1С — по половинам месяца (half = 1 | 2, миграция 375); месяц целиком отдаётся
 * только для чтения, без статусов.
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
  loadStaffMonthBuild,
  loadStaffMonthExportInfo,
  markStaffMonthBuildStarted,
  persistStaffMonthStates,
} from './staff-month-1c.export-state.js';
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
  STAFF_MONTH_HALVES,
  type IStaffMonthFilters,
  type StaffMonthHalf,
} from './staff-month-1c.rules.js';
import type { IStaffMonthHalfRow, IStaffMonthHalfView } from './staff-month-1c.half.js';
import { buildStaffMonthSnapshot, type IStaffMonthRow, type IStaffMonthSnapshot } from './staff-month-1c.snapshot.js';

export const STAFF_MONTH_FIRST = '2026-06';
const MAX_SNAPSHOTS = 4;
const IDLE_TTL_MS = 30 * 60_000;
const LIVE_STALE_MS = 5 * 60_000;
const CLOSED_STALE_MS = 60 * 60_000;
const WAIT_MS = 25_000;
export const RETRY_AFTER_SECONDS = 15;
/** Фоновая сборка не завершилась — следующая не раньше чем через час. */
const REFRESH_RETRY_AFTER_MS = 60 * 60_000;

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
    .then(async snapshot => {
      // Ревизии строк половин — до выдачи снимка: GET отдаёт их 1С, ACK проверяет по ним. Не начавшуюся половину не
      // пишем: её строк ещё нет, надгробий тоже быть не может.
      const hashed = new Map(STAFF_MONTH_HALVES.filter(half => snapshot.halves[half].bounds.started).map(half => [
        half,
        snapshot.halves[half].rows.map(row => ({ employeeId: row.employee_id, preliminary: row.preliminary, contentHash: staffMonthRowHash(row) })),
      ]));
      const states = await persistStaffMonthStates(month, hashed, snapshot.fingerprint);
      snapshot.exportRows = new Map([...hashed].map(([half, rows]) => [half, new Map(rows.map(row => [row.employeeId, {
        revision: states.get(half)?.get(row.employeeId)?.revision ?? 0, contentHash: row.contentHash,
      }]))]));
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

/** Поля выгрузки в ЗУП3 у строки половины. */
export interface IStaffMonthExportFields {
  state_revision: number;
  content_hash: string | null;
  export_state: StaffMonthExportState | null;
  ready_for_export: boolean;
  last_export: { state_revision: number; acked_at: string; document_ref: string | null } | null;
}

type WithoutDays<T extends { days: unknown }> = Omit<T, 'days'> & { days?: T['days'] };

/** Строка страницы: месяц (только чтение), половина со статусом или надгробие половины. */
export type StaffMonthPageRow =
  | WithoutDays<IStaffMonthRow>
  | (WithoutDays<IStaffMonthHalfRow> & { present: true } & IStaffMonthExportFields)
  | ({ employee_id: number; present: false } & IStaffMonthExportFields);

export interface IStaffMonthPage {
  snapshot: IStaffMonthSnapshot;
  /** Половина запроса; null — месяц целиком. */
  view: IStaffMonthHalfView | null;
  rows: StaffMonthPageRow[];
  total: number;
  nextCursor: string | null;
  /** Счётчики статусов и «половина готова» — только у половины. */
  exportCounts: Record<StaffMonthExportState, number> | null;
  periodReady: boolean | null;
}

const lastExportOf = (ack: IStaffMonthAck | undefined): IStaffMonthExportFields['last_export'] => (
  ack ? { state_revision: ack.revision, acked_at: ack.ackedAt, document_ref: ack.documentRef } : null
);

const withoutDays = <T extends { days: unknown }>(row: T, days: boolean): WithoutDays<T> => {
  if (days) return row;
  const { days: _days, ...rest } = row;
  return rest;
};

/** Половина ещё не началась (16–конец текущего месяца до 16-го). */
export const halfNotStarted = (half: StaffMonthHalf): StaffMonthApiError => new StaffMonthApiError(
  400, 'half_not_started', `Половина ${half === 1 ? '1–15' : '16–конец'} ещё не началась`, false,
);

/** Строки половины со статусами и надгробиями; отбор по объекту — по индексу половины. */
const halfRows = async (
  snapshot: IStaffMonthSnapshot,
  half: StaffMonthHalf,
  filters: IStaffMonthFilters,
): Promise<{ rows: StaffMonthPageRow[]; counts: Record<StaffMonthExportState, number>; ready: boolean }> => {
  const view = snapshot.halves[half];
  if (!view.bounds.started) throw halfNotStarted(half);
  // Статус строки — ревизия этого снимка против последнего подтверждения (подтверждения — на момент ответа).
  const info = await loadStaffMonthExportInfo(snapshot.month, half);
  const revisions = snapshot.exportRows?.get(half);
  const counts: Record<StaffMonthExportState, number> = { not_ready: 0, ready: 0, exported: 0, changed: 0 };
  const exportOf = (row: IStaffMonthHalfRow): IStaffMonthExportFields => {
    const own = revisions?.get(row.employee_id);
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
  const present = view.rows.map(row => ({ row, exported: exportOf(row) }));
  for (const item of present) if (item.exported.export_state) counts[item.exported.export_state] += 1;
  // Надгробия: строка, которую 1С получала, пропала из половины — её надо удалить в ЗУП3.
  const inView = new Set(view.rows.map(row => row.employee_id));
  const tombstones: StaffMonthPageRow[] = [];
  for (const [employeeId, state] of info.states) {
    if (state.present || inView.has(employeeId)) continue;
    const exportState = staffMonthExportState(state, info.acks.get(employeeId));
    if (exportState !== 'changed') continue;
    counts.changed += 1;
    tombstones.push({
      employee_id: employeeId, present: false, state_revision: state.revision, content_hash: null,
      export_state: exportState, ready_for_export: true, last_export: lastExportOf(info.acks.get(employeeId)),
    });
  }
  const wanted = filters.export_state ? new Set(filters.export_state) : null;
  const rows: StaffMonthPageRow[] = present
    .filter(({ row, exported }) => {
      const index = view.index.get(row.employee_id)!;
      return matchesFilters({ employee_id: row.employee_id, category: row.category, mainKey: index.mainKey, factByObject: index.factByObject }, filters)
        && (!wanted || (exported.export_state !== null && wanted.has(exported.export_state)));
    })
    .map(({ row, exported }) => ({ ...withoutDays(row, filters.days), present: true as const, ...exported }));
  // Надгробия — только в режиме «что забрать» без отбора по объекту и категории.
  if (wanted?.has('changed') && filters.object_key === null && filters.category === null) {
    rows.push(...tombstones.filter(item => filters.employee_id === null || item.employee_id === filters.employee_id));
    rows.sort((a, b) => a.employee_id - b.employee_id);
  }
  return { rows, counts, ready: !view.preliminary && counts.not_ready === 0 && tombstones.length === 0 };
};

/** Страница сотрудников: курсор держит снимок и фильтры (в том числе половину). */
export const listStaffMonthEmployees = async (params: {
  month: string;
  filters: IStaffMonthFilters;
  limit: number;
  cursor: string | null;
  snapshotId: string | null;
}): Promise<IStaffMonthPage> => {
  if (params.filters.half === null && params.filters.export_state !== null) {
    throw new StaffMonthApiError(400, 'invalid_filter', 'export_state — только с half=1 или half=2: статусы ведутся по половинам', false);
  }
  const secret = cursorSecret();
  let afterId: number | null = null;
  let snapshotId = params.snapshotId;
  if (params.cursor) {
    const decoded = decodeStaffMonthCursor(params.cursor, secret);
    if (!decoded || decoded.month !== params.month || !sameFilters(decoded.filters, params.filters)
      || (snapshotId !== null && snapshotId !== decoded.snapshotId)) {
      throw new StaffMonthApiError(400, 'invalid_cursor', 'Некорректный cursor: другой месяц, половина, фильтры, подпись или версия — начните обход заново', false);
    }
    afterId = decoded.lastEmployeeId;
    snapshotId = decoded.snapshotId;
  }
  const snapshot = await resolveSnapshot(params.month, snapshotId);
  const half = params.filters.half;
  let matched: StaffMonthPageRow[];
  let counts: Record<StaffMonthExportState, number> | null = null;
  let ready: boolean | null = null;
  if (half === null) {
    matched = snapshot.rows
      .filter(row => {
        const index = snapshot.index.get(row.employee_id)!;
        return matchesFilters({ employee_id: row.employee_id, category: row.category, mainKey: index.mainKey, factByObject: index.factByObject }, params.filters);
      })
      .map(row => withoutDays(row, params.filters.days));
  } else {
    const result = await halfRows(snapshot, half, params.filters);
    matched = result.rows;
    counts = result.counts;
    ready = result.ready;
  }
  const { page, hasMore } = pageAfter(matched, afterId, params.limit);
  const last = page[page.length - 1];
  return {
    snapshot,
    view: half === null ? null : snapshot.halves[half],
    rows: page,
    total: matched.length,
    nextCursor: hasMore && last
      ? encodeStaffMonthCursor({ month: params.month, snapshotId: snapshot.id, filters: params.filters, lastEmployeeId: last.employee_id }, secret)
      : null,
    exportCounts: counts,
    periodReady: ready,
  };
};

/**
 * Фоновое обновление статусов: пересобрать месяц, если сборки ещё не было, изменилась закрытая часть или после
 * nightSince (ночная граница) месяц не собирался. Отметка сборки — в БД (staff_month_1c_half_builds): рестарт сервера
 * месяц не пересобирает. Сборка — в той же очереди, что и запросы 1С.
 */
export const refreshStaffMonth = async (month: string, nightSince: string | null, now: Date = new Date()): Promise<boolean> => {
  const build = await loadStaffMonthBuild(month);
  // Прошлая фоновая сборка не завершилась (сбой, рестарт по памяти) меньше часа назад — не повторять сразу.
  if (build?.startedAt && (!build.builtAt || build.builtAt < build.startedAt)
    && now.getTime() - Date.parse(build.startedAt) < REFRESH_RETRY_AFTER_MS) return false;
  const due = !build?.builtAt
    || (nightSince !== null && build.builtAt < nightSince)
    || build.fingerprint !== await loadClosedFingerprint(getPool(), `${month}-01`);
  if (!due) return false;
  await markStaffMonthBuildStarted(month);
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
  buildChain = Promise.resolve();
};
