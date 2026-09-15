import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Изоляция точечных прав на чтение: они не должны «протечь» в общие резолверы
 * скоупа, табель, заявления, документы, назначения или «Звонки».
 *
 * Ключи /skud-presence/all-objects и /dashboard/all-departments упоминаются только
 * в каталоге прав и в read-scope-grants.service; сервис импортируют только
 * обработчики двух экранов и дерево «Обзора».
 */

const SRC = path.resolve(__dirname, '..');

function collectTs(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return collectTs(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
  });
}

const rel = (file: string) => path.relative(SRC, file).replace(/\\/g, '/');
const sources = collectTs(SRC).map(file => ({ file: rel(file), text: readFileSync(file, 'utf8') }));

describe('изоляция прав «все объекты» и «все отделы»', () => {
  it('ключи прав упоминаются только в каталоге и сервисе проверки', () => {
    const users = sources
      .filter(({ text }) => text.includes("'/skud-presence/all-objects'") || text.includes("'/dashboard/all-departments'"))
      .map(({ file }) => file)
      .sort();
    expect(users).toEqual(['config/access-control.ts']);
  });

  it('read-scope-grants.service импортируют только экраны «Сотрудники на объектах» и «Обзор»', () => {
    const importers = sources
      .filter(({ text }) => text.includes('read-scope-grants.service.js'))
      .map(({ file }) => file)
      .sort();
    expect(importers).toEqual([
      'controllers/skud-presence-export.controller.ts',
      'controllers/skud.controller.ts',
      'controllers/structure.controller.ts',
    ]);
  });

  it('общие резолверы скоупа и «Звонки» права не используют', () => {
    const guarded = [
      'services/data-scope.service.ts',
      'services/employee-skud-object-access.service.ts',
      'services/timesheet-scope.service.ts',
      'services/timekeeper-scope.service.ts',
      'controllers/dashboard-mts.controller.ts',
      'controllers/timesheet.controller.ts',
      'controllers/leave-requests.controller.ts',
      'controllers/documents.controller.ts',
    ];
    for (const file of guarded) {
      const text = sources.find(source => source.file === file)?.text ?? '';
      expect(text, file).not.toMatch(/hasPresenceAllObjectsGrant|hasDashboardAllDepartmentsGrant|SKUD_PRESENCE_ALL_OBJECTS|DASHBOARD_ALL_DEPARTMENTS/);
    }
  });
});
