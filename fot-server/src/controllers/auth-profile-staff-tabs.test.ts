/**
 * /auth/me и галочки «Проживание»/«Удержания» в назначениях (миграция 351).
 *
 * Зеркало ветки resolveEffectivePageAccess: галочка кладёт в page_access правку своей вкладки и даёт вход в админку
 * роли только с личным кабинетом. staff_tab_role_edit и can_grant_staff_tabs считаются по РОЛИ (галочка их не
 * включает): первое — правка справочника видов удержаний, второе — право ставить галочки (плюс охват «вся организация»).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const { pgQuery, pgQueryOne } = vi.hoisted(() => ({
  pgQuery: vi.fn(async () => []),
  pgQueryOne: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

type PageAccess = Record<string, { can_view: boolean; can_edit: boolean }>;

const mocked = vi.hoisted(() => ({
  getRoleById: vi.fn(),
  getRolePageAccess: vi.fn(async (): Promise<PageAccess> => ({})),
  hasPayrollSectionAccess: vi.fn(async (): Promise<boolean> => false),
}));

vi.mock('../services/roles-cache.service.js', () => ({
  getRoleById: mocked.getRoleById,
  getRoleByCode: vi.fn(),
}));
vi.mock('../services/access-control.service.js', () => ({
  getRolePageAccess: mocked.getRolePageAccess,
  listDeputyAutoAccessPages: () => [],
}));
vi.mock('../services/payroll/payroll-access.service.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/payroll/payroll-access.service.js')>(),
  hasPayrollSectionAccess: mocked.hasPayrollSectionAccess,
}));
vi.mock('../services/department-access.service.js', () => ({
  listManagedDepartmentIdsForUser: vi.fn(async () => [] as string[]),
  hasActiveDeputyAssignment: vi.fn(async () => false),
}));
vi.mock('../services/employee-direct-reports.service.js', () => ({
  listDirectSubordinates: vi.fn(async () => [] as number[]),
}));
vi.mock('../services/weekend-approval-assignments.service.js', () => ({
  isActiveWeekendResponsible: vi.fn(async () => false),
}));
vi.mock('../services/hiring-access.service.js', () => ({
  hasHiringAutoAccess: vi.fn(async () => false),
  isHiringRequesterRole: vi.fn(() => false),
}));
vi.mock('../services/object-kpi-roles-cache.service.js', () => ({ isEconomicsHead: vi.fn(async () => false) }));

// Побочные зависимости модуля auth.controller — в этом тесте не участвуют.
vi.mock('../services/local-auth.service.js', () => ({
  localAuthService: {}, LocalAuthError: class extends Error {},
}));
vi.mock('../services/audit.service.js', () => ({ auditService: { log: vi.fn() } }));
vi.mock('../services/mailer.service.js', () => ({ mailerService: { send: vi.fn() } }));
vi.mock('../services/notification.service.js', () => ({ notificationService: { create: vi.fn() } }));
vi.mock('../services/push.service.js', () => ({ pushService: { send: vi.fn() } }));
vi.mock('./auth-2fa.controller.js', () => ({ verify2FA: vi.fn(), useRecoveryCode: vi.fn() }));
vi.mock('../utils/auth-session.js', () => ({
  clearSessionCookies: vi.fn(),
  generateAccessToken: vi.fn(() => 'access-token'),
  generateRefreshToken: vi.fn(() => 'refresh-token'),
  getRefreshTokenFromRequest: vi.fn(),
  setSessionCookies: vi.fn(),
  verifyRefreshToken: vi.fn(),
}));

import { authController } from './auth.controller.js';

const baseRole = {
  name: 'Роль',
  employee_variant: 'office',
  show_actual_hours: false,
  hide_sidebar: false,
  view_all_departments: false,
  timesheet_months_back: 1,
  timesheet_months_forward: 1,
  timesheet_show_full_period: true,
  weekend_memo_required: false,
  corrections_disable_object_entries: false,
};

const OFFICE_ROLE = { ...baseRole, id: 'role-office', code: 'office', is_admin: false, admin_access: false, manager_auto_access: true };
const HR_ROLE = { ...baseRole, id: 'role-hr', code: 'hr', is_admin: false, admin_access: true, manager_auto_access: true };
const ADMIN_ROLE = { ...baseRole, id: 'role-admin', code: 'admin', is_admin: true, admin_access: true, manager_auto_access: true };

const PROFILE_ROW = {
  id: 'user-1',
  full_name: 'Бухгалтер Б.Б.',
  system_role_id: 'role-office',
  employee_id: 501,
  supervisor_id: null,
  chat_inbound_mode: 'open',
  imported_position: null,
  is_approved: true,
  created_at: '2026-01-01T00:00:00Z',
};

const makeReq = (): AuthenticatedRequest => ({
  params: {}, query: {}, body: {},
  user: {
    id: 'user-1',
    email: 'buh@example.com',
    role_code: 'office',
    employee_id: 501,
    department_id: null,
    is_approved: true,
    two_factor_enabled: false,
    two_factor_verified: true,
  },
} as unknown as AuthenticatedRequest);

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as Record<string, unknown> | undefined,
    status(code: number) { res.statusCode = code; return res; },
    json(payload: Record<string, unknown>) { res.body = payload; return res; },
    cookie: vi.fn(),
    clearCookie: vi.fn(),
  };
  return res as unknown as Response & { body?: Record<string, unknown> };
};

type StaffProfile = {
  page_access: PageAccess;
  has_admin_access: boolean;
  staff_tab_role_edit: { dormitory: boolean; deductions: boolean };
  can_grant_staff_tabs: { dormitory: boolean; deductions: boolean };
};

const loadProfile = async () => {
  const res = makeRes();
  await authController.getMe(makeReq(), res);
  return res.body?.profile as StaffProfile;
};

const NONE = { dormitory: false, deductions: false };
const BOTH = { dormitory: true, deductions: true };

/** Ответы базы: галочки сотрудника 501 и ограничение админа по компании. */
const db = (opts: { grants?: string[]; companyRoots?: string[]; grantsFail?: boolean } = {}) => {
  pgQuery.mockImplementation((async (sql: string) => {
    const text = String(sql);
    if (text.includes('FROM employee_staff_tab_access')) {
      if (opts.grantsFail) throw new Error('relation does not exist');
      return (opts.grants ?? []).map(tab => ({ tab }));
    }
    if (text.includes('FROM user_company_access')) {
      return (opts.companyRoots ?? []).map(id => ({ company_root_id: id }));
    }
    return [];
  }) as never);
};

const HR_ADMIN_ROLE = {
  ...baseRole, id: 'role-hr-admin', code: 'hr_admin', is_admin: false, admin_access: true, manager_auto_access: true,
  all_departments_scope: true,
};
const SECURITY_ROLE = { ...baseRole, id: 'role-security', code: 'security', is_admin: false, admin_access: true, manager_auto_access: true };
const STAFF_TABS_EDIT: PageAccess = {
  '/staff-control/dormitory': { can_view: true, can_edit: true },
  '/staff-control/deductions': { can_view: true, can_edit: true },
};

beforeEach(() => {
  vi.clearAllMocks();
  db();
  pgQueryOne.mockResolvedValue(PROFILE_ROW);
  mocked.getRoleById.mockResolvedValue(OFFICE_ROLE);
  mocked.getRolePageAccess.mockResolvedValue({ '/employee': { can_view: true, can_edit: true } });
  mocked.hasPayrollSectionAccess.mockResolvedValue(false);
});

describe('/auth/me: галочки «Проживание»/«Удержания»', () => {
  it('офисный сотрудник без галочек — ни вкладок, ни входа в админку', async () => {
    const profile = await loadProfile();
    expect(profile.page_access['/staff-control/deductions']).toBeUndefined();
    expect(profile.has_admin_access).toBe(false);
    expect(profile.staff_tab_role_edit).toEqual(NONE);
    expect(profile.can_grant_staff_tabs).toEqual(NONE);
  });

  it('галочка «Удержания»: правка только этой вкладки и вход в админку; права по роли не появляются', async () => {
    db({ grants: ['deductions'] });
    const profile = await loadProfile();
    expect(profile.page_access).toEqual({
      '/employee': { can_view: true, can_edit: true },
      '/staff-control/deductions': { can_view: true, can_edit: true },
    });
    expect(profile.has_admin_access).toBe(true);
    expect(profile.staff_tab_role_edit).toEqual(NONE);
    expect(profile.can_grant_staff_tabs).toEqual(NONE);
  });

  it('роль с просмотром вкладки + галочка: правка вкладки есть, справочник видов по роли — нет', async () => {
    mocked.getRoleById.mockResolvedValue(SECURITY_ROLE);
    mocked.getRolePageAccess.mockResolvedValue({ '/staff-control/deductions': { can_view: true, can_edit: false } });
    db({ grants: ['deductions'] });
    const profile = await loadProfile();
    expect(profile.page_access['/staff-control/deductions']).toEqual({ can_view: true, can_edit: true });
    expect(profile.staff_tab_role_edit).toEqual(NONE);
  });

  it('база недоступна (таблица до миграции) — галочек нет, профиль отдаётся', async () => {
    db({ grantsFail: true });
    const profile = await loadProfile();
    expect(profile.page_access['/staff-control/deductions']).toBeUndefined();
    expect(profile.has_admin_access).toBe(false);
  });
});

describe('/auth/me: кто может ставить галочки', () => {
  it('администратор без ограничения по компании — обе вкладки', async () => {
    mocked.getRoleById.mockResolvedValue(ADMIN_ROLE);
    mocked.getRolePageAccess.mockResolvedValue({});
    const profile = await loadProfile();
    expect(profile.staff_tab_role_edit).toEqual(BOTH);
    expect(profile.can_grant_staff_tabs).toEqual(BOTH);
  });

  it('администратор с ограничением по компании — правит вкладки, но галочки не ставит', async () => {
    mocked.getRoleById.mockResolvedValue(ADMIN_ROLE);
    mocked.getRolePageAccess.mockResolvedValue({});
    db({ companyRoots: ['root-1'] });
    const profile = await loadProfile();
    expect(profile.staff_tab_role_edit).toEqual(BOTH);
    expect(profile.can_grant_staff_tabs).toEqual(NONE);
  });

  it('кадровый админ (правка в матрице, вся организация) — обе вкладки', async () => {
    mocked.getRoleById.mockResolvedValue(HR_ADMIN_ROLE);
    mocked.getRolePageAccess.mockResolvedValue(STAFF_TABS_EDIT);
    const profile = await loadProfile();
    expect(profile.staff_tab_role_edit).toEqual(BOTH);
    expect(profile.can_grant_staff_tabs).toEqual(BOTH);
  });

  it('правка в матрице без охвата «вся организация» — правит, но галочки не ставит', async () => {
    mocked.getRoleById.mockResolvedValue(SECURITY_ROLE);
    mocked.getRolePageAccess.mockResolvedValue(STAFF_TABS_EDIT);
    const profile = await loadProfile();
    expect(profile.staff_tab_role_edit).toEqual(BOTH);
    expect(profile.can_grant_staff_tabs).toEqual(NONE);
  });

  it('правка в матрице у роли без доступа в админку не считается — ключи режутся', async () => {
    mocked.getRoleById.mockResolvedValue({ ...OFFICE_ROLE, all_departments_scope: true });
    mocked.getRolePageAccess.mockResolvedValue(STAFF_TABS_EDIT);
    const profile = await loadProfile();
    expect(profile.staff_tab_role_edit).toEqual(NONE);
    expect(profile.can_grant_staff_tabs).toEqual(NONE);
  });

  it('галочки обеих вкладок не дают права их ставить', async () => {
    mocked.getRoleById.mockResolvedValue(HR_ROLE);
    db({ grants: ['dormitory', 'deductions'] });
    const profile = await loadProfile();
    expect(profile.page_access['/staff-control/dormitory']).toEqual({ can_view: true, can_edit: true });
    expect(profile.can_grant_staff_tabs).toEqual(NONE);
  });
});
