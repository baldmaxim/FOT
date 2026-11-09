import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * PATCH /admin/users/:id/email — права как у правки ФИО: системный админ меняет
 * почту любой учётке, кадровый админ — только не-админским. Проверка
 * checkTargetUserManageable — настоящая (assignable-roles.service), сервис смены замокан.
 */
const h = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
  getRoleByCode: vi.fn(),
  hasOrgWideAccountAccess: vi.fn(),
  resolveAccessibleDepartmentIds: vi.fn(),
  changeAccountEmail: vi.fn(),
}));

vi.mock('../services/account-email.service.js', async () => {
  const actual = await vi.importActual<typeof import('../services/account-email.service.js')>(
    '../services/account-email.service.js',
  );
  return { AccountEmailError: actual.AccountEmailError, changeAccountEmail: h.changeAccountEmail };
});
vi.mock('../services/blacklist.service.js', () => ({
  findActive: vi.fn(async () => ({ strong: [], weak: [] })),
  assertNotBlacklisted: vi.fn(async () => ({ strong: [], weak: [] })),
  addEntryIn: vi.fn(),
  withSigurProfileGuard: vi.fn(),
  BlacklistBlockedError: class extends Error {},
}));
vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: h.queryOne,
  execute: h.execute,
  withTransaction: h.withTransaction,
}));
vi.mock('../services/user-profile-name.service.js', () => ({ syncProfileNameFromEmployee: vi.fn() }));
vi.mock('../services/roles-cache.service.js', () => ({
  getRoleByCode: h.getRoleByCode,
  getAllRoles: vi.fn().mockResolvedValue([]),
}));
vi.mock('../services/local-auth.service.js', () => ({ localAuthService: { getUserById: vi.fn() } }));
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: vi.fn(), log: vi.fn() },
}));
vi.mock('../services/data-scope.service.js', () => ({
  hasGlobalDepartmentReadScope: vi.fn(async () => false),
  canAccessEmployeeInScope: vi.fn(),
  resolveAccessibleDepartmentIds: h.resolveAccessibleDepartmentIds,
  resolveCompanyScope: vi.fn(),
  canWriteEmployeeInScope: vi.fn(),
}));
vi.mock('../services/access-control.service.js', () => ({ hasPageEdit: vi.fn() }));
vi.mock('../services/org-wide-account-access.service.js', () => ({
  hasOrgWideAccountAccess: h.hasOrgWideAccountAccess,
}));
vi.mock('../services/department-access.service.js', () => ({
  loadEmployeeManagerAssignmentMap: vi.fn(async () => new Map()),
  loadExplicitManagerAssignmentMap: vi.fn(),
  loadAssignedEmployeeMap: vi.fn(),
  replaceUserEmployeeAccess: vi.fn(),
}));
vi.mock('../services/employee-skud-object-access.service.js', () => ({
  listObjectIdsForEmployee: vi.fn(),
  replaceEmployeeObjectAccess: vi.fn(),
}));
vi.mock('../services/skud-presence-by-object.service.js', () => ({ invalidatePresenceByObjectCache: vi.fn() }));
vi.mock('../services/skud-dashboard.service.js', () => ({ invalidateDashboardCache: vi.fn() }));
vi.mock('../services/scope-cache.service.js', () => ({
  invalidateDepartmentScopeCaches: vi.fn(),
  invalidateGlobalReadScopeCaches: vi.fn(),
}));
vi.mock('../services/critical-admin-access.service.js', () => ({ ensureCriticalAdminAccess: vi.fn() }));
vi.mock('../services/notification.service.js', () => ({ notificationService: { createMany: vi.fn() } }));
vi.mock('../services/push.service.js', () => ({ pushService: { sendGenericNotification: vi.fn() } }));
vi.mock('../services/employee-direct-reports.service.js', () => ({ getActiveDirectManagersFor: vi.fn() }));
vi.mock('../services/approval-routing.service.js', () => ({ listFullManagersForDepartments: vi.fn() }));
vi.mock('../services/audit-context.helpers.js', () => ({
  loadEmployeeFullNamesMap: vi.fn(),
  loadDepartmentNamesMap: vi.fn(),
  loadUserFullName: vi.fn(),
}));
vi.mock('../socket/io-instance.js', () => ({ getIo: () => null }));

import { adminUsersController } from './admin-users.controller.js';
import { AccountEmailError } from '../services/account-email.service.js';
import { TOMBSTONE_USER_ID } from '../config/system-users.js';
import type { AuthenticatedRequest } from '../types/index.js';

const TARGET_ID = '3ffe0987-39b1-48b0-af45-2dddf8ccd907';
const SYSTEM_ADMIN = { id: 'actor-admin', is_admin: true, role_code: 'admin' };
const HR_ADMIN = { id: 'actor-hr', is_admin: false, role_code: 'hr_admin' };

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status: vi.fn((c: number) => { res.statusCode = c; return res; }),
    json: vi.fn((b: unknown) => { res.body = b; return res; }),
  };
  return res;
};

const call = async (user: Record<string, unknown>, body: Record<string, unknown>, id = TARGET_ID) => {
  const req = {
    user, params: { id }, body, ip: '127.0.0.1', headers: {}, socket: {},
  } as unknown as AuthenticatedRequest;
  const res = makeRes();
  await adminUsersController.updateUserEmail(req, res as never);
  return res;
};

/** Роль целевой учётки для checkTargetUserManageable. */
const targetRole = (code: string, extra: Record<string, unknown> = {}) => {
  h.queryOne.mockResolvedValue({ role_code: code });
  h.getRoleByCode.mockResolvedValue({ code, is_admin: false, all_departments_scope: false, ...extra });
};

const OK_RESULT = { unchanged: false, email: 'new@su10.ru', emailConfirmed: true, cardUpdated: false, allowlistUpdated: false };

beforeEach(() => {
  Object.values(h).forEach(fn => fn.mockReset());
  // Скоуп учёток всей организации: проверяем именно гейт по роли цели.
  h.hasOrgWideAccountAccess.mockResolvedValue(true);
  h.changeAccountEmail.mockResolvedValue(OK_RESULT);
});

describe('updateUserEmail: права', () => {
  it('системный админ меняет почту админской учётке', async () => {
    targetRole('admin', { is_admin: true });
    const res = await call(SYSTEM_ADMIN, { email: ' New@SU10.ru ' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: OK_RESULT });
    expect(h.changeAccountEmail).toHaveBeenCalledWith(expect.objectContaining({
      userId: TARGET_ID, newEmail: 'new@su10.ru', actorId: 'actor-admin',
    }));
  });

  it('кадровый админ и админская учётка → 403, почта не меняется', async () => {
    targetRole('admin', { is_admin: true });
    const res = await call(HR_ADMIN, { email: 'new@su10.ru' });
    expect(res.statusCode).toBe(403);
    expect(h.changeAccountEmail).not.toHaveBeenCalled();
  });

  it('кадровый админ и обычная учётка → 200', async () => {
    targetRole('worker');
    const res = await call(HR_ADMIN, { email: 'new@su10.ru' });
    expect(res.statusCode).toBe(200);
    expect(h.changeAccountEmail).toHaveBeenCalledTimes(1);
  });

  it('учётка вне скоупа отделов → 403, почта не меняется', async () => {
    h.hasOrgWideAccountAccess.mockResolvedValue(false);
    h.resolveAccessibleDepartmentIds.mockResolvedValue(['dept-1']);
    h.queryOne.mockResolvedValue({ employee_id: null });
    const res = await call(HR_ADMIN, { email: 'new@su10.ru' });
    expect(res.statusCode).toBe(403);
    expect(h.changeAccountEmail).not.toHaveBeenCalled();
  });

  it('надгробная учётка → 400', async () => {
    const res = await call(SYSTEM_ADMIN, { email: 'new@su10.ru' }, TOMBSTONE_USER_ID);
    expect(res.statusCode).toBe(400);
    expect(h.changeAccountEmail).not.toHaveBeenCalled();
  });
});

describe('updateUserEmail: ввод и ошибки сервиса', () => {
  it('не почта → 400', async () => {
    const res = await call(SYSTEM_ADMIN, { email: 'не почта' });
    expect(res.statusCode).toBe(400);
    expect(h.changeAccountEmail).not.toHaveBeenCalled();
  });

  it.each([
    ['DUPLICATE_EMAIL', 409],
    ['BLACKLISTED', 409],
    ['NOT_FOUND', 404],
  ] as const)('%s → %i с текстом причины', async (code, status) => {
    targetRole('worker');
    h.changeAccountEmail.mockRejectedValue(new AccountEmailError('причина', code));
    const res = await call(SYSTEM_ADMIN, { email: 'new@su10.ru' });
    expect(res.statusCode).toBe(status);
    expect(res.body).toEqual({ success: false, error: 'причина' });
  });

  it('прочая ошибка → 500', async () => {
    targetRole('worker');
    h.changeAccountEmail.mockRejectedValue(new Error('db down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await call(SYSTEM_ADMIN, { email: 'new@su10.ru' });
    spy.mockRestore();
    expect(res.statusCode).toBe(500);
  });
});
