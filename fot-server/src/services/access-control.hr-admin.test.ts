import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthenticatedRequest, SystemRole } from '../types/index.js';

/**
 * Набор страниц роли «Кадровый админ» (миграция 270) и — главное — проверка, что
 * all_departments_scope НЕ является разрешением на действие.
 *
 * Флаг даёт только скоуп данных; право на каждое действие по-прежнему решает
 * page-access. Роль с флагом, но без edit нужной страницы, действие не получает.
 */

const h = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  getRoleByCode: vi.fn(),
  getRoleById: vi.fn(),
  resolveAccessibleDepartmentIds: vi.fn(),
  hasHiringAutoAccess: vi.fn(),
  isHiringRequesterRole: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({ query: h.pgQuery }));
vi.mock('./roles-cache.service.js', () => ({
  getRoleByCode: h.getRoleByCode,
  getRoleById: h.getRoleById,
  invalidateRolesCache: vi.fn(),
}));
vi.mock('./data-scope.service.js', () => ({ resolveAccessibleDepartmentIds: h.resolveAccessibleDepartmentIds }));
vi.mock('./hiring-access.service.js', () => ({
  hasHiringAutoAccess: h.hasHiringAutoAccess,
  isHiringRequesterRole: h.isHiringRequesterRole,
}));

import { resolveEffectivePageAccess, invalidateRolePageAccessCache } from './access-control.service.js';

const HR_ADMIN_PAGES = [
  '/staff-control',
  '/staff-control/direct-reports',
  '/timesheet',
  '/timesheet/lock-toggle',
  '/timesheet-hr',
  '/leave-requests',
  '/sigur',
  '/admin/users',
  '/admin/checks',
];

const DENIED_PAGES = [
  '/skud-settings',
  '/admin/users/access',
  '/admin/roles',
  '/admin/settings',
  '/admin/audit',
  '/admin/data-api',
];

const hrAdminRole = (over: Partial<SystemRole> = {}): SystemRole => ({
  id: 'role-hr-admin',
  code: 'hr_admin',
  name: 'Кадровый админ',
  description: null,
  is_admin: false,
  admin_access: true,
  manager_auto_access: false,
  all_departments_scope: true,
  view_all_departments: false,
  object_kpi_own_objects_only: false,
  employee_variant: 'office',
  is_active: true,
  show_actual_hours: true,
  hide_sidebar: false,
  timesheet_months_back: 12,
  timesheet_months_forward: 1,
  timesheet_show_full_period: true,
  corrections_anomalies_only: false,
  corrections_cap_by_schedule_norm: false,
  corrections_allow_zero_short_attendance: false,
  corrections_disable_bulk: false,
  corrections_disable_object_entries: false,
  max_corrections_per_month: null,
  weekend_memo_required: false,
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
  ...over,
} as SystemRole);

const req = (): AuthenticatedRequest => ({
  user: { id: 'u-hr-admin', role_code: 'hr_admin', is_admin: false, employee_id: 148 },
} as unknown as AuthenticatedRequest);

const grantRows = (pages: string[]) => pages.map(page => ({
  role_code: 'hr_admin',
  page_path: page,
  can_view: true,
  can_edit: true,
}));

beforeEach(() => {
  invalidateRolePageAccessCache();
  h.pgQuery.mockReset();
  h.getRoleById.mockReset().mockResolvedValue(null);
  h.getRoleByCode.mockReset().mockResolvedValue(hrAdminRole());
  h.hasHiringAutoAccess.mockReset().mockResolvedValue(false);
  h.isHiringRequesterRole.mockReset().mockReturnValue(false);
  // Флаг даёт видимость всей организации — на права страниц это влиять не должно.
  h.resolveAccessibleDepartmentIds.mockReset().mockResolvedValue('all');
});

describe('hr_admin: набор страниц', () => {
  it('получает свои разделы, включая три новых ключа', async () => {
    h.pgQuery.mockResolvedValue(grantRows(HR_ADMIN_PAGES));
    for (const page of HR_ADMIN_PAGES) {
      await expect(resolveEffectivePageAccess(req(), page, 'edit')).resolves.toBe(true);
    }
  });

  it('не получает СКУД, настройку чужих доступов и системные разделы', async () => {
    h.pgQuery.mockResolvedValue(grantRows(HR_ADMIN_PAGES));
    for (const page of DENIED_PAGES) {
      await expect(resolveEffectivePageAccess(req(), page, 'view')).resolves.toBe(false);
    }
  });
});

describe('all_departments_scope не заменяет page-access', () => {
  it('флаг есть, страницы нет — действие запрещено', async () => {
    h.pgQuery.mockResolvedValue([]);
    for (const page of ['/staff-control', '/timesheet', '/leave-requests', '/timesheet/lock-toggle']) {
      await expect(resolveEffectivePageAccess(req(), page, 'edit')).resolves.toBe(false);
      await expect(resolveEffectivePageAccess(req(), page, 'view')).resolves.toBe(false);
    }
  });

  it('view без edit не даёт права на изменение', async () => {
    h.pgQuery.mockResolvedValue([
      { role_code: 'hr_admin', page_path: '/staff-control', can_view: true, can_edit: false },
    ]);
    await expect(resolveEffectivePageAccess(req(), '/staff-control', 'view')).resolves.toBe(true);
    await expect(resolveEffectivePageAccess(req(), '/staff-control', 'edit')).resolves.toBe(false);
  });

  it('выключённый admin_access режет админ-ключи даже при флаге скоупа', async () => {
    h.getRoleByCode.mockResolvedValue(hrAdminRole({ admin_access: false }));
    h.pgQuery.mockResolvedValue(grantRows(['/staff-control', '/employee/requests']));
    await expect(resolveEffectivePageAccess(req(), '/staff-control', 'view')).resolves.toBe(false);
    await expect(resolveEffectivePageAccess(req(), '/employee/requests', 'view')).resolves.toBe(true);
  });
});
