import { query } from '../config/postgres.js';
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
  system_role_id: string;
}

interface IRoleAccessSnapshot {
  role_code: string;
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

export async function ensureCriticalAdminAccess(mutation: ICriticalAccessMutation = {}): Promise<void> {
  let roles: IRoleSnapshot[];
  let users: IUserSnapshot[];
  let accessRows: IRoleAccessSnapshot[];
  try {
    [roles, users, accessRows] = await Promise.all([
      query<IRoleSnapshot>('SELECT id, code, is_active FROM system_roles'),
      query<IUserSnapshot>('SELECT id, is_approved, system_role_id FROM user_profiles'),
      query<IRoleAccessSnapshot>('SELECT role_code, page_path, can_view, can_edit FROM role_page_access'),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load access invariant snapshot: ${message}`);
  }

  const rolesByCode = new Map<string, IRoleSnapshot>(roles.map(role => [role.code, role]));
  const roleCodeById = new Map<string, string>(roles.map(role => [role.id, role.code]));
  const roleActive = new Map<string, boolean>();
  const roleAccess = new Map<string, Map<string, AccessMode>>();

  for (const role of roles) {
    roleActive.set(role.code, !!role.is_active);
    roleAccess.set(role.code, new Map());
  }

  for (const row of accessRows) {
    const roleCode = row.role_code;
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

  const hasCoverage = users.some((user) => {
    if (!user.is_approved || removedUserIds.has(user.id)) return false;

    const overriddenRoleCode = mutation.userRoleById?.[user.id];
    const roleCode = overriddenRoleCode === undefined
      ? roleCodeById.get(user.system_role_id) ?? null
      : overriddenRoleCode;

    if (!roleCode) return false;
    if (!roleActive.get(roleCode)) return false;

    const pageModes = roleAccess.get(roleCode);
    if (!pageModes) return false;

    return CRITICAL_ADMIN_PAGE_KEYS.every(pageKey => pageModes.get(pageKey) === 'edit');
  });

  if (!hasCoverage) {
    throw new Error('В системе должен остаться хотя бы один одобренный пользователь с правом изменения ролей и пользователей');
  }
}
