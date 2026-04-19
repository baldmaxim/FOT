import { supabase } from '../config/database.js';
import { getRolePageAccess } from './access-control.service.js';
import { loadManagedDepartmentMap } from './department-access.service.js';
import { getRoleById } from './roles-cache.service.js';

type WorkflowRecipientKind = 'submit' | 'review' | 'monitor';

interface IUserProfileLite {
  id: string;
  system_role_id: string;
  employee_id: number | null;
}

interface IRoleWorkflowAccess {
  roleCode: string;
  isAdmin: boolean;
  page_access: Record<string, { can_view: boolean; can_edit: boolean }>;
}

// Какие страницы участвуют в workflow. Право на workflow выводится из can_view/can_edit.
const WORKFLOW_RULES: Record<WorkflowRecipientKind, {
  pagePath: string;
  requiresEdit: boolean;
}> = {
  submit:  { pagePath: '/timesheet',    requiresEdit: true  },
  review:  { pagePath: '/timesheet-hr', requiresEdit: true  },
  monitor: { pagePath: '/timesheet-hr', requiresEdit: false },
};

function roleMatchesWorkflowKind(access: IRoleWorkflowAccess, kind: WorkflowRecipientKind): boolean {
  const rule = WORKFLOW_RULES[kind];
  const pageAccess = access.page_access[rule.pagePath];
  if (!pageAccess) return false;
  return rule.requiresEdit ? !!pageAccess.can_edit : (!!pageAccess.can_view || !!pageAccess.can_edit);
}

async function loadDepartmentByEmployeeId(employeeIds: number[]): Promise<Map<number, string | null>> {
  if (employeeIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from('employees')
    .select('id, org_department_id')
    .in('id', employeeIds);

  if (error) throw error;

  return new Map((data || []).map(e => [e.id as number, (e.org_department_id as string | null) ?? null]));
}

async function loadRoleWorkflowAccess(roleIds: string[]): Promise<Map<string, IRoleWorkflowAccess>> {
  const unique = [...new Set(roleIds.filter(Boolean))];
  const entries = await Promise.all(unique.map(async (roleId) => {
    const role = await getRoleById(roleId);
    if (!role) {
      return [roleId, { roleCode: roleId, isAdmin: false, page_access: {} }] as const;
    }
    const page_access = await getRolePageAccess(roleId);
    return [roleId, { roleCode: role.code, isAdmin: !!role.is_admin, page_access }] as const;
  }));

  return new Map(entries);
}

export async function listTimesheetWorkflowRecipientIds(
  departmentId: string,
  kinds: WorkflowRecipientKind[],
  options?: {
    excludeRoleCodes?: string[];
    adminOnly?: boolean;
  },
): Promise<string[]> {
  if (!departmentId || kinds.length === 0) return [];

  const excludedRoleCodes = new Set(
    (options?.excludeRoleCodes || []).map(code => code.trim()).filter(Boolean),
  );

  const { data, error } = await supabase
    .from('user_profiles')
    .select('id, system_role_id, employee_id')
    .eq('is_approved', true);

  if (error) throw error;

  const profiles = (data || []) as IUserProfileLite[];
  if (profiles.length === 0) return [];

  const departmentByEmployeeId = await loadDepartmentByEmployeeId(
    profiles
      .map(p => p.employee_id)
      .filter((id): id is number => Number.isInteger(id)),
  );

  const managedDepartmentMap = await loadManagedDepartmentMap(
    profiles.map(p => ({
      user_id: p.id,
      employee_id: p.employee_id,
      primary_department_id: p.employee_id != null
        ? (departmentByEmployeeId.get(p.employee_id) ?? null)
        : null,
    })),
  );

  const roleAccessById = await loadRoleWorkflowAccess(
    profiles.map(p => p.system_role_id).filter((id): id is string => typeof id === 'string' && id.length > 0),
  );

  const recipients = new Set<string>();

  for (const profile of profiles) {
    const roleAccess = roleAccessById.get(profile.system_role_id);
    if (!roleAccess) continue;
    if (excludedRoleCodes.has(roleAccess.roleCode)) continue;
    if (options?.adminOnly && !roleAccess.isAdmin) continue;

    if (!kinds.some(kind => roleMatchesWorkflowKind(roleAccess, kind))) continue;

    if (roleAccess.isAdmin) {
      recipients.add(profile.id);
      continue;
    }

    const managedDepartmentIds = managedDepartmentMap.get(profile.id)?.managed_department_ids || [];
    if (managedDepartmentIds.includes(departmentId)) {
      recipients.add(profile.id);
    }
  }

  return [...recipients];
}
