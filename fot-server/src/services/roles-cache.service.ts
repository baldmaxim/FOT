import { supabase } from '../config/database.js';
import type { SystemRole } from '../types/index.js';

const ROLES_CACHE_TTL_MS = 300_000;

let rolesCacheById: Map<string, SystemRole> | null = null;
let rolesCacheByCode: Map<string, SystemRole> | null = null;
let rolesCacheExpiresAt = 0;

async function loadRolesCache(): Promise<void> {
  const now = Date.now();
  if (rolesCacheById && rolesCacheByCode && rolesCacheExpiresAt > now) {
    return;
  }

  const { data, error } = await supabase
    .from('system_roles')
    .select('id, code, name, description, is_admin, employee_variant, is_active, created_at, updated_at')
    .eq('is_active', true);

  if (error) {
    throw new Error(`Failed to load roles cache: ${error.message}`);
  }

  const byId = new Map<string, SystemRole>();
  const byCode = new Map<string, SystemRole>();
  for (const row of data || []) {
    const role = row as SystemRole;
    byId.set(role.id, role);
    byCode.set(role.code, role);
  }

  rolesCacheById = byId;
  rolesCacheByCode = byCode;
  rolesCacheExpiresAt = now + ROLES_CACHE_TTL_MS;
}

export async function getRoleByCode(code: string | null | undefined): Promise<SystemRole | null> {
  if (!code) return null;
  await loadRolesCache();
  return rolesCacheByCode?.get(code) ?? null;
}

export async function getRoleById(id: string | null | undefined): Promise<SystemRole | null> {
  if (!id) return null;
  await loadRolesCache();
  return rolesCacheById?.get(id) ?? null;
}

export async function getAllRoles(): Promise<SystemRole[]> {
  await loadRolesCache();
  return rolesCacheByCode ? [...rolesCacheByCode.values()] : [];
}

export function invalidateRolesCache(): void {
  rolesCacheById = null;
  rolesCacheByCode = null;
  rolesCacheExpiresAt = 0;
}
