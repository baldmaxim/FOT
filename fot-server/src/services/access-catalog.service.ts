import {
  accessModeFromFlags,
  type AccessMode,
  type PageAccessEntry,
  type PageCatalogItem,
} from '../config/access-control.js';
import { loadAccessPageCatalog, invalidatePageCatalogCache } from './access-control.service.js';

type AccessState = AccessMode | { can_view?: boolean; can_edit?: boolean } | null | undefined;

function toAccessMode(value: AccessState): AccessMode {
  if (value === 'none' || value === 'view' || value === 'edit') {
    return value;
  }
  return accessModeFromFlags(value);
}

export async function loadAccessCatalog(): Promise<{ pages: PageCatalogItem[] }> {
  const pages = await loadAccessPageCatalog();
  return { pages };
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
  invalidatePageCatalogCache();
}
