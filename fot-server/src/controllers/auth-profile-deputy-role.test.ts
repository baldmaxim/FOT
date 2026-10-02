/**
 * /auth/me и роль «Заместитель» (deputy_head, миграция 292).
 *
 * Страницы роли — только из её матрицы: авто-страницы назначения 'deputy' в профиль не
 * подмешиваются. Список отделов — ручные full/view и заместительские отделы по правилу А
 * (ровно серверный скоуп). Без единого отдела разделы табеля, заявлений и заявок на поиск
 * из page_access убираются — зеркало гейта resolveEffectivePageAccess.
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
  getPayrollAccessLevel: vi.fn(async (): Promise<'view' | 'edit' | null> => null),
  listManaged: vi.fn(async () => [] as string[]),
  listNonDeputy: vi.fn(async () => [] as string[]),
  hasDeputyAssignment: vi.fn(async () => false),
  deputyHead: vi.fn(async () => [] as string[]),
}));

vi.mock('../services/roles-cache.service.js', () => ({
  getRoleById: mocked.getRoleById,
  getRoleByCode: vi.fn(),
}));
vi.mock('../services/access-control.service.js', () => ({
  getRolePageAccess: mocked.getRolePageAccess,
  // Авто-страницы назначения deputy: роли их подмешивать нельзя.
  listDeputyAutoAccessPages: () => [
    ['/timesheet', { can_view: true, can_edit: true }],
    ['/leave-requests', { can_view: true, can_edit: true }],
    ['/staff-control/hiring', { can_view: true, can_edit: false }],
  ],
  DEPUTY_ROLE_DEPARTMENT_PAGES: new Set(['/timesheet', '/timesheet-hr', '/leave-requests', '/staff-control/hiring']),
}));
vi.mock('../services/payroll/payroll-access.service.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/payroll/payroll-access.service.js')>(),
  getPayrollAccessLevel: mocked.getPayrollAccessLevel,
}));
vi.mock('../services/department-access.service.js', () => ({
  listManagedDepartmentIdsForUser: mocked.listManaged,
  listNonDeputyDepartmentIdsForUser: mocked.listNonDeputy,
  hasActiveDeputyAssignment: mocked.hasDeputyAssignment,
}));
vi.mock('../services/deputy-role.service.js', () => ({
  isDeputyRole: (code: string | null | undefined) => code === 'deputy_head',
  loadDeputyHeadDepartmentIds: mocked.deputyHead,
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

const DEPUTY_ROLE = { ...baseRole, id: 'role-deputy', code: 'deputy_head', is_admin: false, admin_access: true, manager_auto_access: false };
const SECURITY_ROLE = { ...baseRole, id: 'role-security', code: 'security', is_admin: false, admin_access: true, manager_auto_access: false };

const ROLE_DEPT = 'aaaaaaaa-0000-4000-8000-000000000001';
const MANUAL_DEPT = 'bbbbbbbb-0000-4000-8000-000000000002';
const FULL_DEPT = 'cccccccc-0000-4000-8000-000000000003';

const PROFILE_ROW = {
  id: 'user-1',
  full_name: 'Заместитель З.З.',
  system_role_id: 'role-deputy',
  employee_id: 501,
  supervisor_id: null,
  chat_inbound_mode: 'open',
  imported_position: null,
  is_approved: true,
  created_at: '2026-01-01T00:00:00Z',
};

const MATRIX: PageAccess = {
  '/employee': { can_view: true, can_edit: false },
  '/timesheet': { can_view: true, can_edit: false },
  '/leave-requests': { can_view: true, can_edit: true },
  '/staff-control/hiring': { can_view: true, can_edit: false },
};

const makeReq = (): AuthenticatedRequest => ({
  params: {}, query: {}, body: {},
  user: {
    id: 'user-1',
    email: 'deputy@example.com',
    role_code: 'deputy_head',
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

type TProfile = { page_access: PageAccess; has_admin_access: boolean; managed_department_ids: string[] };
const loadProfile = async (): Promise<TProfile> => {
  const res = makeRes();
  await authController.getMe(makeReq(), res);
  return res.body?.profile as TProfile;
};

beforeEach(() => {
  vi.clearAllMocks();
  pgQueryOne.mockResolvedValue(PROFILE_ROW);
  mocked.getRoleById.mockResolvedValue(DEPUTY_ROLE);
  mocked.getRolePageAccess.mockResolvedValue({ ...MATRIX });
  mocked.getPayrollAccessLevel.mockResolvedValue(null);
  mocked.listManaged.mockResolvedValue([]);
  mocked.listNonDeputy.mockResolvedValue([]);
  mocked.hasDeputyAssignment.mockResolvedValue(true);
  mocked.deputyHead.mockResolvedValue([ROLE_DEPT]);
});

describe('/auth/me: роль «Заместитель»', () => {
  it('отделы — ручные full/view ∪ заместительские по правилу А; вход в админку по роли', async () => {
    mocked.listNonDeputy.mockResolvedValue([FULL_DEPT]);
    mocked.deputyHead.mockResolvedValue([ROLE_DEPT, MANUAL_DEPT]);
    const profile = await loadProfile();
    expect(new Set(profile.managed_department_ids)).toEqual(new Set([FULL_DEPT, ROLE_DEPT, MANUAL_DEPT]));
    expect(mocked.listManaged).not.toHaveBeenCalled();
    expect(mocked.deputyHead).toHaveBeenCalledWith(501);
    expect(profile.has_admin_access).toBe(true);
  });

  it('страницы — только матрица: назначение deputy не поднимает «Табель» до правки', async () => {
    const profile = await loadProfile();
    expect(profile.page_access['/timesheet']).toEqual({ can_view: true, can_edit: false });
    expect(profile.page_access['/staff-control/hiring']).toEqual({ can_view: true, can_edit: false });
  });

  it('без единого отдела разделы роли убраны, личный кабинет остался', async () => {
    mocked.deputyHead.mockResolvedValue([]);
    const profile = await loadProfile();
    expect(profile.managed_department_ids).toEqual([]);
    expect(profile.page_access['/timesheet']).toBeUndefined();
    expect(profile.page_access['/leave-requests']).toBeUndefined();
    expect(profile.page_access['/staff-control/hiring']).toBeUndefined();
    expect(profile.page_access['/employee']).toEqual({ can_view: true, can_edit: false });
  });

  it('свой отдел не прошёл правило А, но есть допустимый ручной — разделы открыты', async () => {
    mocked.deputyHead.mockResolvedValue([MANUAL_DEPT]);
    const profile = await loadProfile();
    expect(profile.managed_department_ids).toEqual([MANUAL_DEPT]);
    expect(profile.page_access['/timesheet']).toBeDefined();
  });

  it('другие роли — как раньше: назначение deputy подмешивает страницы', async () => {
    mocked.getRoleById.mockResolvedValue(SECURITY_ROLE);
    mocked.listManaged.mockResolvedValue([MANUAL_DEPT]);
    mocked.getRolePageAccess.mockResolvedValue({ '/timesheet': { can_view: true, can_edit: false } });
    const profile = await loadProfile();
    expect(profile.managed_department_ids).toEqual([MANUAL_DEPT]);
    expect(profile.page_access['/timesheet']).toEqual({ can_view: true, can_edit: true });
    expect(mocked.deputyHead).not.toHaveBeenCalled();
  });
});
