import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Получатели уведомлений и realtime по согласованию табелей.
 *
 * Админ и кадровый админ (не-админская роль с all_departments_scope, миграция 270)
 * получают события по любому отделу — при праве на нужную страницу. Остальные —
 * только по отделам, которыми управляют.
 */

const h = vi.hoisted(() => ({
  query: vi.fn(),
  getRoleById: vi.fn(),
  getRolePageAccess: vi.fn(),
  loadManagedDepartmentMap: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({ query: h.query }));
vi.mock('./roles-cache.service.js', () => ({ getRoleById: h.getRoleById }));
vi.mock('./access-control.service.js', () => ({ getRolePageAccess: h.getRolePageAccess }));
vi.mock('./department-access.service.js', () => ({ loadManagedDepartmentMap: h.loadManagedDepartmentMap }));

import { listTimesheetWorkflowRecipientIds } from './timesheet-workflow-recipients.service.js';

const DEPT = 'dept-target';
const OTHER_DEPT = 'dept-other';

const ROLES: Record<string, { code: string; is_admin: boolean; all_departments_scope: boolean }> = {
  'r-admin': { code: 'admin', is_admin: true, all_departments_scope: false },
  'r-hr-admin': { code: 'hr_admin', is_admin: false, all_departments_scope: true },
  'r-manager': { code: 'manager', is_admin: false, all_departments_scope: false },
  'r-scope-no-page': { code: 'scope_no_page', is_admin: false, all_departments_scope: true },
};

const PAGES: Record<string, Record<string, { can_view: boolean; can_edit: boolean }>> = {
  'r-admin': { '/timesheet': { can_view: true, can_edit: true }, '/timesheet-hr': { can_view: true, can_edit: true } },
  'r-hr-admin': { '/timesheet': { can_view: true, can_edit: true }, '/timesheet-hr': { can_view: true, can_edit: true } },
  'r-manager': { '/timesheet': { can_view: true, can_edit: true }, '/timesheet-hr': { can_view: true, can_edit: true } },
  'r-scope-no-page': { '/timesheet': { can_view: true, can_edit: false } },
};

const PROFILES = [
  { id: 'u-admin', system_role_id: 'r-admin', employee_id: null },
  { id: 'u-hr-admin', system_role_id: 'r-hr-admin', employee_id: 148 },
  { id: 'u-manager-target', system_role_id: 'r-manager', employee_id: 10 },
  { id: 'u-manager-other', system_role_id: 'r-manager', employee_id: 11 },
  { id: 'u-scope-no-page', system_role_id: 'r-scope-no-page', employee_id: 12 },
];

beforeEach(() => {
  vi.clearAllMocks();
  h.query.mockImplementation(async (sql: string) => {
    if (String(sql).includes('FROM user_profiles')) return PROFILES;
    return []; // отделы сотрудников — для этих проверок не нужны
  });
  h.getRoleById.mockImplementation(async (id: string) => ROLES[id] ?? null);
  h.getRolePageAccess.mockImplementation(async (id: string) => PAGES[id] ?? {});
  h.loadManagedDepartmentMap.mockResolvedValue(new Map([
    ['u-manager-target', { managed_department_ids: [DEPT] }],
    ['u-manager-other', { managed_department_ids: [OTHER_DEPT] }],
  ]));
});

describe('listTimesheetWorkflowRecipientIds', () => {
  it('проверяющие отдела: админ и кадровый админ — по любому отделу, руководитель — только своего', async () => {
    const ids = await listTimesheetWorkflowRecipientIds(DEPT, ['review', 'monitor']);
    expect(ids.sort()).toEqual(['u-admin', 'u-hr-admin', 'u-manager-target'].sort());
  });

  it('глобальный скоуп без права на страницу workflow не делает получателем', async () => {
    const ids = await listTimesheetWorkflowRecipientIds(DEPT, ['review']);
    expect(ids).not.toContain('u-scope-no-page');
  });

  it('напоминания исключают admin и hr_admin по коду роли', async () => {
    const ids = await listTimesheetWorkflowRecipientIds(DEPT, ['submit'], {
      excludeRoleCodes: ['admin', 'hr_admin'],
    });
    expect(ids).toEqual(['u-manager-target']);
  });
});
