import { supabase } from '../config/database.js';
import {
  normalizePermissions,
  resolveDataScopeFromPermissions,
  resolveEmployeeVariantFromPermissions,
  type DataScope,
  type EmployeePortalVariant,
} from '../config/access-control.js';
import {
  invalidateAccessCatalogCache,
  loadAccessPageCatalog,
  loadCapabilityCatalog,
} from './access-catalog.service.js';
import { getRoleByCode, getRoleById, invalidateRolesCache } from './roles-cache.service.js';

interface PageAccessPermission {
  can_view: boolean;
  can_edit: boolean;
}

type RolePageAccessMap = Map<string, Map<string, PageAccessPermission>>;

const PAGE_ACCESS_CACHE_TTL_MS = 300_000;
const SUPER_ADMIN_ROLE_CODE = 'super_admin';
const SUPER_ADMIN_EMPLOYEE_VARIANT = 'portal.employee.variant.office';
const SUPER_ADMIN_DATA_SCOPE = 'data.scope.all';

let pageAccessCache: RolePageAccessMap | null = null;
let pageAccessCacheExpiresAt = 0;

async function loadPageAccessCache(): Promise<RolePageAccessMap> {
  const now = Date.now();
  if (pageAccessCache && pageAccessCacheExpiresAt > now) {
    return pageAccessCache;
  }

  const { data, error } = await supabase
    .from('role_page_access')
    .select('role_code, page_path, can_view, can_edit');

  if (error) {
    throw new Error(`Failed to load role page access cache: ${error.message}`);
  }

  const cache: RolePageAccessMap = new Map();
  for (const entry of data || []) {
    const key = entry.role_code;
    if (!key) continue;
    if (!cache.has(key)) {
      cache.set(key, new Map());
    }
    cache.get(key)!.set(entry.page_path, {
      can_view: !!entry.can_view || !!entry.can_edit,
      can_edit: !!entry.can_edit,
    });
  }

  pageAccessCache = cache;
  pageAccessCacheExpiresAt = now + PAGE_ACCESS_CACHE_TTL_MS;
  return cache;
}

async function resolveRole(roleRef: string) {
  return (await getRoleById(roleRef)) ?? (await getRoleByCode(roleRef));
}

async function getStoredRolePageAccess(roleRef: string, role?: Awaited<ReturnType<typeof resolveRole>>): Promise<Record<string, PageAccessPermission>> {
  const resolvedRole = role ?? await resolveRole(roleRef);
  if (!resolvedRole) {
    return {};
  }

  const cache = await loadPageAccessCache();
  const entries = cache.get(resolvedRole.code) ?? new Map<string, PageAccessPermission>();
  return Object.fromEntries(entries.entries());
}

async function buildSuperAdminPermissions(permissions: string[]): Promise<string[]> {
  const capabilityGroups = await loadCapabilityCatalog();
  const nonExclusivePermissions = capabilityGroups
    .filter(group => !group.exclusive)
    .flatMap(group => group.options.map(option => option.code));

  return normalizePermissions([
    SUPER_ADMIN_EMPLOYEE_VARIANT,
    SUPER_ADMIN_DATA_SCOPE,
    ...permissions,
    ...nonExclusivePermissions,
  ]);
}

async function buildSuperAdminPageAccess(): Promise<Record<string, PageAccessPermission>> {
  const pages = await loadAccessPageCatalog();

  return Object.fromEntries(
    pages.map((page) => [
      page.key,
      {
        can_view: true,
        can_edit: page.supports_edit === true,
      },
    ]),
  );
}

export async function getRolePermissions(roleRef: string): Promise<string[]> {
  const role = await resolveRole(roleRef);
  const permissions = normalizePermissions(role?.permissions);

  if (role?.code === SUPER_ADMIN_ROLE_CODE || roleRef === SUPER_ADMIN_ROLE_CODE) {
    return buildSuperAdminPermissions(permissions);
  }

  return permissions;
}

export async function getRolePageAccess(roleRef: string): Promise<Record<string, PageAccessPermission>> {
  const role = await resolveRole(roleRef);
  if (role?.code === SUPER_ADMIN_ROLE_CODE || roleRef === SUPER_ADMIN_ROLE_CODE) {
    return buildSuperAdminPageAccess();
  }

  if (!role) {
    return {};
  }

  return getStoredRolePageAccess(roleRef, role);
}

export async function hasPermission(roleRef: string, permission: string): Promise<boolean> {
  const permissions = await getRolePermissions(roleRef);
  return permissions.includes(permission);
}

export async function hasAnyPermission(roleRef: string, permissions: string[]): Promise<boolean> {
  const rolePermissions = await getRolePermissions(roleRef);
  return permissions.some(permission => rolePermissions.includes(permission));
}

export async function hasPageView(roleRef: string, pagePath: string): Promise<boolean> {
  const access = await getRolePageAccess(roleRef);
  return access[pagePath]?.can_view === true;
}

export async function hasPageEdit(roleRef: string, pagePath: string): Promise<boolean> {
  const access = await getRolePageAccess(roleRef);
  return access[pagePath]?.can_edit === true;
}

export async function getEffectiveAccess(roleRef: string): Promise<{
  permissions: string[];
  page_access: Record<string, PageAccessPermission>;
}> {
  const [permissions, page_access] = await Promise.all([
    getRolePermissions(roleRef),
    getRolePageAccess(roleRef),
  ]);

  return { permissions, page_access };
}

export async function resolveRoleEmployeeVariant(roleRef: string): Promise<EmployeePortalVariant | null> {
  return resolveEmployeeVariantFromPermissions(await getRolePermissions(roleRef));
}

export async function resolveRoleDataScope(roleRef: string): Promise<DataScope | null> {
  return resolveDataScopeFromPermissions(await getRolePermissions(roleRef));
}

export function invalidateRolePageAccessCache(): void {
  pageAccessCache = null;
  pageAccessCacheExpiresAt = 0;
}

export function invalidateRoleListCache(): void {
  invalidateRolesCache();
}

export function invalidateAccessCatalog(): void {
  invalidateAccessCatalogCache();
}

export function invalidateAccessControlCache(): void {
  invalidateRolePageAccessCache();
  invalidateAccessCatalog();
  invalidateRoleListCache();
}
