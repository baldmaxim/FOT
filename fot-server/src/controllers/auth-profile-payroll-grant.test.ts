/**
 * /auth/me и персональный доступ к «Зарплате» (миграция 288).
 *
 * Зеркало ветки resolveEffectivePageAccess: без ключа в page_access фронт не покажет пункт
 * «Зарплата». Объединение с правом роли — через OR. Вход в админку (has_admin_access)
 * получает и сотрудник на роли только с личным кабинетом, но админ-ключи самой роли
 * по-прежнему режутся по флагу роли.
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
}));

vi.mock('../services/roles-cache.service.js', () => ({
  getRoleById: mocked.getRoleById,
  getRoleByCode: vi.fn(),
}));
vi.mock('../services/access-control.service.js', () => ({
  getRolePageAccess: mocked.getRolePageAccess,
  listDeputyAutoAccessPages: () => [],
}));
vi.mock('../services/payroll/payroll-access.service.js', () => ({
  PAYROLL_GRANT_PAGE: '/salary/terms',
  getPayrollAccessLevel: mocked.getPayrollAccessLevel,
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

const loadProfile = async () => {
  const res = makeRes();
  await authController.getMe(makeReq(), res);
  return res.body?.profile as { page_access: PageAccess; has_admin_access: boolean };
};

beforeEach(() => {
  vi.clearAllMocks();
  pgQueryOne.mockResolvedValue(PROFILE_ROW);
  mocked.getRoleById.mockResolvedValue(OFFICE_ROLE);
  mocked.getRolePageAccess.mockResolvedValue({ '/employee': { can_view: true, can_edit: true } });
  mocked.getPayrollAccessLevel.mockResolvedValue(null);
});

describe('/auth/me: персональный доступ к «Зарплате»', () => {
  it('без гранта у офисного сотрудника нет ни «Зарплаты», ни входа в админку', async () => {
    const profile = await loadProfile();
    expect(profile.page_access['/salary/terms']).toBeUndefined();
    expect(profile.has_admin_access).toBe(false);
  });

  it('«Просмотр»: /salary/terms только на чтение и вход в админку', async () => {
    mocked.getPayrollAccessLevel.mockResolvedValue('view');
    const profile = await loadProfile();
    expect(mocked.getPayrollAccessLevel).toHaveBeenCalledWith(501);
    expect(profile.page_access['/salary/terms']).toEqual({ can_view: true, can_edit: false });
    expect(profile.has_admin_access).toBe(true);
  });

  it('«Редактирование»: /salary/terms на запись; будущие ключи раздела не появляются', async () => {
    mocked.getPayrollAccessLevel.mockResolvedValue('edit');
    const profile = await loadProfile();
    expect(profile.page_access['/salary/terms']).toEqual({ can_view: true, can_edit: true });
    expect(profile.page_access['/salary/payments']).toBeUndefined();
    expect(profile.page_access['/salary/sick-leaves']).toBeUndefined();
  });

  it('админ-ключи роли без доступа в админку режутся и при гранте', async () => {
    mocked.getPayrollAccessLevel.mockResolvedValue('view');
    mocked.getRolePageAccess.mockResolvedValue({
      '/employee': { can_view: true, can_edit: true },
      '/employees': { can_view: true, can_edit: true },
    });
    const profile = await loadProfile();
    expect(profile.page_access['/employees']).toBeUndefined();
    expect(profile.page_access['/salary/terms']).toEqual({ can_view: true, can_edit: false });
  });

  it('персональный «Просмотр» не понижает ролевую правку (OR)', async () => {
    mocked.getRoleById.mockResolvedValue(HR_ROLE);
    mocked.getRolePageAccess.mockResolvedValue({ '/salary/terms': { can_view: true, can_edit: true } });
    mocked.getPayrollAccessLevel.mockResolvedValue('view');
    const profile = await loadProfile();
    expect(profile.page_access['/salary/terms']).toEqual({ can_view: true, can_edit: true });
  });

  it('администратору грант не читаем', async () => {
    mocked.getRoleById.mockResolvedValue(ADMIN_ROLE);
    mocked.getPayrollAccessLevel.mockResolvedValue('view');
    const profile = await loadProfile();
    expect(mocked.getPayrollAccessLevel).not.toHaveBeenCalled();
    expect(profile.has_admin_access).toBe(true);
  });
});
