/**
 * Резолвер компании для unsynced СКУД-проходов: physical_person → корневой
 * sigur-департамент (компания). Тянет полный список Sigur employees и
 * departments один раз в 10 минут, держит in-memory индексы.
 *
 * Стратегия деградации: если Sigur не настроен или fetch упал, возвращаем
 * пустые мапы — вызывающий код кладёт unsynced людей в bucket «Без компании».
 */
import { sigurService } from './sigur.service.js';

const RESOLVER_CACHE_TTL_MS = 10 * 60_000;

export interface ISigurCompanyResolution {
  sigur_department_id: number;
  name: string;
}

interface ICachedResolver {
  /** Map<lowercase(name), root sigur department id> */
  nameToRootDeptId: Map<string, number>;
  /** Map<root sigur department id, { sigur_department_id, name }> */
  rootMeta: Map<number, ISigurCompanyResolution>;
  expiresAt: number;
}

let cache: ICachedResolver | null = null;
let inflight: Promise<ICachedResolver> | null = null;

function normalizeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

function pickNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function pickString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

async function loadDepartmentsTree(): Promise<Map<number, { id: number; parentId: number | null; name: string }>> {
  const raw = await sigurService.getDepartmentsCached();
  const map = new Map<number, { id: number; parentId: number | null; name: string }>();
  for (const item of raw || []) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const id = pickNumber(row.id);
    if (id == null) continue;
    const parentId = pickNumber(row.parentId ?? row.parent_id ?? row.parent);
    const name = pickString(row.name) || '';
    map.set(id, { id, parentId, name });
  }
  return map;
}

async function loadAllSigurEmployees(): Promise<Array<{ name: string; departmentId: number | null }>> {
  const raw = await sigurService.fetchAllPaginated<Record<string, unknown>>(
    '/api/v1/employees',
    { excludeFields: 'photo' },
  );
  const result: Array<{ name: string; departmentId: number | null }> = [];
  for (const row of raw || []) {
    const name = pickString(row?.name);
    if (!name) continue;
    const departmentId = pickNumber(row?.departmentId ?? row?.department_id);
    result.push({ name, departmentId });
  }
  return result;
}

function resolveRootDepartmentId(
  deptId: number | null,
  tree: Map<number, { id: number; parentId: number | null; name: string }>,
): number | null {
  if (deptId == null) return null;
  let currentId: number | null = deptId;
  const visited = new Set<number>();
  while (currentId != null) {
    if (visited.has(currentId)) return null;
    visited.add(currentId);
    const node = tree.get(currentId);
    if (!node) return null;
    if (node.parentId == null) return node.id;
    currentId = node.parentId;
  }
  return null;
}

async function buildResolver(): Promise<ICachedResolver> {
  const isConfigured = await sigurService.isConfigured();
  if (!isConfigured) {
    return {
      nameToRootDeptId: new Map(),
      rootMeta: new Map(),
      expiresAt: Date.now() + RESOLVER_CACHE_TTL_MS,
    };
  }

  let tree: Map<number, { id: number; parentId: number | null; name: string }>;
  let employees: Array<{ name: string; departmentId: number | null }>;
  try {
    [tree, employees] = await Promise.all([
      loadDepartmentsTree(),
      loadAllSigurEmployees(),
    ]);
  } catch (error) {
    console.warn('[sigur-presence-resolver] failed to load Sigur data, falling back to empty maps:', (error as Error).message);
    return {
      nameToRootDeptId: new Map(),
      rootMeta: new Map(),
      expiresAt: Date.now() + RESOLVER_CACHE_TTL_MS,
    };
  }

  const nameToRootDeptId = new Map<string, number>();
  const rootMeta = new Map<number, ISigurCompanyResolution>();

  for (const employee of employees) {
    const normalized = normalizeName(employee.name);
    if (!normalized) continue;
    const rootId = resolveRootDepartmentId(employee.departmentId, tree);
    if (rootId == null) continue;

    // First-wins: один человек может встречаться многократно (history) —
    // берём первое попадание, остальные игнорируем.
    if (!nameToRootDeptId.has(normalized)) {
      nameToRootDeptId.set(normalized, rootId);
    }
    if (!rootMeta.has(rootId)) {
      const node = tree.get(rootId);
      rootMeta.set(rootId, { sigur_department_id: rootId, name: node?.name || '' });
    }
  }

  return {
    nameToRootDeptId,
    rootMeta,
    expiresAt: Date.now() + RESOLVER_CACHE_TTL_MS,
  };
}

async function getResolver(): Promise<ICachedResolver> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache;
  if (inflight) return inflight;
  inflight = buildResolver()
    .then(resolver => {
      cache = resolver;
      return resolver;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function invalidateSigurPresenceResolverCache(): void {
  cache = null;
}

/**
 * Резолвит physical_person из СКУД-события в корневой sigur-департамент
 * (= «компанию»). Возвращает null если человек не найден в Sigur, Sigur
 * не настроен или fetch упал.
 */
export async function resolveSigurCompanyByPhysicalPerson(
  physicalPerson: string,
): Promise<ISigurCompanyResolution | null> {
  const normalized = normalizeName(physicalPerson);
  if (!normalized) return null;
  const resolver = await getResolver();
  const rootId = resolver.nameToRootDeptId.get(normalized);
  if (rootId == null) return null;
  return resolver.rootMeta.get(rootId) ?? null;
}

/** Bulk-резолв для массива physical_person за один вызов — share-cache. */
export async function resolveSigurCompaniesByNames(
  names: string[],
): Promise<Map<string, ISigurCompanyResolution>> {
  const result = new Map<string, ISigurCompanyResolution>();
  if (names.length === 0) return result;
  const resolver = await getResolver();
  for (const name of names) {
    const normalized = normalizeName(name);
    if (!normalized) continue;
    if (result.has(normalized)) continue;
    const rootId = resolver.nameToRootDeptId.get(normalized);
    if (rootId == null) continue;
    const meta = resolver.rootMeta.get(rootId);
    if (meta) result.set(normalized, meta);
  }
  return result;
}
