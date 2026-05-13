/**
 * СКУД: агрегация присутствия по физическим объектам (travel_objects) и компаниям
 * (прямым детям корневого узла «Объект»). Используется страницей `/skud-presence`.
 */
import { getPresence } from './skud-presence.service.js';
import { listTravelObjects } from './skud-travel.service.js';
import { getCompanyResolveIndex } from './skud-shared.service.js';
import { query } from '../config/postgres.js';

export const NO_OBJECT_BUCKET_ID = '__no_object__';
export const NO_COMPANY_ID = '__no_company__';

export interface IPresenceObjectEmployee {
  employee_id: number;
  full_name: string;
  position_name: string | null;
  first_entry: string | null;
  last_access_point: string | null;
  since: string | null;
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
let cache: { data: IPresenceByObjectResponse; expiresAt: number } | null = null;

export function invalidatePresenceByObjectCache(): void {
  cache = null;
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

export async function getPresenceByObject(): Promise<IPresenceByObjectResponse> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.data;

  const [presence, travelObjects, companyIndex] = await Promise.all([
    getPresence({ departmentId: null }),
    listTravelObjects(),
    getCompanyResolveIndex(),
  ]);

  // Map access_point_name → travel_object_id.
  // Имя одной access-point может быть привязано только к одному travel_object —
  // это контракт `skud_travel_object_access_points`, но защищаемся first-wins.
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

  // Подгружаем org_department_id для всех online-сотрудников одним SELECT'ом.
  // getPresence уже фильтрует по department, но employees присутствия отдают
  // только department_name — не id. Чтобы резолвить «компанию», нужен id.
  const onlineEmployees = presence.filter(p => p.status === 'online');
  const onlineIds = onlineEmployees.map(p => p.employee_id);

  const orgByEmpId = new Map<number, string | null>();
  if (onlineIds.length > 0) {
    const rows = await query<{ id: number; org_department_id: string | null }>(
      'SELECT id, org_department_id FROM employees WHERE id = ANY($1::bigint[])',
      [onlineIds],
    );
    for (const row of rows) {
      orgByEmpId.set(row.id, row.org_department_id);
    }
  }

  // Аккумулятор: bucketId → companyId → bucket/company entries.
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
        bucket = {
          object_id: null,
          object_name: 'Без объекта',
          has_map: false,
          companies: new Map(),
        };
        buckets.set(NO_OBJECT_BUCKET_ID, bucket);
      }
      return bucket;
    }
    let bucket = buckets.get(objectId);
    if (!bucket) {
      const meta = objectMeta.get(objectId);
      bucket = {
        object_id: objectId,
        object_name: meta?.name || '—',
        has_map: meta?.has_map ?? false,
        companies: new Map(),
      };
      buckets.set(objectId, bucket);
    }
    return bucket;
  };

  const ensureCompany = (bucket: BucketAcc, companyId: string, companyName: string): CompanyAcc => {
    let company = bucket.companies.get(companyId);
    if (!company) {
      company = {
        company_id: companyId,
        company_name: companyName,
        online_count: 0,
        employees: [],
      };
      bucket.companies.set(companyId, company);
    }
    return company;
  };

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

    const company = ensureCompany(bucket, companyId, companyName);
    company.employees.push({
      employee_id: emp.employee_id,
      full_name: emp.full_name,
      position_name: emp.position_name,
      first_entry: emp.first_entry,
      last_access_point: emp.last_access_point,
      since: emp.since,
    });
    company.online_count += 1;
  }

  // Финализация: считаем агрегаты, сортируем, выгружаем в массивы.
  const finalBuckets: IPresenceObjectBucket[] = [];
  for (const bucket of buckets.values()) {
    const companies: IPresenceObjectCompany[] = [];
    let bucketTotal = 0;
    for (const company of bucket.companies.values()) {
      company.employees.sort(compareEmployees);
      bucketTotal += company.online_count;
      companies.push(company);
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

  const totalOnline = onlineEmployees.length;
  const response: IPresenceByObjectResponse = {
    generated_at: new Date().toISOString(),
    total_online: totalOnline,
    buckets: finalBuckets,
  };

  cache = { data: response, expiresAt: Date.now() + CACHE_TTL_MS };
  return response;
}
