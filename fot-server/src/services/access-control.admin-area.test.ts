import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthenticatedRequest, SystemRole } from '../types/index.js';

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

const role = (over: Partial<SystemRole>): SystemRole => ({
  id: 'role-1',
  code: 'mts_manager',
  name: 'Менеджер МТС',
  description: null,
  is_admin: false,
  admin_access: true,
  manager_auto_access: true,
  employee_variant: 'office',
  is_active: true,
  show_actual_hours: false,
  hide_sidebar: false,
  timesheet_months_back: 1,
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
});

const req = (): AuthenticatedRequest => ({
  user: { id: 'u-1', role_code: 'mts_manager', is_admin: false, employee_id: 800 },
} as unknown as AuthenticatedRequest);

describe('resolveEffectivePageAccess: админ-область и авто-доступ руководителя', () => {
  beforeEach(() => {
    invalidateRolePageAccessCache();
    h.pgQuery.mockReset();
    h.getRoleByCode.mockReset();
    h.getRoleById.mockReset();
    h.resolveAccessibleDepartmentIds.mockReset();
    h.hasHiringAutoAccess.mockReset().mockResolvedValue(false);
    h.isHiringRequesterRole.mockReset().mockReturnValue(false);
    h.getRoleById.mockResolvedValue(null);
    // У пользователя есть назначенные отделы — раньше это давало /staff-control любой роли.
    h.resolveAccessibleDepartmentIds.mockResolvedValue(['dept-1']);
  });

  it('manager_auto_access=false: «Управление кадрами» не выдаётся, свой раздел доступен', async () => {
    h.getRoleByCode.mockResolvedValue(role({ manager_auto_access: false }));
    h.pgQuery.mockResolvedValue([
      { role_code: 'mts_manager', page_path: '/mts-business', can_view: true, can_edit: true },
    ]);

    await expect(resolveEffectivePageAccess(req(), '/staff-control', 'view')).resolves.toBe(false);
    await expect(resolveEffectivePageAccess(req(), '/mts-business', 'edit')).resolves.toBe(true);
  });

  it('manager_auto_access=true: «Управление кадрами» выдаётся по назначенным отделам', async () => {
    h.getRoleByCode.mockResolvedValue(role({ manager_auto_access: true }));
    h.pgQuery.mockResolvedValue([]);

    await expect(resolveEffectivePageAccess(req(), '/staff-control', 'view')).resolves.toBe(true);
  });

  it('admin_access=false: админ-ключи роли режутся, личный кабинет остаётся', async () => {
    h.getRoleByCode.mockResolvedValue(role({ admin_access: false, manager_auto_access: false }));
    h.pgQuery.mockResolvedValue([
      { role_code: 'mts_manager', page_path: '/mts-business', can_view: true, can_edit: true },
      { role_code: 'mts_manager', page_path: '/employee/sim', can_view: true, can_edit: false },
    ]);

    await expect(resolveEffectivePageAccess(req(), '/mts-business', 'view')).resolves.toBe(false);
    await expect(resolveEffectivePageAccess(req(), '/employee/sim', 'view')).resolves.toBe(true);
  });

  it('кабинет подрядчика (/contractor) не режется гейтом админки', async () => {
    h.getRoleByCode.mockResolvedValue(role({ code: 'contractor', admin_access: false, employee_variant: 'contractor' }));
    h.pgQuery.mockResolvedValue([
      { role_code: 'contractor', page_path: '/contractor', can_view: true, can_edit: true },
    ]);

    const contractorReq = {
      user: { id: 'u-2', role_code: 'contractor', is_admin: false, employee_id: null },
    } as unknown as AuthenticatedRequest;

    await expect(resolveEffectivePageAccess(contractorReq, '/contractor', 'edit')).resolves.toBe(true);
  });

  it('офисный рекрутер без админ-страниц сохраняет «Заявки на поиск» (авто-доступ мимо гейта)', async () => {
    h.getRoleByCode.mockResolvedValue(role({ code: 'office', admin_access: false, manager_auto_access: true }));
    h.pgQuery.mockResolvedValue([
      { role_code: 'office', page_path: '/employee', can_view: true, can_edit: false },
    ]);
    h.resolveAccessibleDepartmentIds.mockResolvedValue([]);
    h.hasHiringAutoAccess.mockResolvedValue(true);

    const officeReq = {
      user: { id: 'u-3', role_code: 'office', is_admin: false, employee_id: 1348 },
    } as unknown as AuthenticatedRequest;

    await expect(resolveEffectivePageAccess(officeReq, '/staff-control/hiring', 'view')).resolves.toBe(true);
    // При этом «Управление кадрами» целиком ему не открывается: отделов нет.
    await expect(resolveEffectivePageAccess(officeReq, '/staff-control', 'view')).resolves.toBe(false);
  });
});
