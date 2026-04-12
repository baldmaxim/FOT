import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC_ROOT = path.resolve(__dirname, '..');

function collectTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      if (entry === '__tests__') {
        continue;
      }
      files.push(...collectTsFiles(fullPath));
      continue;
    }

    if (fullPath.endsWith('.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

function readSources(files: string[]): Array<{ file: string; source: string }> {
  return files.map((file) => ({
    file,
    source: readFileSync(file, 'utf8'),
  }));
}

function getMatches(
  sources: Array<{ file: string; source: string }>,
  pattern: RegExp,
): string[] {
  return sources.filter(({ source }) => pattern.test(source)).map(({ file }) => file);
}

describe('Schema contract guards', () => {
  const files = collectTsFiles(SRC_ROOT);
  const sources = readSources(files);

  it('does not reference removed organizations relation or phantom timesheet table', () => {
    expect(getMatches(sources, /\.from\((['"])organizations\1\)/)).toEqual([]);
    expect(getMatches(sources, /\.from\((['"])timesheet\1\)/)).toEqual([]);
  });

  it('does not expose removed organizations API routes', () => {
    expect(getMatches(sources, /\/auth\/organizations/)).toEqual([]);
    expect(getMatches(sources, /\/skud\/organizations/)).toEqual([]);
  });

  it('does not request removed employee_assignments columns', () => {
    expect(getMatches(sources, /from\((['"])employee_assignments\1\)[\s\S]{0,220}\.select\((['"])[\s\S]*org_company_id[\s\S]*\2\)/)).toEqual([]);
    expect(getMatches(sources, /from\((['"])employee_assignments\1\)[\s\S]{0,220}\.select\((['"])[\s\S]*org_subdivision_id[\s\S]*\2\)/)).toEqual([]);
    expect(getMatches(sources, /from\((['"])employee_assignments\1\)[\s\S]{0,260}\.insert\([\s\S]*org_company_id/)).toEqual([]);
    expect(getMatches(sources, /from\((['"])employee_assignments\1\)[\s\S]{0,260}\.insert\([\s\S]*org_subdivision_id/)).toEqual([]);
  });
});
