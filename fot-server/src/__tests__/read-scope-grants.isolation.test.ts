import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Изоляция точечных прав на чтение: они не должны «протечь» в общие резолверы
 * скоупа, табель, заявления, документы, назначения или «Звонки».
 *
 * Ключи /skud-presence/all-objects, /dashboard/all-departments и /staff-control/all-employees
 * упоминаются только в каталоге прав и в read-scope-grants.service; сервис импортируют только
 * обработчики своих экранов, дерево отделов и скоуп чтения «Управления кадрами».
 *
 * «Управление кадрами — все сотрудники» живёт в employee-scope-filter.service: по этому кругу
 * у табельщицы открываются список, карточка, «Реквизиты» и HR-документы (загрузка — намеренно).
 * Поэтому список импортёров самого employee-scope-filter.service тоже зафиксирован: новый
 * импортёр из табеля, заявлений или СКУД унёс бы право за пределы кадрового экрана.
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

describe('изоляция прав «все объекты», «все отделы» и «все сотрудники»', () => {
  it('ключи прав упоминаются только в каталоге и сервисе проверки', () => {
    const users = sources
      .filter(({ text }) => text.includes("'/skud-presence/all-objects'")
        || text.includes("'/dashboard/all-departments'")
        || text.includes("'/staff-control/all-employees'"))
      .map(({ file }) => file)
      .sort();
    expect(users).toEqual(['config/access-control.ts']);
  });

  it('read-scope-grants.service импортируют только экраны «Сотрудники на объектах», «Обзор» и скоуп кадров', () => {
    const importers = sources
      .filter(({ text }) => text.includes('read-scope-grants.service.js'))
      .map(({ file }) => file)
      .sort();
    expect(importers).toEqual([
      'controllers/skud-presence-export.controller.ts',
      'controllers/skud.controller.ts',
      'controllers/structure.controller.ts',
      'services/employee-scope-filter.service.ts',
    ]);
  });

  it('скоуп чтения «Управления кадрами» импортируют только кадровый экран и HR-модуль', () => {
    const importers = sources
      .filter(({ text }) => text.includes('employee-scope-filter.service.js'))
      .map(({ file }) => file)
      .sort();
    expect(importers).toEqual([
      'controllers/employees-export.controller.ts',
      'controllers/employees-main-objects.controller.ts',
      'controllers/employees-staff-filter.helpers.ts',
      'controllers/employees.controller.ts',
      'controllers/hr-documents.controller.ts',
      'controllers/hr-profiles.controller.ts',
      'controllers/schedule.controller.ts',
      'services/employee-section-filter.service.ts',
      'services/employees-export.service.ts',
      'services/hr-documents-access.service.ts',
    ]);
  });

  it('общий список GET /employees без page право «все сотрудники» не применяет', () => {
    const text = sources.find(source => source.file === 'controllers/employees.controller.ts')?.text ?? '';
    expect(text).toContain('resolveEmployeeListReadScope(req, { staffGrant: false })');
    expect(text).not.toMatch(/hasStaffAllEmployeesGrant|STAFF_CONTROL_ALL_EMPLOYEES/);
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
      expect(text, file).not.toMatch(/hasPresenceAllObjectsGrant|hasDashboardAllDepartmentsGrant|hasStaffAllEmployeesGrant|SKUD_PRESENCE_ALL_OBJECTS|DASHBOARD_ALL_DEPARTMENTS|STAFF_CONTROL_ALL_EMPLOYEES/);
    }
  });
});
