import type { AuthenticatedRequest } from '../types/index.js';
import { supabase } from '../config/database.js';
import { listExplicitDepartmentIdsForUser, loadEmployeeAccessMap } from './department-access.service.js';

export type DataScope = 'self' | 'department' | 'all';

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

  const { data, error } = await supabase
    .from('user_company_access')
    .select('company_root_id')
    .eq('user_id', req.user.id);

  if (error) {
    console.error('[resolveCompanyScope] failed to load user_company_access', error);
    req.user.company_scope = { roots: 'all' };
    return req.user.company_scope;
  }

  const roots = (data || []).map(row => row.company_root_id as string);
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

    const { data, error } = await supabase
      .rpc('get_descendant_department_ids', { p_root_ids: scope.roots });

    if (error) {
      console.error('[resolveAccessibleDepartmentIds] RPC failed', error);
      return [];
    }

    const ids = ((data || []) as { id: string }[]).map(r => r.id);
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
  if (!departmentId) return false;
  const accessible = await resolveAccessibleDepartmentIds(req);
  if (accessible === 'all') return true;
  return accessible.includes(departmentId);
}

export async function resolveScopedDepartmentId(
  req: AuthenticatedRequest,
  requestedDepartmentId?: string | null,
): Promise<string | null> {
  const accessible = await resolveAccessibleDepartmentIds(req);
  if (accessible === 'all') return requestedDepartmentId ?? null;
  if (accessible.length === 0) return null;

  if (requestedDepartmentId) {
    return accessible.includes(requestedDepartmentId) ? requestedDepartmentId : null;
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

  if (accessible === 'all') {
    return [...new Set((requestedDepartmentIds || []).filter(Boolean))];
  }

  if (!requestedDepartmentIds?.length) {
    return accessible;
  }
  return requestedDepartmentIds.filter(id => accessible.includes(id));
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
