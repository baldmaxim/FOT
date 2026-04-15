import { supabase } from '../config/database.js';
import {
  DEFAULT_ACCESS_PAGE_CATALOG,
  DEFAULT_PERMISSION_GROUPS,
  accessModeFromFlags,
  type AccessMode,
  type PageCatalogItem,
  type PermissionGroup,
  type PermissionOption,
  type PageAccessEntry,
  validatePermissionSelections,
} from '../config/access-control.js';

interface ICapabilityCatalogRow {
  option_code: string;
  group_code: string;
  group_label: string;
  group_description: string;
  option_label: string;
  option_description: string;
  exclusive: boolean;
  group_sort_order: number;
  option_sort_order: number;
  is_active: boolean;
}

const ACCESS_CATALOG_CACHE_TTL_MS = 300_000;

let pageCatalogCache: PageCatalogItem[] | null = null;
let capabilityCatalogCache: PermissionGroup[] | null = null;
let catalogCacheExpiresAt = 0;

function isMissingRelationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const code = 'code' in error ? error.code : null;
  const message = 'message' in error ? String(error.message || '') : '';

  return (
    code === '42P01'
    || code === '42703'
    || code === 'PGRST204'
    || code === 'PGRST205'
    || /relation .* does not exist/i.test(message)
    || /column .* does not exist/i.test(message)
    || /schema cache/i.test(message)
    || /Could not find the table/i.test(message)
    || /Could not find the .* column/i.test(message)
  );
}

function clonePageCatalog(pages: PageCatalogItem[]): PageCatalogItem[] {
  return pages.map((page) => ({ ...page }));
}

function clonePermissionGroups(groups: PermissionGroup[]): PermissionGroup[] {
  return groups.map((group) => ({
    ...group,
    options: group.options.map((option) => ({ ...option })),
  }));
}

function normalizeCapabilityGroups(rows: ICapabilityCatalogRow[]): PermissionGroup[] {
  const groups = new Map<string, PermissionGroup>();

  for (const row of rows) {
    if (!row.is_active) continue;

    if (!groups.has(row.group_code)) {
      groups.set(row.group_code, {
        code: row.group_code,
        label: row.group_label,
        description: row.group_description,
        exclusive: !!row.exclusive,
        sort_order: row.group_sort_order,
        options: [],
      });
    }

    const option: PermissionOption = {
      code: row.option_code,
      label: row.option_label,
      description: row.option_description,
      sort_order: row.option_sort_order,
    };

    groups.get(row.group_code)!.options.push(option);
  }

  return [...groups.values()]
    .sort((left, right) => left.sort_order - right.sort_order || left.label.localeCompare(right.label, 'ru'))
    .map((group) => ({
      ...group,
      options: [...group.options].sort(
        (left, right) => left.sort_order - right.sort_order || left.label.localeCompare(right.label, 'ru'),
      ),
    }));
}

async function loadPageCatalogFromDatabase(): Promise<PageCatalogItem[] | null> {
  const { data, error } = await supabase
    .from('access_pages')
    .select('key, label, group_code, group_label, surface, supports_edit, requires_data_scope, requires_employee_variant, sort_order, is_active, is_system')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('key', { ascending: true });

  if (error) {
    if (isMissingRelationError(error)) return null;
    throw new Error(`Failed to load access page catalog: ${error.message}`);
  }

  if (!data || data.length === 0) {
    return null;
  }

  return data as PageCatalogItem[];
}

async function loadCapabilityCatalogFromDatabase(): Promise<PermissionGroup[] | null> {
  const { data, error } = await supabase
    .from('access_capability_catalog')
    .select('option_code, group_code, group_label, group_description, option_label, option_description, exclusive, group_sort_order, option_sort_order, is_active')
    .eq('is_active', true)
    .order('group_sort_order', { ascending: true })
    .order('option_sort_order', { ascending: true });

  if (error) {
    if (isMissingRelationError(error)) return null;
    throw new Error(`Failed to load capability catalog: ${error.message}`);
  }

  if (!data || data.length === 0) {
    return null;
  }

  return normalizeCapabilityGroups(data as ICapabilityCatalogRow[]);
}

async function ensureCatalogLoaded(): Promise<void> {
  const now = Date.now();
  if (pageCatalogCache && capabilityCatalogCache && catalogCacheExpiresAt > now) {
    return;
  }

  const [dbPages, dbCapabilities] = await Promise.all([
    loadPageCatalogFromDatabase(),
    loadCapabilityCatalogFromDatabase(),
  ]);

  pageCatalogCache = clonePageCatalog(dbPages ?? DEFAULT_ACCESS_PAGE_CATALOG.filter((page) => page.is_active));
  capabilityCatalogCache = clonePermissionGroups(dbCapabilities ?? DEFAULT_PERMISSION_GROUPS);
  catalogCacheExpiresAt = now + ACCESS_CATALOG_CACHE_TTL_MS;
}

type AccessState = AccessMode | { can_view?: boolean; can_edit?: boolean } | null | undefined;

function toAccessMode(value: AccessState): AccessMode {
  if (value === 'none' || value === 'view' || value === 'edit') {
    return value;
  }

  return accessModeFromFlags(value);
}

export async function loadAccessPageCatalog(): Promise<PageCatalogItem[]> {
  await ensureCatalogLoaded();
  return clonePageCatalog(pageCatalogCache || []);
}

export async function loadCapabilityCatalog(): Promise<PermissionGroup[]> {
  await ensureCatalogLoaded();
  return clonePermissionGroups(capabilityCatalogCache || []);
}

export async function loadAccessCatalog(): Promise<{ pages: PageCatalogItem[]; capabilities: PermissionGroup[] }> {
  const [pages, capabilities] = await Promise.all([
    loadAccessPageCatalog(),
    loadCapabilityCatalog(),
  ]);

  return { pages, capabilities };
}

export async function validatePageAccessModes(
  pageAccess: Record<string, AccessState>,
): Promise<string | null> {
  const catalog = await loadAccessPageCatalog();
  const pageByKey = new Map(catalog.map((page) => [page.key, page]));

  for (const [pageKey, state] of Object.entries(pageAccess)) {
    const page = pageByKey.get(pageKey);
    if (!page) {
      return `Неизвестная страница в матрице доступа: ${pageKey}`;
    }

    if (toAccessMode(state) === 'edit' && !page.supports_edit) {
      return `Страница ${page.label} не поддерживает режим изменения`;
    }
  }

  return null;
}

export async function validateRoleConfiguration(
  roleCode: string,
  permissions: string[] | null | undefined,
  pageAccess: Record<string, AccessState>,
): Promise<string | null> {
  const permissionError = validatePermissionSelections(roleCode, permissions);
  if (permissionError) {
    return permissionError;
  }

  const pageError = await validatePageAccessModes(pageAccess);
  if (pageError) {
    return pageError;
  }

  const pages = await loadAccessPageCatalog();
  const grantedPages = pages.filter((page) => toAccessMode(pageAccess[page.key]) !== 'none');
  const hasEmployeeVariantPage = grantedPages.some((page) => page.requires_employee_variant);
  const hasDataScopePage = grantedPages.some((page) => page.requires_data_scope);

  const hasEmployeeVariantPermission = !!permissions?.some((permission) => permission.startsWith('portal.employee.variant.'));
  const hasDataScopePermission = !!permissions?.some((permission) => permission.startsWith('data.scope.'));

  if (hasEmployeeVariantPage && !hasEmployeeVariantPermission) {
    return `Роль ${roleCode}: для доступа к страницам с кабинетом /employee нужно выбрать вариант кабинета`;
  }

  if (hasDataScopePage && !hasDataScopePermission) {
    return `Роль ${roleCode}: для доступа к страницам с данными нужно выбрать область данных`;
  }

  return null;
}

export async function normalizeKnownPageAccessModes(
  pageAccess: Record<string, AccessState>,
): Promise<Record<string, AccessMode>> {
  const pages = await loadAccessPageCatalog();
  const pageByKey = new Map(pages.map((page) => [page.key, page]));
  const normalized: Record<string, AccessMode> = {};

  for (const [pageKey, state] of Object.entries(pageAccess)) {
    const page = pageByKey.get(pageKey);
    if (!page) continue;

    const mode = toAccessMode(state);
    if (mode === 'none') continue;

    normalized[pageKey] = mode === 'edit' && !page.supports_edit ? 'view' : mode;
  }

  return normalized;
}

export function pageAccessRowsToModes(entries: PageAccessEntry[]): Record<string, AccessMode> {
  const result: Record<string, AccessMode> = {};

  for (const entry of entries) {
    result[entry.page_path] = accessModeFromFlags(entry);
  }

  return result;
}

export function invalidateAccessCatalogCache(): void {
  pageCatalogCache = null;
  capabilityCatalogCache = null;
  catalogCacheExpiresAt = 0;
}
