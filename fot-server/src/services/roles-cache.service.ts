import { query } from '../config/postgres.js';
import type { SystemRole } from '../types/index.js';

const ROLES_CACHE_TTL_MS = 300_000;

let rolesCacheById: Map<string, SystemRole> | null = null;
let rolesCacheByCode: Map<string, SystemRole> | null = null;
let rolesCacheExpiresAt = 0;
// Promise-dedup: пока первый запрос летит в БД, параллельные вызовы ждут
// его результат вместо того, чтобы тоже идти в БД. Без этого один HTTP-запрос
// (например, GET /api/structure) на холодный кеш делал 4-5 одинаковых
// `SELECT FROM system_roles` (FOT-SERVER-V/14).
let rolesCacheInflight: Promise<void> | null = null;

async function loadRolesCache(): Promise<void> {
  const now = Date.now();
  if (rolesCacheById && rolesCacheByCode && rolesCacheExpiresAt > now) {
    return;
  }
  if (rolesCacheInflight) {
    return rolesCacheInflight;
  }

  rolesCacheInflight = (async () => {
    try {
      const rows = await query<SystemRole>(
        `SELECT id, code, name, description, is_admin, employee_variant, is_active,
                show_actual_hours, hide_sidebar, timesheet_months_back, timesheet_months_forward,
                timesheet_show_full_period,
                created_at, updated_at
           FROM system_roles
          WHERE is_active = true`,
      );

      const byId = new Map<string, SystemRole>();
      const byCode = new Map<string, SystemRole>();
      for (const role of rows) {
        byId.set(role.id, role);
        byCode.set(role.code, role);
      }

      rolesCacheById = byId;
      rolesCacheByCode = byCode;
      rolesCacheExpiresAt = Date.now() + ROLES_CACHE_TTL_MS;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to load roles cache: ${msg}`);
    } finally {
      rolesCacheInflight = null;
    }
  })();

  return rolesCacheInflight;
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
  rolesCacheInflight = null;
}
