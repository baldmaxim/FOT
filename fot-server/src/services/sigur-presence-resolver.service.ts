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
import { normalizeMatchName, nameMatchPrefix } from './name-match.utils.js';

// Re-export для обратной совместимости с прежними импортами (skud-presence-by-object и тесты).
export { normalizeMatchName };

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
  /** Prefix-индекс (lastname + firstname). null = коллизия, не используем. */
  byPrefix: Map<string, ISigurEmployeeResolution | null>;
  /** Индекс по sigur_employee_id для резолва synced сотрудников. */
  byEmployeeId: Map<number, ISigurEmployeeResolution>;
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

async function loadAllSigurEmployees(): Promise<Array<{ id: number | null; name: string; departmentId: number | null }>> {
  const raw = await sigurService.fetchAllPaginated<Record<string, unknown>>(
    '/api/v1/employees',
    { excludeFields: 'photo' },
  );

  if (raw && raw.length > 0) {
    // Разовый sample-лог при rebuild кэша — помогает диагностировать, в каких полях
    // Sigur отдаёт ФИО (name / NAME / fullName / lastName+firstName+middleName / ...).
    logSampleAndWarn('sigur-presence-resolver', raw[0], ['id', 'name', 'departmentId']);
  }

  const result: Array<{ id: number | null; name: string; departmentId: number | null }> = [];
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
    const employeeId = pickNumber(rec.id ?? rec.ID ?? rec.Id);
    result.push({ id: employeeId, name: fullName, departmentId });
  }
  console.log(
    `[sigur-presence-resolver] employees fetched=${raw?.length ?? 0} usable=${result.length} skipped_no_name=${skippedNoName} skipped_no_dept=${skippedNoDept}`,
  );
  if (result.length > 0) {
    console.log(
      '[sigur-presence-resolver] sample names:',
      result.slice(0, 10).map(e => `"${e.name}" → dept ${e.departmentId}`),
    );
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
    return { byName: new Map(), byPrefix: new Map(), byEmployeeId: new Map(), expiresAt: Date.now() + RESOLVER_CACHE_TTL_MS };
  }

  let tree: Map<number, { id: number; parentId: number | null; name: string }>;
  let employees: Array<{ id: number | null; name: string; departmentId: number | null }>;
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
    return { byName: new Map(), byPrefix: new Map(), byEmployeeId: new Map(), expiresAt: Date.now() + RESOLVER_CACHE_TTL_MS };
  }

  const byName = new Map<string, ISigurEmployeeResolution>();
  const byPrefix = new Map<string, ISigurEmployeeResolution | null>();
  const byEmployeeId = new Map<number, ISigurEmployeeResolution>();

  for (const employee of employees) {
    if (!employee.name) continue;
    if (employee.departmentId == null) continue;
    const normalized = normalizeMatchName(employee.name);
    if (!normalized) continue;
    const deptNode = tree.get(employee.departmentId);
    if (!deptNode) continue;
    const root = resolveRootNode(employee.departmentId, tree);
    if (!root) continue;

    const resolution: ISigurEmployeeResolution = {
      root: { sigur_department_id: root.id, name: root.name },
      department: { sigur_department_id: deptNode.id, name: deptNode.name },
    };

    // First-wins по полному ФИО.
    if (!byName.has(normalized)) {
      byName.set(normalized, resolution);
    }

    // First-wins по sigur_employee_id — для синхронизированных сотрудников из БД.
    if (employee.id != null && !byEmployeeId.has(employee.id)) {
      byEmployeeId.set(employee.id, resolution);
    }

    // Prefix-индекс с защитой от коллизий: если уже есть запись с этим prefix
    // и она ссылается на другого человека (другой department), помечаем null —
    // нельзя резолвить, чтобы не приписать чужого.
    const prefix = nameMatchPrefix(normalized);
    if (prefix) {
      const existing = byPrefix.get(prefix);
      if (existing === undefined) {
        byPrefix.set(prefix, resolution);
      } else if (existing !== null) {
        const sameRoot = existing.root.sigur_department_id === resolution.root.sigur_department_id
          && existing.department.sigur_department_id === resolution.department.sigur_department_id;
        if (!sameRoot) {
          byPrefix.set(prefix, null);
        }
      }
    }
  }

  const usablePrefixes = [...byPrefix.values()].filter(v => v !== null).length;
  console.log(
    `[sigur-presence-resolver] indexed ${byName.size} unique full names, ${usablePrefixes}/${byPrefix.size} usable prefix keys, ${byEmployeeId.size} by employee id`,
  );
  if (byName.size > 0) {
    console.log(
      '[sigur-presence-resolver] sample index keys:',
      [...byName.keys()].slice(0, 10),
    );
  }
  return { byName, byPrefix, byEmployeeId, expiresAt: Date.now() + RESOLVER_CACHE_TTL_MS };
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
 * Возвращает Map по нормализованному имени.
 *
 * Алгоритм lookup:
 * 1. Точное совпадение по полному ФИО (`byName`).
 * 2. Fallback по prefix (lastname + firstname) — если в `byPrefix` уникальный матч.
 *    При коллизии (null в индексе) — не резолвим, чтобы не приписать чужого.
 */
export async function resolveSigurEmployeesByNames(
  names: string[],
): Promise<Map<string, ISigurEmployeeResolution>> {
  const result = new Map<string, ISigurEmployeeResolution>();
  if (names.length === 0) return result;
  const resolver = await getResolver();
  const unresolvedSample: Array<{ raw: string; normalized: string }> = [];

  for (const name of names) {
    if (!name) continue;
    const normalized = normalizeMatchName(name);
    if (!normalized) continue;
    if (result.has(normalized)) continue;

    const exact = resolver.byName.get(normalized);
    if (exact) {
      result.set(normalized, exact);
      continue;
    }

    const prefix = nameMatchPrefix(normalized);
    if (prefix) {
      const byPrefix = resolver.byPrefix.get(prefix);
      if (byPrefix) {
        result.set(normalized, byPrefix);
        continue;
      }
    }

    if (unresolvedSample.length < 10) {
      unresolvedSample.push({ raw: name, normalized });
    }
  }

  const unresolvedCount = names.length - result.size;
  if (unresolvedCount > 0) {
    console.log(
      `[sigur-presence-resolver] resolved ${result.size}/${names.length} (index size=${resolver.byName.size}, prefix size=${resolver.byPrefix.size}, unresolved=${unresolvedCount})`,
    );
    if (unresolvedSample.length > 0) {
      console.log('[sigur-presence-resolver] unresolved sample (raw → normalized):', unresolvedSample);
    }
  }
  return result;
}

/**
 * Bulk-резолв по sigur_employee_id (для synced сотрудников из БД).
 * Делит общий кэш с `resolveSigurEmployeesByNames` — один fetch на 10 минут.
 */
export async function resolveSigurEmployeesByIds(
  ids: number[],
): Promise<Map<number, ISigurEmployeeResolution>> {
  const result = new Map<number, ISigurEmployeeResolution>();
  if (ids.length === 0) return result;
  const resolver = await getResolver();
  for (const id of ids) {
    if (id == null || !Number.isFinite(id)) continue;
    if (result.has(id)) continue;
    const match = resolver.byEmployeeId.get(id);
    if (match) result.set(id, match);
  }
  return result;
}
