import * as Sentry from '@sentry/node';
import type { AuthenticatedRequest } from '../types/index.js';
import { query } from '../config/postgres.js';
import { withDbSlot } from '../config/db-instrumentation.js';
import { listExplicitDepartmentIdsForUser, loadEmployeeAccessMap } from './department-access.service.js';

export type DataScope = 'self' | 'department' | 'all';

const SCOPE_RPC_TIMEOUT_MS = 5000;
const SCOPE_CACHE_TTL_MS = 10 * 60_000;
const subtreeCache = new Map<string, { ids: string[]; expiresAt: number }>();

/**
 * Сбрасывает module-кеш resolveAccessibleDepartmentIds после CRUD структуры.
 * Вызывается из write-through хука в structure.routes.ts.
 */
export function invalidateAccessibleScopeCache(): void {
  subtreeCache.clear();
}

/**
 * Нормализует UUID-параметр из query/body: фронт иногда сериализует null/undefined
 * как строку "null"/"undefined" в URL (?department_id=null), и попадание такой
 * строки в supabase.eq('department_id', value) даёт PG ошибку
 * `invalid input syntax for type uuid: "null"`. Возвращает null для всех таких
 * мусорных значений.
 */
export function normalizeUuidParam(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === 'undefined') return null;
  return trimmed;
}

/**
 * Скоуп компаний для админа.
 * - 'all'      — системный админ (нет записей в user_company_access).
 * - []         — обычный (не is_admin) пользователь.
 * - [id, ...]  — админ компании; видит только перечисленные корни и их потомков.
 *
 * Загружается lazy один раз на запрос и кешируется в req.user.company_scope.
 */
export async function resolveCompanyScope(req: AuthenticatedRequest): Promise<{ roots: 'all' | string[] }> {
  if (req.user.company_scope) return req.user.company_scope;

  if (!req.user.is_admin) {
    req.user.company_scope = { roots: [] };
    return req.user.company_scope;
  }

  let rows: { company_root_id: string }[];
  try {
    rows = await query<{ company_root_id: string }>(
      'SELECT company_root_id FROM user_company_access WHERE user_id = $1::uuid',
      [req.user.id],
    );
  } catch (error) {
    console.error('[resolveCompanyScope] failed to load user_company_access', error);
    req.user.company_scope = { roots: 'all' };
    return req.user.company_scope;
  }

  const roots = rows.map(row => row.company_root_id);
  req.user.company_scope = { roots: roots.length === 0 ? 'all' : roots };
  return req.user.company_scope;
}

/**
 * Для совместимости со старым кодом: возвращает 'all' для админа без company-scope,
 * 'department' если есть назначенные отделы, иначе 'self'.
 * В новом коде используйте resolveAccessibleDepartmentIds напрямую.
 */
export async function resolveRequestDataScope(req: AuthenticatedRequest): Promise<DataScope> {
  const accessible = await resolveAccessibleDepartmentIds(req);
  if (accessible === 'all') return 'all';
  return accessible.length > 0 ? 'department' : 'self';
}

/**
 * Возвращает id отделов, к которым пользователь имеет доступ.
 * - is_admin БЕЗ записей в user_company_access → 'all' (полный доступ).
 * - is_admin С записями → плоский список потомков назначенных корней (включая сами корни).
 * - manager → только явно назначенные через employee_department_access.
 *   Пустой массив → только свои /employee/*.
 */
export async function resolveAccessibleDepartmentIds(
  req: AuthenticatedRequest,
): Promise<string[] | 'all'> {
  if (req.user.is_admin) {
    const scope = await resolveCompanyScope(req);
    if (scope.roots === 'all') return 'all';
    if (scope.roots.length === 0) return [];
    if (req.user.__company_subtree_ids) return req.user.__company_subtree_ids;

    const cacheKey = scope.roots.slice().sort().join(',');
    const cached = subtreeCache.get(cacheKey);
    if (cached && Date.now() <= cached.expiresAt) {
      req.user.__company_subtree_ids = cached.ids;
      return cached.ids;
    }

    type RpcResult = { data: { id: string }[] | null; error: { message: string } | null };
    const rpcPromise: Promise<RpcResult> = withDbSlot('get_descendant_department_ids', async () => {
      try {
        const rows = await query<{ id: string }>(
          'SELECT id FROM public.get_descendant_department_ids($1::uuid[])',
          [scope.roots],
        );
        return { data: rows, error: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { data: null, error: { message } };
      }
    });
    const timeoutPromise = new Promise<RpcResult>((resolve) => {
      setTimeout(() => resolve({ data: null, error: { message: 'rpc_timeout' } }), SCOPE_RPC_TIMEOUT_MS);
    });
    const result = await Promise.race([rpcPromise, timeoutPromise]);

    if (result.error || !result.data) {
      Sentry.captureMessage('rpc_timeout', {
        level: 'warning',
        tags: { rpc: 'get_descendant_department_ids' },
        extra: {
          error: result.error?.message ?? 'unknown',
          roots: scope.roots,
          fallback: cached ? 'stale_cache' : 'throw',
        },
      });
      if (cached) {
        // Stale-fallback: лучше отдать чуть устаревший scope, чем отрубить пользователю доступ.
        req.user.__company_subtree_ids = cached.ids;
        return cached.ids;
      }
      // Без cached'а возвращать [] нельзя: filterTreeByScope обрежет всё дерево,
      // controller вернёт 200 OK с empty departments, cacheResponse это закеширует
      // на 15 мин и все пользователи получат пустой селектор. Бросаем — controller
      // вернёт 500, кеш не пишется, фронт делает retry.
      throw new Error(`get_descendant_department_ids ${result.error?.message ?? 'failed'}`);
    }

    const ids = (result.data || []).map((r) => r.id);
    if (ids.length > 0) {
      // Не кешируем подозрительный пустой результат: при scope.roots.length > 0
      // RPC должен был включить хотя бы сами roots. Empty ids = аномалия (RPC баг,
      // удалённые отделы и т.п.) — пусть следующий запрос попробует заново.
      subtreeCache.set(cacheKey, { ids, expiresAt: Date.now() + SCOPE_CACHE_TTL_MS });
    }
    req.user.__company_subtree_ids = ids;
    return ids;
  }

  const assigned = await listExplicitDepartmentIdsForUser(req.user.id, req.user.employee_id ?? null);
  return [...new Set(assigned)];
}

export async function canAccessEmployeeInScope(
  req: AuthenticatedRequest,
  employeeId: number | null | undefined,
): Promise<boolean> {
  if (!employeeId) return false;
  if (req.user.employee_id === employeeId) return true;

  const accessible = await resolveAccessibleDepartmentIds(req);
  if (accessible === 'all') return true;
  if (accessible.length === 0) return false;

  const targetAccessMap = await loadEmployeeAccessMap([employeeId]);
  const targetDepartmentIds = targetAccessMap.get(employeeId) || [];
  if (targetDepartmentIds.length === 0) return false;

  const accessibleSet = new Set(accessible);
  return targetDepartmentIds.some(id => accessibleSet.has(id));
}

export async function canAccessDepartmentInScope(
  req: AuthenticatedRequest,
  departmentId: string | null | undefined,
): Promise<boolean> {
  const normalized = normalizeUuidParam(departmentId);
  if (!normalized) return false;
  const accessible = await resolveAccessibleDepartmentIds(req);
  if (accessible === 'all') return true;
  return accessible.includes(normalized);
}

export async function resolveScopedDepartmentId(
  req: AuthenticatedRequest,
  requestedDepartmentId?: string | null,
): Promise<string | null> {
  const requested = normalizeUuidParam(requestedDepartmentId);
  const accessible = await resolveAccessibleDepartmentIds(req);
  if (accessible === 'all') return requested;
  if (accessible.length === 0) return null;

  if (requested) {
    return accessible.includes(requested) ? requested : null;
  }

  if (req.user.department_id && accessible.includes(req.user.department_id)) {
    return req.user.department_id;
  }
  return accessible[0] ?? null;
}

export async function resolveScopedDepartmentIds(
  req: AuthenticatedRequest,
  requestedDepartmentIds?: string[] | null,
): Promise<string[]> {
  const accessible = await resolveAccessibleDepartmentIds(req);
  const normalized = (requestedDepartmentIds || [])
    .map(normalizeUuidParam)
    .filter((id): id is string => id !== null);

  if (accessible === 'all') {
    return [...new Set(normalized)];
  }

  if (normalized.length === 0) {
    return accessible;
  }
  return normalized.filter(id => accessible.includes(id));
}

/**
 * Совместимость со старыми вызовами: для не-админа отдаёт доступные отделы,
 * для системного админа (scope='all') — пустой массив (фильтр не используется).
 * Для админа компании отдаёт список id поддерева, чтобы вызывающий код мог
 * применить фильтрацию вручную.
 */
export async function resolveManagedDepartmentIds(req: AuthenticatedRequest): Promise<string[]> {
  const accessible = await resolveAccessibleDepartmentIds(req);
  if (accessible === 'all') return [];
  return accessible;
}

/**
 * Сотрудник в ЛК видит свои данные (табель, СКУД) только за текущий и прошлый месяц.
 * Возвращает первое число прошлого месяца в формате YYYY-MM-DD (локальное время).
 */
export const SELF_HISTORY_MONTHS_BACK = 1;

export function getMinSelfHistoryDate(): string {
  const now = new Date();
  const min = new Date(now.getFullYear(), now.getMonth() - SELF_HISTORY_MONTHS_BACK, 1);
  return `${min.getFullYear()}-${String(min.getMonth() + 1).padStart(2, '0')}-01`;
}

/** true, если запрос идёт от самого сотрудника (self-request). */
export function isSelfEmployeeRequest(req: AuthenticatedRequest, employeeId: number | null | undefined): boolean {
  return employeeId != null && req.user.employee_id === Number(employeeId);
}
