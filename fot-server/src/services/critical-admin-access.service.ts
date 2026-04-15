import { supabase } from '../config/database.js';
import {
  CRITICAL_ADMIN_PAGE_KEYS,
  accessModeFromFlags,
  type AccessMode,
} from '../config/access-control.js';

interface IRoleSnapshot {
  id: string;
  code: string;
  is_active: boolean;
}

interface IUserSnapshot {
  id: string;
  is_approved: boolean;
  position_type: string;
  system_role_id: string | null;
}

interface IRoleAccessSnapshot {
  role_code: string;
  system_role_id: string | null;
  page_path: string;
  can_view: boolean;
  can_edit: boolean;
}

interface ICriticalAccessMutation {
  roleActiveByCode?: Record<string, boolean>;
  rolePageAccessByCode?: Record<string, Record<string, AccessMode>>;
  removedRoleCodes?: string[];
  userRoleById?: Record<string, string | null>;
  removedUserIds?: string[];
}

function resolveUserRoleCode(user: IUserSnapshot, roleCodeById: Map<string, string>): string {
  if (user.system_role_id) {
    return roleCodeById.get(user.system_role_id) ?? user.position_type;
  }

  return user.position_type;
}

export async function ensureCriticalAdminAccess(mutation: ICriticalAccessMutation = {}): Promise<void> {
  const [{ data: roles, error: rolesError }, { data: users, error: usersError }, { data: accessRows, error: accessError }] = await Promise.all([
    supabase.from('system_roles').select('id, code, is_active'),
    supabase.from('user_profiles').select('id, is_approved, position_type, system_role_id'),
    supabase.from('role_page_access').select('role_code, system_role_id, page_path, can_view, can_edit'),
  ]);

  if (rolesError) {
    throw new Error(`Failed to load roles for access invariant: ${rolesError.message}`);
  }

  if (usersError) {
    throw new Error(`Failed to load users for access invariant: ${usersError.message}`);
  }

  if (accessError) {
    throw new Error(`Failed to load role page access for invariant: ${accessError.message}`);
  }

  const rolesByCode = new Map<string, IRoleSnapshot>((roles || []).map((role) => [role.code, role as IRoleSnapshot]));
  const roleCodeById = new Map<string, string>((roles || []).map((role) => [role.id, role.code]));
  const roleActive = new Map<string, boolean>();
  const roleAccess = new Map<string, Map<string, AccessMode>>();

  for (const role of roles || []) {
    roleActive.set(role.code, !!role.is_active);
    roleAccess.set(role.code, new Map());
  }

  for (const row of (accessRows || []) as IRoleAccessSnapshot[]) {
    const roleCode = row.role_code || (row.system_role_id ? roleCodeById.get(row.system_role_id) : null);
    if (!roleCode) continue;

    if (!roleAccess.has(roleCode)) {
      roleAccess.set(roleCode, new Map());
    }

    roleAccess.get(roleCode)!.set(row.page_path, accessModeFromFlags(row));
  }

  for (const removedRoleCode of mutation.removedRoleCodes || []) {
    roleActive.delete(removedRoleCode);
    roleAccess.delete(removedRoleCode);
    rolesByCode.delete(removedRoleCode);
  }

  for (const [roleCode, nextActive] of Object.entries(mutation.roleActiveByCode || {})) {
    roleActive.set(roleCode, nextActive);
  }

  for (const [roleCode, nextPageAccess] of Object.entries(mutation.rolePageAccessByCode || {})) {
    const map = new Map<string, AccessMode>();

    for (const [pageKey, mode] of Object.entries(nextPageAccess)) {
      if (mode === 'none') continue;
      map.set(pageKey, mode);
    }

    roleAccess.set(roleCode, map);
  }

  const removedUserIds = new Set(mutation.removedUserIds || []);

  const hasCoverage = (users || []).some((rawUser) => {
    const user = rawUser as IUserSnapshot;
    if (!user.is_approved || removedUserIds.has(user.id)) {
      return false;
    }

    const overriddenRoleCode = mutation.userRoleById?.[user.id];
    const roleCode = overriddenRoleCode === undefined
      ? resolveUserRoleCode(user, roleCodeById)
      : overriddenRoleCode;

    if (!roleCode) {
      return false;
    }

    if (!roleActive.get(roleCode)) {
      return false;
    }

    const pageModes = roleAccess.get(roleCode);
    if (!pageModes) {
      return false;
    }

    return CRITICAL_ADMIN_PAGE_KEYS.every((pageKey) => pageModes.get(pageKey) === 'edit');
  });

  if (!hasCoverage) {
    throw new Error('В системе должен остаться хотя бы один одобренный пользователь с правом изменения ролей и пользователей');
  }
}
