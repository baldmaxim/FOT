import { supabase } from '../config/database.js';
import type { AuthenticatedRequest } from '../types/index.js';
import type { DataScope } from '../config/access-control.js';
import { resolveRoleDataScope } from './access-control.service.js';

export async function resolveRequestDataScope(req: AuthenticatedRequest): Promise<DataScope | null> {
  if (req.user.position_type === 'super_admin') {
    return 'all';
  }
  return resolveRoleDataScope(req.user.system_role_id ?? req.user.position_type);
}

export async function canAccessEmployeeInScope(
  req: AuthenticatedRequest,
  employeeId: number | null | undefined,
): Promise<boolean> {
  if (!employeeId) {
    return false;
  }

  const scope = await resolveRequestDataScope(req);
  if (!scope) {
    return false;
  }

  if (scope === 'all') {
    return true;
  }

  if (scope === 'self') {
    return req.user.employee_id === employeeId;
  }

  if (!req.user.department_id) {
    return false;
  }

  const { data, error } = await supabase
    .from('employees')
    .select('org_department_id')
    .eq('id', employeeId)
    .single();

  if (error || !data) {
    return false;
  }

  return data.org_department_id === req.user.department_id;
}

export async function resolveScopedDepartmentId(
  req: AuthenticatedRequest,
  requestedDepartmentId?: string | null,
): Promise<string | null> {
  const scope = await resolveRequestDataScope(req);
  if (!scope) {
    return null;
  }

  if (scope === 'all') {
    return requestedDepartmentId ?? null;
  }

  if (scope === 'department') {
    return req.user.department_id ?? null;
  }

  return null;
}
