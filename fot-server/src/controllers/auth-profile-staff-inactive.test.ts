/**
 * Статус «Неактивный» в точках входа (миграция 381):
 *  - право на кнопки (can_manage_staff_inactive) — в общем ответе профиля: и при входе, и в /auth/me; роль его не даёт;
 *  - вход неактивному закрыт (403 EMPLOYEE_INACTIVE), служебной учётке с login_when_staff_inactive — открыт;
 *  - /auth/refresh: блокировка проверяется ДО сверки версии токена — отозванный переводом токен даёт 403 с причиной,
 *    а после «Вернуть в активные» старый refresh — 401.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
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

const mocked = vi.hoisted(() => ({
  getRoleById: vi.fn(),
  verifyPassword: vi.fn(),
  verifyRefreshToken: vi.fn(),
}));

vi.mock('../services/roles-cache.service.js', () => ({
  getRoleById: mocked.getRoleById,
  getRoleByCode: vi.fn(),
}));
vi.mock('../services/access-control.service.js', () => ({
  getRolePageAccess: vi.fn(async () => ({})),
  listDeputyAutoAccessPages: () => [],
}));
vi.mock('../services/payroll/payroll-access.service.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/payroll/payroll-access.service.js')>(),
  hasPayrollSectionAccess: vi.fn(async () => false),
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
vi.mock('../services/local-auth.service.js', () => ({
  localAuthService: { verifyPassword: mocked.verifyPassword }, LocalAuthError: class extends Error {},
}));
vi.mock('../services/audit.service.js', () => ({ auditService: { log: vi.fn(), logFromRequest: vi.fn() } }));
vi.mock('../services/mailer.service.js', () => ({ mailerService: { send: vi.fn() } }));
vi.mock('../services/notification.service.js', () => ({ notificationService: { create: vi.fn() } }));
vi.mock('../services/push.service.js', () => ({ pushService: { send: vi.fn() } }));
vi.mock('../services/blacklist.service.js', () => ({ findActive: vi.fn(async () => ({ strong: [], weak: [] })) }));
vi.mock('./auth-2fa.controller.js', () => ({ verify2FA: vi.fn(), useRecoveryCode: vi.fn() }));
vi.mock('../utils/auth-session.js', () => ({
  clearSessionCookies: vi.fn(),
  generateAccessToken: vi.fn(() => 'access-token'),
  generateRefreshToken: vi.fn(() => 'refresh-token'),
  getRefreshTokenFromRequest: vi.fn(() => 'refresh-token-in'),
  resolveSessionEmail: vi.fn(async (_id: string, email: string) => email),
  setSessionCookies: vi.fn(),
  verifyRefreshToken: mocked.verifyRefreshToken,
}));

import { authController } from './auth.controller.js';

const ADMIN_ROLE = {
  id: 'role-admin', code: 'admin', name: 'Администратор', is_admin: true, admin_access: true, manager_auto_access: true,
  employee_variant: 'office', show_actual_hours: false, hide_sidebar: false, view_all_departments: false,
  timesheet_months_back: 1, timesheet_months_forward: 1, timesheet_show_full_period: true, weekend_memo_required: false,
  corrections_disable_object_entries: false,
};

const PROFILE = {
  id: 'a51b9047-273c-445f-bf7a-e186ced3f65d',
  full_name: 'Чепиков Павел Владимирович',
  system_role_id: 'role-admin',
  employee_id: 2063,
  supervisor_id: null,
  chat_inbound_mode: 'open',
  imported_position: null,
  is_approved: true,
  two_factor_enabled: false,
  token_version: 5,
  can_manage_staff_inactive: true,
  login_when_staff_inactive: false,
  created_at: '2026-01-01T00:00:00Z',
};

/** Ответы БД: строка профиля и строка статуса доступа (account-status). */
const db = (profile: Record<string, unknown>, access: Record<string, unknown>) => {
  pgQueryOne.mockImplementation((async (sql: string) => {
    const text = String(sql);
    if (text.includes('SELECT * FROM user_profiles')) return profile;
    if (text.includes('LEFT JOIN employees e ON e.id = up.employee_id')) {
      return { employment_status: 'active', staff_inactive: false, login_when_staff_inactive: false, is_disabled: false, token_version: profile.token_version, ...access };
    }
    return null;
  }) as never);
};

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as Record<string, unknown> | undefined,
    status(code: number) { res.statusCode = code; return res; },
    json(payload: Record<string, unknown>) { res.body = payload; return res; },
    cookie: vi.fn(),
    clearCookie: vi.fn(),
  };
  return res as unknown as Response & { statusCode: number; body?: Record<string, unknown> };
};

const loginReq = () => ({ body: { email: 'chepikov@su10.ru', password: 'secret-1' }, headers: {}, ip: '127.0.0.1', socket: {} } as unknown as Request);
const refreshReq = () => ({ body: {}, headers: {}, cookies: {}, ip: '127.0.0.1', socket: {} } as unknown as Request);

beforeEach(() => {
  vi.clearAllMocks();
  pgQuery.mockResolvedValue([] as never);
  mocked.getRoleById.mockResolvedValue(ADMIN_ROLE);
  mocked.verifyPassword.mockResolvedValue({ id: PROFILE.id, email: 'chepikov@su10.ru' });
  mocked.verifyRefreshToken.mockReturnValue({ sub: PROFILE.id, email: 'chepikov@su10.ru', token_type: 'refresh', token_version: 5 });
});

describe('право на кнопки в профиле', () => {
  it('ответ входа сразу несёт can_manage_staff_inactive — фронт не ждёт /auth/me', async () => {
    db(PROFILE, {});
    const res = makeRes();
    await authController.login(loginReq(), res);
    expect(res.statusCode).toBe(200);
    expect((res.body?.profile as Record<string, unknown>).can_manage_staff_inactive).toBe(true);
  });

  it('/auth/me: флаг учётки, а не роль — другой администратор права не получает', async () => {
    db({ ...PROFILE, can_manage_staff_inactive: false }, {});
    const res = makeRes();
    await authController.getMe({ user: { id: PROFILE.id, email: 'x@y.z', two_factor_verified: true } } as unknown as AuthenticatedRequest, res);
    expect((res.body?.profile as Record<string, unknown>).can_manage_staff_inactive).toBe(false);
  });
});

describe('вход и обновление сессии неактивного', () => {
  it('login: неактивный — 403 EMPLOYEE_INACTIVE; служебная учётка — входит', async () => {
    db(PROFILE, { staff_inactive: true });
    let res = makeRes();
    await authController.login(loginReq(), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'EMPLOYEE_INACTIVE' });

    db(PROFILE, { staff_inactive: true, login_when_staff_inactive: true });
    res = makeRes();
    await authController.login(loginReq(), res);
    expect(res.statusCode).toBe(200);
  });

  it('refresh: токен отозван переводом — 403 с причиной, а не 401', async () => {
    db({ ...PROFILE, token_version: 6 }, { staff_inactive: true, token_version: 6 });
    const res = makeRes();
    await authController.refresh(refreshReq(), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'EMPLOYEE_INACTIVE' });
  });

  it('refresh после «Вернуть в активные»: старый токен — 401, прежняя сессия не восстанавливается', async () => {
    db({ ...PROFILE, token_version: 6 }, { staff_inactive: false, token_version: 6 });
    const res = makeRes();
    await authController.refresh(refreshReq(), res);
    expect(res.statusCode).toBe(401);
  });

  it('refresh с актуальной версией у работающего — новая сессия', async () => {
    db(PROFILE, {});
    const res = makeRes();
    await authController.refresh(refreshReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, access_token: 'access-token' });
  });
});
