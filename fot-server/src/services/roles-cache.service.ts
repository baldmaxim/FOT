import { supabase } from '../config/database.js';
import type { SystemRole } from '../types/index.js';

const ROLES_CACHE_TTL_MS = 300_000;

let rolesCache: Map<string, SystemRole> | null = null;
let rolesCacheExpiresAt = 0;

export async function loadRolesCache(): Promise<Map<string, SystemRole>> {
  const now = Date.now();

  if (rolesCache && rolesCacheExpiresAt > now) {
    return rolesCache;
  }

  const { data, error } = await supabase
    .from('system_roles')
    .select('id, code, name, description, permissions, level, is_active, is_system, created_at, updated_at')
    .eq('is_active', true);

  if (error) {
    throw new Error(`Failed to load roles cache: ${error.message}`);
  }

  rolesCache = new Map<string, SystemRole>();
  for (const role of data || []) {
    rolesCache.set(role.code, role as SystemRole);
  }

  rolesCacheExpiresAt = now + ROLES_CACHE_TTL_MS;
  return rolesCache;
}

export async function getRoleByCode(code: string): Promise<SystemRole | null> {
  const cache = await loadRolesCache();
  return cache.get(code) ?? null;
}

export async function getRoleById(id: string | null | undefined): Promise<SystemRole | null> {
  if (!id) return null;
  const cache = await loadRolesCache();
  for (const role of cache.values()) {
    if (role.id === id) {
      return role;
    }
  }
  return null;
}

export async function getHierarchyLevel(code: string): Promise<number> {
  const role = await getRoleByCode(code);
  return role?.level ?? 0;
}

export function invalidateRolesCache(): void {
  rolesCache = null;
  rolesCacheExpiresAt = 0;
}
