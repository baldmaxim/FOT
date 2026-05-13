/**
 * Резолвер компании и непосредственного отдела для unsynced СКУД-проходов:
 * physical_person → { root sigur department (= компания), department (= конкретное
 * подразделение) }. Тянет полный список Sigur employees и departments один раз
 * в 10 минут, держит in-memory индексы.
 *
 * Деградация: если Sigur не настроен или fetch упал, возвращаем пустую мапу —
 * вызывающий код кладёт unsynced людей в bucket «Без компании».
 */
import { sigurService } from './sigur.service.js';

const RESOLVER_CACHE_TTL_MS = 10 * 60_000;

export interface ISigurDeptRef {
  sigur_department_id: number;
  name: string;
}

export interface ISigurEmployeeResolution {
  root: ISigurDeptRef;
  department: ISigurDeptRef;
}

interface ICachedResolver {
  byName: Map<string, ISigurEmployeeResolution>;
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

function resolveRootNode(
  deptId: number,
  tree: Map<number, { id: number; parentId: number | null; name: string }>,
): { id: number; name: string } | null {
  let currentId: number | null = deptId;
  const visited = new Set<number>();
  while (currentId != null) {
    if (visited.has(currentId)) return null;
    visited.add(currentId);
    const node = tree.get(currentId);
    if (!node) return null;
    if (node.parentId == null) return { id: node.id, name: node.name };
    currentId = node.parentId;
  }
  return null;
}

async function buildResolver(): Promise<ICachedResolver> {
  const isConfigured = await sigurService.isConfigured();
  if (!isConfigured) {
    return { byName: new Map(), expiresAt: Date.now() + RESOLVER_CACHE_TTL_MS };
  }

  let tree: Map<number, { id: number; parentId: number | null; name: string }>;
  let employees: Array<{ name: string; departmentId: number | null }>;
  try {
    [tree, employees] = await Promise.all([
      loadDepartmentsTree(),
      loadAllSigurEmployees(),
    ]);
  } catch (error) {
    console.warn(
      '[sigur-presence-resolver] failed to load Sigur data, falling back to empty maps:',
      (error as Error).message,
    );
    return { byName: new Map(), expiresAt: Date.now() + RESOLVER_CACHE_TTL_MS };
  }

  const byName = new Map<string, ISigurEmployeeResolution>();

  for (const employee of employees) {
    const normalized = normalizeName(employee.name);
    if (!normalized) continue;
    if (employee.departmentId == null) continue;
    const deptNode = tree.get(employee.departmentId);
    if (!deptNode) continue;
    const root = resolveRootNode(employee.departmentId, tree);
    if (!root) continue;

    // First-wins: один человек может встречаться многократно — берём первое попадание.
    if (byName.has(normalized)) continue;
    byName.set(normalized, {
      root: { sigur_department_id: root.id, name: root.name },
      department: { sigur_department_id: deptNode.id, name: deptNode.name },
    });
  }

  return { byName, expiresAt: Date.now() + RESOLVER_CACHE_TTL_MS };
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
 * Bulk-резолв для массива physical_person за один вызов — share-cache.
 * Возвращает Map по lowercase-имени.
 */
export async function resolveSigurEmployeesByNames(
  names: string[],
): Promise<Map<string, ISigurEmployeeResolution>> {
  const result = new Map<string, ISigurEmployeeResolution>();
  if (names.length === 0) return result;
  const resolver = await getResolver();
  for (const name of names) {
    const normalized = normalizeName(name);
    if (!normalized) continue;
    if (result.has(normalized)) continue;
    const match = resolver.byName.get(normalized);
    if (match) result.set(normalized, match);
  }
  return result;
}
