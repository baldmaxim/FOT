/**
 * СКУД: агрегация присутствия по физическим объектам (travel_objects) и компаниям
 * (прямым детям корневого узла «Объект»). Используется страницей `/skud-presence`.
 *
 * Включает и сотрудников из локальной БД (synced), и проходы, оставшиеся с
 * employee_id IS NULL (unsynced — компании вне whitelist, гости и т.п.). Для
 * unsynced людей «компания» резолвится через Sigur API (см. sigur-presence-resolver).
 */
import { getPresence } from './skud-presence.service.js';
import { listTravelObjects } from './skud-travel.service.js';
import { getCompanyResolveIndex, getInternalAccessPoints } from './skud-shared.service.js';
import { resolveSigurEmployeesByNames, resolveSigurEmployeesByIds, normalizeMatchName } from './sigur-presence-resolver.service.js';
import { query } from '../config/postgres.js';
import { formatDateToISO } from '../utils/date.utils.js';
import { createSwrCache } from '../utils/swr-cache.js';

export const NO_OBJECT_BUCKET_ID = '__no_object__';
export const NO_COMPANY_ID = '__no_company__';
export const SIGUR_COMPANY_ID_PREFIX = 'sigur::';

export interface IPresenceObjectEmployee {
  employee_id: number;
  full_name: string;
  position_name: string | null;
  department_name: string | null;
  first_entry: string | null;
  last_access_point: string | null;
  since: string | null;
  is_unsynced: boolean;
}

export interface IPresenceObjectCompany {
  company_id: string;
  company_name: string;
  online_count: number;
  employees: IPresenceObjectEmployee[];
}

export interface IPresenceObjectBucket {
  object_id: string | null;
  object_name: string;
  has_map: boolean;
  online_count: number;
  companies: IPresenceObjectCompany[];
}

export interface IPresenceByObjectResponse {
  generated_at: string;
  total_online: number;
  buckets: IPresenceObjectBucket[];
}

const CACHE_TTL_MS = 30_000;
const CACHE_STALE_MS = 10 * 60_000;
// SWR-кэш, ключуется по отсортированному списку allowedObjectIds (или '__all__'),
// чтобы юзер с приписками к конкретным объектам не получал общий кеш с админом.
// Протухшее значение отдаётся сразу + фоновая ревалидация (без холодных пауз).
const cache = createSwrCache<IPresenceByObjectResponse>();

function buildCacheKey(allowedObjectIds: string[] | 'all'): string {
  if (allowedObjectIds === 'all') return '__all__';
  return [...allowedObjectIds].sort().join(',');
}

export function invalidatePresenceByObjectCache(): void {
  cache.clear();
}

/** Перегреть «горячий» глобальный scope (allowedObjectIds='all') свежими
 *  данными в фоне — из realtime-нотификации при новых СКУД-событиях. */
export function rewarmPresenceByObjectAll(): void {
  cache.refreshNow(
    '__all__',
    CACHE_TTL_MS,
    CACHE_STALE_MS,
    () => computePresenceByObject('all'),
  );
}

const collator = new Intl.Collator('ru', { sensitivity: 'base' });

function compareByCountThenName(
  aCount: number,
  bCount: number,
  aName: string,
  bName: string,
): number {
  if (aCount !== bCount) return bCount - aCount;
  return collator.compare(aName, bName);
}

function compareEmployees(a: IPresenceObjectEmployee, b: IPresenceObjectEmployee): number {
  const aEntry = a.first_entry ?? '99:99:99';
  const bEntry = b.first_entry ?? '99:99:99';
  if (aEntry !== bEntry) return aEntry < bEntry ? -1 : 1;
  return collator.compare(a.full_name, b.full_name);
}

/** Детерминистский хэш ФИО → отрицательное число, чтобы employee_id для unsynced
 *  не пересекался с реальными id (positive bigint) и был уникальным React-ключом. */
function unsyncedEmployeeKey(physicalPerson: string): number {
  let hash = 5381;
  for (let i = 0; i < physicalPerson.length; i++) {
    hash = ((hash << 5) + hash + physicalPerson.charCodeAt(i)) | 0;
  }
  // Гарантируем отрицательное число (collision-safe для разумных размеров).
  return -Math.abs(hash) - 1;
}

interface IUnsyncedEvent {
  physical_person: string;
  event_time: string;
  direction: string | null;
  access_point: string | null;
}

export async function getPresenceByObject(
  opts: { allowedObjectIds?: string[] | 'all' } = {},
): Promise<IPresenceByObjectResponse> {
  const allowedObjectIds: string[] | 'all' = opts.allowedObjectIds ?? 'all';
  return cache.getOrRefresh(
    buildCacheKey(allowedObjectIds),
    CACHE_TTL_MS,
    CACHE_STALE_MS,
    () => computePresenceByObject(allowedObjectIds),
  );
}

async function computePresenceByObject(
  allowedObjectIds: string[] | 'all',
): Promise<IPresenceByObjectResponse> {
  const today = formatDateToISO(new Date());

  const [presence, travelObjectsAll, companyIndex, internalPoints, unsyncedEvents] = await Promise.all([
    getPresence({ departmentId: null }),
    listTravelObjects(),
    getCompanyResolveIndex(),
    getInternalAccessPoints(),
    query<IUnsyncedEvent>(
      `SELECT physical_person, event_time, direction, access_point
       FROM skud_events
       WHERE event_date = $1 AND employee_id IS NULL AND physical_person IS NOT NULL
       ORDER BY event_time DESC`,
      [today],
    ),
  ]);

  // Если задан scope — оставляем только разрешённые объекты. Сотрудники,
  // пробившиеся на access_points чужих объектов, попадут в null (см. ниже)
  // и потом будут отброшены из выдачи вместе с bucket'ом «Без объекта».
  const allowedSet = allowedObjectIds === 'all' ? null : new Set(allowedObjectIds);
  const travelObjects = allowedSet
    ? travelObjectsAll.filter(obj => allowedSet.has(obj.id))
    : travelObjectsAll;

  // Map access_point_name → travel_object_id.
  const accessPointToObjectId = new Map<string, string>();
  const objectMeta = new Map<string, { id: string; name: string; has_map: boolean }>();
  for (const obj of travelObjects) {
    objectMeta.set(obj.id, { id: obj.id, name: obj.name, has_map: obj.has_map });
    for (const ap of obj.access_points) {
      if (!accessPointToObjectId.has(ap)) {
        accessPointToObjectId.set(ap, obj.id);
      }
    }
  }

  // ─── Synced employees ───
  const onlineEmployees = presence.filter(p => p.status === 'online');
  const onlineIds = onlineEmployees.map(p => p.employee_id);

  const orgByEmpId = new Map<number, string | null>();
  const sigurIdByEmpId = new Map<number, number | null>();
  if (onlineIds.length > 0) {
    const rows = await query<{ id: number; org_department_id: string | null; sigur_employee_id: number | string | null }>(
      'SELECT id, org_department_id, sigur_employee_id FROM employees WHERE id = ANY($1::bigint[])',
      [onlineIds],
    );
    for (const row of rows) {
      orgByEmpId.set(row.id, row.org_department_id);
      // PG bigint часто приходит строкой — приводим к Number с гардом.
      const raw = row.sigur_employee_id;
      const sigurId = raw == null ? null : Number(raw);
      sigurIdByEmpId.set(row.id, sigurId != null && Number.isFinite(sigurId) ? sigurId : null);
    }
  }

  // Bulk-резолв department_name из Sigur API для synced сотрудников. Имена в локальной
  // БД (`org_departments.name`) могут быть пусты/рассинхронизированы — Sigur API считаем
  // источником истины. Fallback на presence.department_name при пустом матче.
  const syncedSigurIds: number[] = [];
  for (const sid of sigurIdByEmpId.values()) {
    if (sid != null) syncedSigurIds.push(sid);
  }
  const sigurDeptByEmpSigurId = syncedSigurIds.length > 0
    ? await resolveSigurEmployeesByIds(syncedSigurIds)
    : new Map();

  // ─── Unsynced events: вычисляем «online» по последнему внешнему событию ───
  // events отсортированы по time DESC: first hit per physical_person = latest event.
  interface IUnsyncedPersonState {
    physical_person: string;
    last: IUnsyncedEvent;
    first_entry_time: string | null;
  }
  const personState = new Map<string, IUnsyncedPersonState>();
  for (const evt of unsyncedEvents || []) {
    const name = (evt.physical_person || '').trim();
    if (!name) continue;
    if (evt.access_point && internalPoints.has(evt.access_point)) continue;
    const key = name.toLowerCase();
    if (!personState.has(key)) {
      personState.set(key, { physical_person: name, last: evt, first_entry_time: null });
    }
    // first_entry — самое раннее event_time с direction='entry'. events DESC,
    // поэтому overwrite каждым 'entry' даст в итоге самый ранний из встреченных.
    if (evt.direction === 'entry') {
      const state = personState.get(key)!;
      state.first_entry_time = evt.event_time;
    }
  }

  const onlineUnsynced = [...personState.values()].filter(s => s.last.direction === 'entry');
  const unsyncedNames = onlineUnsynced.map(s => s.physical_person);
  const sigurResolved = unsyncedNames.length > 0
    ? await resolveSigurEmployeesByNames(unsyncedNames)
    : new Map();

  // ─── Аккумулятор bucket'ов ───
  type CompanyAcc = IPresenceObjectCompany;
  type BucketAcc = {
    object_id: string | null;
    object_name: string;
    has_map: boolean;
    companies: Map<string, CompanyAcc>;
  };
  const buckets = new Map<string, BucketAcc>();

  // Предзаполняем bucket'ы по всем travel_objects (даже с 0 online).
  for (const obj of travelObjects) {
    buckets.set(obj.id, {
      object_id: obj.id,
      object_name: obj.name,
      has_map: obj.has_map,
      companies: new Map(),
    });
  }

  const ensureBucket = (objectId: string | null): BucketAcc => {
    if (objectId === null) {
      let bucket = buckets.get(NO_OBJECT_BUCKET_ID);
      if (!bucket) {
        bucket = { object_id: null, object_name: 'Без объекта', has_map: false, companies: new Map() };
        buckets.set(NO_OBJECT_BUCKET_ID, bucket);
      }
      return bucket;
    }
    let bucket = buckets.get(objectId);
    if (!bucket) {
      const meta = objectMeta.get(objectId);
      bucket = { object_id: objectId, object_name: meta?.name || '—', has_map: meta?.has_map ?? false, companies: new Map() };
      buckets.set(objectId, bucket);
    }
    return bucket;
  };

  const ensureCompany = (bucket: BucketAcc, companyId: string, companyName: string): CompanyAcc => {
    let company = bucket.companies.get(companyId);
    if (!company) {
      company = { company_id: companyId, company_name: companyName, online_count: 0, employees: [] };
      bucket.companies.set(companyId, company);
    }
    return company;
  };

  // ─── Synced fill ───
  for (const emp of onlineEmployees) {
    const objectId = emp.last_access_point
      ? accessPointToObjectId.get(emp.last_access_point) ?? null
      : null;
    const bucket = ensureBucket(objectId);

    const orgId = orgByEmpId.get(emp.employee_id) ?? null;
    let companyId = NO_COMPANY_ID;
    let companyName = 'Без компании';
    if (orgId) {
      const resolved = companyIndex.companyByDeptId.get(orgId);
      if (resolved) {
        const meta = companyIndex.companyMeta.get(resolved);
        if (meta) {
          companyId = resolved;
          companyName = meta.name || '—';
        }
      }
    }

    const sigurEmpId = sigurIdByEmpId.get(emp.employee_id) ?? null;
    const sigurMatch = sigurEmpId != null ? sigurDeptByEmpSigurId.get(sigurEmpId) : undefined;
    const departmentName = sigurMatch?.department.name || emp.department_name || null;

    const company = ensureCompany(bucket, companyId, companyName);
    company.employees.push({
      employee_id: emp.employee_id,
      full_name: emp.full_name,
      position_name: emp.position_name,
      department_name: departmentName,
      first_entry: emp.first_entry,
      last_access_point: emp.last_access_point,
      since: emp.since,
      is_unsynced: false,
    });
    company.online_count += 1;
  }

  // ─── Unsynced fill ───
  for (const state of onlineUnsynced) {
    const lastAp = state.last.access_point;
    const objectId = lastAp ? accessPointToObjectId.get(lastAp) ?? null : null;
    const bucket = ensureBucket(objectId);

    let companyId = NO_COMPANY_ID;
    let companyName = 'Без компании';
    let departmentName: string | null = null;
    const sigurMatch = sigurResolved.get(normalizeMatchName(state.physical_person));
    if (sigurMatch) {
      departmentName = sigurMatch.department.name || null;
      // Группа = непосредственный отдел в Sigur (папка, в которой лежит сотрудник).
      // Не root, не local company из БД: этих компаний в БД может не быть, структуру
      // unsynced тянем напрямую из Sigur. Если ФИО не сматчилось (sigurMatch===undefined) —
      // остаёмся в NO_COMPANY_ID, см. логи `[sigur-presence-resolver] unresolved sample`.
      companyId = `${SIGUR_COMPANY_ID_PREFIX}${sigurMatch.department.sigur_department_id}`;
      companyName = sigurMatch.department.name || '—';
    }

    const company = ensureCompany(bucket, companyId, companyName);
    company.employees.push({
      employee_id: unsyncedEmployeeKey(state.physical_person.toLowerCase()),
      full_name: state.physical_person,
      position_name: null,
      department_name: departmentName,
      first_entry: state.first_entry_time,
      last_access_point: lastAp,
      since: state.last.event_time,
      is_unsynced: true,
    });
    company.online_count += 1;
  }

  // ─── Финализация ───
  // При scoped-доступе (allowedSet !== null) bucket «Без объекта» содержит
  // сотрудников, пробившихся на access_points ЧУЖИХ объектов — их видеть нельзя.
  if (allowedSet) buckets.delete(NO_OBJECT_BUCKET_ID);
  const finalBuckets: IPresenceObjectBucket[] = [];
  for (const bucket of buckets.values()) {
    // Пост-merge: компании с одинаковым normalized именем (но разными id —
    // например, local UUID для synced и `sigur::ID` для unsynced) сливаются
    // в одну. Предпочтение — не-`sigur::` записи (local). `NO_COMPANY_ID`
    // никогда не мерджится, чтобы fallback-группа не поглощала реальные.
    const byNormalizedName = new Map<string, IPresenceObjectCompany>();
    const standalone: IPresenceObjectCompany[] = [];
    for (const company of bucket.companies.values()) {
      if (company.company_id === NO_COMPANY_ID) {
        standalone.push(company);
        continue;
      }
      const key = normalizeMatchName(company.company_name);
      if (!key) {
        standalone.push(company);
        continue;
      }
      const existing = byNormalizedName.get(key);
      if (!existing) {
        byNormalizedName.set(key, company);
        continue;
      }
      const existingIsSigur = existing.company_id.startsWith(SIGUR_COMPANY_ID_PREFIX);
      const candidateIsSigur = company.company_id.startsWith(SIGUR_COMPANY_ID_PREFIX);
      const winner = existingIsSigur && !candidateIsSigur ? company : existing;
      const loser = winner === existing ? company : existing;
      winner.employees.push(...loser.employees);
      winner.online_count += loser.online_count;
      byNormalizedName.set(key, winner);
    }

    const companies: IPresenceObjectCompany[] = [...byNormalizedName.values(), ...standalone];
    let bucketTotal = 0;
    for (const company of companies) {
      company.employees.sort(compareEmployees);
      bucketTotal += company.online_count;
    }
    companies.sort((a, b) => compareByCountThenName(a.online_count, b.online_count, a.company_name, b.company_name));
    finalBuckets.push({
      object_id: bucket.object_id,
      object_name: bucket.object_name,
      has_map: bucket.has_map,
      online_count: bucketTotal,
      companies,
    });
  }
  finalBuckets.sort((a, b) => compareByCountThenName(a.online_count, b.online_count, a.object_name, b.object_name));

  // При scoped-доступе считаем total по финальным buckets (без чужих объектов);
  // без скоупа — глобальный счётчик онлайн.
  const totalOnline = allowedSet
    ? finalBuckets.reduce((sum, bucket) => sum + bucket.online_count, 0)
    : onlineEmployees.length + onlineUnsynced.length;
  const response: IPresenceByObjectResponse = {
    generated_at: new Date().toISOString(),
    total_online: totalOnline,
    buckets: finalBuckets,
  };

  return response;
}
