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
import { normalizeEmployee, logSampleAndWarn } from './sigur-sync-shared.js';

const RESOLVER_CACHE_TTL_MS = 10 * 60_000;

/** Нормализация ФИО для матчинга: lowercase + trim + collapse spaces + ё→е.
 *  В Sigur events.physical_person и employees.name могут расходиться по ё/е, поэтому
 *  схлопываем их к одному варианту перед сравнением. */
export function normalizeMatchName(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, ' ').replace(/ё/g, 'е');
}

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

/** Fallback-извлечение ФИО склейкой отдельных полей, если в employee нет `name`/`fullName`.
 *  В Sigur у части записей могут лежать раздельно lastName/firstName/middleName. */
function resolveEmployeeFullName(row: Record<string, unknown>): string {
  const norm = normalizeEmployee(row);
  if (norm.name) return norm.name;

  const last = pickString(row.lastName) || pickString(row.last_name) || pickString(row.surname) || pickString(row.familyName);
  const first = pickString(row.firstName) || pickString(row.first_name) || pickString(row.givenName);
  const middle = pickString(row.middleName) || pickString(row.middle_name) || pickString(row.patronymic);
  const parts = [last, first, middle].filter(Boolean);
  return parts.join(' ').trim();
}

async function loadAllSigurEmployees(): Promise<Array<{ name: string; departmentId: number | null }>> {
  const raw = await sigurService.fetchAllPaginated<Record<string, unknown>>(
    '/api/v1/employees',
    { excludeFields: 'photo' },
  );

  if (raw && raw.length > 0) {
    // Разовый sample-лог при rebuild кэша — помогает диагностировать, в каких полях
    // Sigur отдаёт ФИО (name / NAME / fullName / lastName+firstName+middleName / ...).
    logSampleAndWarn('sigur-presence-resolver', raw[0], ['id', 'name', 'departmentId']);
  }

  const result: Array<{ name: string; departmentId: number | null }> = [];
  let skippedNoName = 0;
  let skippedNoDept = 0;
  for (const row of raw || []) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    const fullName = resolveEmployeeFullName(rec);
    if (!fullName) {
      skippedNoName += 1;
      continue;
    }
    const departmentId = pickNumber(
      rec.departmentId ?? rec.department_id ?? rec.DEPARTMENTID ?? rec.DepartmentId,
    );
    if (departmentId == null) {
      skippedNoDept += 1;
      continue;
    }
    result.push({ name: fullName, departmentId });
  }
  console.log(
    `[sigur-presence-resolver] employees fetched=${raw?.length ?? 0} usable=${result.length} skipped_no_name=${skippedNoName} skipped_no_dept=${skippedNoDept}`,
  );
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
    if (!employee.name) continue;
    if (employee.departmentId == null) continue;
    const normalized = normalizeMatchName(employee.name);
    if (!normalized) continue;
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

  console.log(`[sigur-presence-resolver] indexed ${byName.size} unique names`);
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
  let unresolved = 0;
  for (const name of names) {
    if (!name) continue;
    const normalized = normalizeMatchName(name);
    if (!normalized) continue;
    if (result.has(normalized)) continue;
    const match = resolver.byName.get(normalized);
    if (match) {
      result.set(normalized, match);
    } else {
      unresolved += 1;
    }
  }
  if (unresolved > 0) {
    console.log(
      `[sigur-presence-resolver] resolved ${result.size}/${names.length} (index size=${resolver.byName.size}, unresolved=${unresolved})`,
    );
  }
  return result;
}
