import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_ACCESS_PAGE_CATALOG, PAGE_PATHS } from '../config/access-control.js';

const SERVER_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');
const FRONTEND_FILES = [
  path.join(REPO_ROOT, 'fot-app', 'src', 'App.tsx'),
  path.join(REPO_ROOT, 'fot-app', 'src', 'components', 'layout', 'Sidebar.tsx'),
  path.join(REPO_ROOT, 'fot-app', 'src', 'components', 'layout', 'EmployeeSidebar.tsx'),
];
const ROUTES_ROOT = path.join(SERVER_ROOT, 'src', 'routes');

function collectTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      files.push(...collectTsFiles(fullPath));
      continue;
    }

    if (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx')) {
      files.push(fullPath);
    }
  }

  return files;
}

function extractStringLiterals(input: string): string[] {
  return [...input.matchAll(/(['"])(\/[^'"]+)\1/g)].map((match) => match[2]);
}

function extractFrontendRequiredPages(source: string): string[] {
  const single = [...source.matchAll(/requiredPage[:=]\s*(?:\{\s*)?(['"])(\/[^'"]+)\1/g)].map((match) => match[2]);
  const grouped = [...source.matchAll(/requiredPage[:=]\s*(?:\{\s*)?\[([\s\S]*?)\](?:\s*\})?/g)].flatMap((match) => extractStringLiterals(match[1]));
  return [...single, ...grouped];
}

function extractBackendAccessUsages(source: string): Array<{ key: string; action: 'view' | 'edit' }> {
  const entries: Array<{ key: string; action: 'view' | 'edit' }> = [];

  for (const match of source.matchAll(/requirePageAccess\(\s*(['"])(\/[^'"]+)\1\s*,\s*(['"])(view|edit)\3/g)) {
    entries.push({ key: match[2], action: match[4] as 'view' | 'edit' });
  }

  for (const match of source.matchAll(/requireAnyPageAccess\(\s*\[([\s\S]*?)\]\s*,\s*(['"])(view|edit)\2/g)) {
    const action = match[3] as 'view' | 'edit';
    for (const key of extractStringLiterals(match[1])) {
      entries.push({ key, action });
    }
  }

  return entries;
}

describe('Access page catalog contract', () => {
  const catalogKeys = new Set(DEFAULT_ACCESS_PAGE_CATALOG.map((page) => page.key));
  const catalogByKey = new Map(DEFAULT_ACCESS_PAGE_CATALOG.map((page) => [page.key, page]));
  const frontendRequiredPages = FRONTEND_FILES.flatMap((file) => extractFrontendRequiredPages(readFileSync(file, 'utf8')));
  const backendAccessUsages = collectTsFiles(ROUTES_ROOT).flatMap((file) =>
    extractBackendAccessUsages(readFileSync(file, 'utf8')),
  );

  it('contains every page key referenced by frontend route guards and navigation', () => {
    const missing = [...new Set(frontendRequiredPages)].filter((key) => !catalogKeys.has(key));
    expect(missing).toEqual([]);
  });

  it('contains every page key referenced by backend access guards', () => {
    const missing = [...new Set(backendAccessUsages.map((entry) => entry.key))].filter((key) => !catalogKeys.has(key));
    expect(missing).toEqual([]);
  });

  it('does not use edit-guards for pages that are view-only in the catalog', () => {
    const invalid = backendAccessUsages
      .filter((entry) => entry.action === 'edit')
      .filter((entry) => !catalogByKey.get(entry.key)?.supports_edit)
      .map((entry) => entry.key);

    expect([...new Set(invalid)]).toEqual([]);
  });

  it('PAGE_PATHS константы соответствуют каталогу 1-в-1', () => {
    const constantPaths = new Set<string>(Object.values(PAGE_PATHS));
    const inCatalogButNotInConst = [...catalogKeys].filter((key) => !constantPaths.has(key));
    const inConstButNotInCatalog = [...constantPaths].filter((key) => !catalogKeys.has(key));
    expect({ inCatalogButNotInConst, inConstButNotInCatalog }).toEqual({
      inCatalogButNotInConst: [],
      inConstButNotInCatalog: [],
    });
  });

  it('каталог не содержит orphan-ключей, не используемых ни во фронте, ни в бэке', () => {
    const usedKeys = new Set<string>([
      ...frontendRequiredPages,
      ...backendAccessUsages.map((entry) => entry.key),
    ]);
    // technical-страницы могут использоваться только через канал API, а не Route props,
    // поэтому исключаем их из проверки на orphan.
    const orphan = [...catalogKeys]
      .filter((key) => !usedKeys.has(key))
      .filter((key) => catalogByKey.get(key)?.surface !== 'technical');
    expect(orphan).toEqual([]);
  });
});
