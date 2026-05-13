import { query } from '../config/postgres.js';
import { DEFAULT_ACCESS_PAGE_CATALOG, type PageCatalogItem } from '../config/access-control.js';
import { getRoleByCode, getRoleById, invalidateRolesCache } from './roles-cache.service.js';
import { resolveAccessibleDepartmentIds } from './data-scope.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Список страниц, к которым не-админ с назначенными отделами
 * (employee_department_access) получает авто-доступ как «руководитель».
 * Доступ к редактированию на этих страницах ограничен scope-проверками
 * внутри обработчиков (canAccessEmployeeInScope и др.).
 */
const MANAGER_AUTO_ACCESS_PAGES = new Set<string>([
  '/staff-control',
]);

export interface PageAccessPermission {
  can_view: boolean;
  can_edit: boolean;
}

export type PageAccessMap = Record<string, PageAccessPermission>;

type RolePageAccessMap = Map<string, Map<string, PageAccessPermission>>;

const PAGE_ACCESS_CACHE_TTL_MS = 300_000;
const PAGE_CATALOG_CACHE_TTL_MS = 300_000;

let pageAccessCache: RolePageAccessMap | null = null;
let pageAccessCacheExpiresAt = 0;

let pageCatalogCache: PageCatalogItem[] | null = null;
let pageCatalogCacheExpiresAt = 0;

async function loadPageAccessCache(): Promise<RolePageAccessMap> {
  const now = Date.now();
  if (pageAccessCache && pageAccessCacheExpiresAt > now) {
    return pageAccessCache;
  }

  let data: Array<{ role_code: string | null; page_path: string; can_view: boolean | null; can_edit: boolean | null }>;
  try {
    data = await query(
      `SELECT role_code, page_path, can_view, can_edit FROM role_page_access`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load role page access cache: ${msg}`);
  }

  const cache: RolePageAccessMap = new Map();
  for (const entry of data) {
    if (!entry.role_code) continue;
    if (!cache.has(entry.role_code)) {
      cache.set(entry.role_code, new Map());
    }
    cache.get(entry.role_code)!.set(entry.page_path, {
      can_view: !!entry.can_view || !!entry.can_edit,
      can_edit: !!entry.can_edit,
    });
  }

  pageAccessCache = cache;
  pageAccessCacheExpiresAt = now + PAGE_ACCESS_CACHE_TTL_MS;
  return cache;
}

function mergePageCatalog(dbPages: PageCatalogItem[] | null): PageCatalogItem[] {
  const merged = new Map<string, PageCatalogItem>();
  for (const page of DEFAULT_ACCESS_PAGE_CATALOG.filter((item) => item.is_active)) {
    merged.set(page.key, { ...page });
  }
  for (const page of dbPages || []) {
    merged.set(page.key, { ...page });
  }
  return [...merged.values()].sort(
    (l, r) => l.sort_order - r.sort_order || l.label.localeCompare(r.label, 'ru'),
  );
}

async function loadPageCatalogFromDatabase(): Promise<PageCatalogItem[] | null> {
  try {
    const rows = await query<PageCatalogItem>(
      `SELECT key, label, group_code, group_label, surface, supports_edit, sort_order, is_active
         FROM access_pages
        WHERE is_active = true
        ORDER BY sort_order ASC`,
    );
    return rows;
  } catch {
    return null;
  }
}

export async function loadAccessPageCatalog(): Promise<PageCatalogItem[]> {
  const now = Date.now();
  if (pageCatalogCache && pageCatalogCacheExpiresAt > now) {
    return pageCatalogCache;
  }
  const fromDb = await loadPageCatalogFromDatabase();
  pageCatalogCache = mergePageCatalog(fromDb);
  pageCatalogCacheExpiresAt = now + PAGE_CATALOG_CACHE_TTL_MS;
  return pageCatalogCache;
}

async function resolveRole(roleRef: string) {
  return (await getRoleById(roleRef)) ?? (await getRoleByCode(roleRef));
}

export async function getRolePageAccess(roleRef: string): Promise<PageAccessMap> {
  const role = await resolveRole(roleRef);
  if (!role) return {};
  const cache = await loadPageAccessCache();
  const entries = cache.get(role.code) ?? new Map<string, PageAccessPermission>();
  return Object.fromEntries(entries.entries());
}

export async function hasPageView(roleRef: string, pagePath: string): Promise<boolean> {
  const access = await getRolePageAccess(roleRef);
  return access[pagePath]?.can_view === true;
}

export async function hasPageEdit(roleRef: string, pagePath: string): Promise<boolean> {
  const access = await getRolePageAccess(roleRef);
  return access[pagePath]?.can_edit === true;
}

async function hasManagerAutoAccess(req: AuthenticatedRequest, pagePath: string): Promise<boolean> {
  if (req.user.is_admin) return false;
  if (!MANAGER_AUTO_ACCESS_PAGES.has(pagePath)) return false;
  const accessible = await resolveAccessibleDepartmentIds(req);
  return accessible !== 'all' && accessible.length > 0;
}

/**
 * Эффективная проверка доступа к странице: bypass для is_admin (симметрично
 * фронту, где canViewPage возвращает true для админа), role-based по
 * role_page_access + авто-доступ «руководителя» (не-админ с назначенными
 * отделами) к страницам из MANAGER_AUTO_ACCESS_PAGES.
 */
export async function resolveEffectivePageAccess(
  req: AuthenticatedRequest,
  pagePath: string,
  action: 'view' | 'edit',
): Promise<boolean> {
  if (req.user.is_admin) return true;
  const byRole = action === 'edit'
    ? await hasPageEdit(req.user.role_code, pagePath)
    : await hasPageView(req.user.role_code, pagePath);
  if (byRole) return true;
  return hasManagerAutoAccess(req, pagePath);
}

export function invalidateRolePageAccessCache(): void {
  pageAccessCache = null;
  pageAccessCacheExpiresAt = 0;
}

export function invalidatePageCatalogCache(): void {
  pageCatalogCache = null;
  pageCatalogCacheExpiresAt = 0;
}

export function invalidateRoleListCache(): void {
  invalidateRolesCache();
}

export function invalidateAccessControlCache(): void {
  invalidateRolePageAccessCache();
  invalidatePageCatalogCache();
  invalidateRoleListCache();
}
