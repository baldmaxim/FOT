import { supabase } from '../config/database.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { listExplicitDepartmentIdsForUser } from './department-access.service.js';

export type DataScope = 'self' | 'department' | 'all';

/**
 * Для совместимости со старым кодом: возвращает 'all' для админа,
 * 'department' если у пользователя есть назначенные отделы, иначе 'self'.
 * В новом коде используйте resolveAccessibleDepartmentIds напрямую.
 */
export async function resolveRequestDataScope(req: AuthenticatedRequest): Promise<DataScope> {
  if (req.user.is_admin) return 'all';
  const accessible = await resolveAccessibleDepartmentIds(req);
  if (accessible === 'all') return 'all';
  return accessible.length > 0 ? 'department' : 'self';
}

/**
 * Возвращает id отделов, к которым пользователь имеет доступ.
 * - is_admin → 'all' (полный доступ, фильтр по отделам не применяется)
 * - иначе объединение: собственный department_id + назначенные через
 *   employee_department_access. Пустой массив → только свои /employee/*.
 */
export async function resolveAccessibleDepartmentIds(
  req: AuthenticatedRequest,
): Promise<string[] | 'all'> {
  if (req.user.is_admin) {
    return 'all';
  }

  const assigned = await listExplicitDepartmentIdsForUser(req.user.id, req.user.employee_id ?? null);
  const ownDept = req.user.department_id;
  return [...new Set([...(ownDept ? [ownDept] : []), ...assigned])];
}

export async function canAccessEmployeeInScope(
  req: AuthenticatedRequest,
  employeeId: number | null | undefined,
): Promise<boolean> {
  if (!employeeId) return false;
  if (req.user.is_admin) return true;
  if (req.user.employee_id === employeeId) return true;

  const accessible = await resolveAccessibleDepartmentIds(req);
  if (accessible === 'all') return true;
  if (accessible.length === 0) return false;

  const { data, error } = await supabase
    .from('employees')
    .select('org_department_id')
    .eq('id', employeeId)
    .single();

  if (error || !data) return false;
  return accessible.includes((data.org_department_id as string | null) ?? '');
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
 * для админа — пустой массив (у админа фильтр не используется).
 */
export async function resolveManagedDepartmentIds(req: AuthenticatedRequest): Promise<string[]> {
  if (req.user.is_admin) return [];
  const accessible = await resolveAccessibleDepartmentIds(req);
  return accessible === 'all' ? [] : accessible;
}
