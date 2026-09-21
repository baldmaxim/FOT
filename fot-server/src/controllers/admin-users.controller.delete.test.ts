import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Удаление учётки: ошибка БД не должна выглядеть как «Failed to delete user».
 * FK/NOT NULL на удалении — это колонка вне политики миграции 284, и админу
 * нужно понятное 409, а не 500. Плюс надгробный профиль защищён от удаления:
 * без него ON DELETE SET DEFAULT начнёт нарушать FK.
 */
const h = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
  logFromRequest: vi.fn(),
  ensureCriticalAdminAccess: vi.fn(),
  checkTargetUserManageable: vi.fn(),
  resolveCompanyScope: vi.fn(),
  resolveAccessibleDepartmentIds: vi.fn(),
  canAccessEmployeeInScope: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: h.queryOne,
  execute: h.execute,
  withTransaction: h.withTransaction,
}));
vi.mock('../services/blacklist.service.js', () => ({
  findActive: vi.fn(async () => ({ strong: [], weak: [] })),
  assertNotBlacklisted: vi.fn(async () => ({ strong: [], weak: [] })),
  addEntryIn: vi.fn(),
  withSigurProfileGuard: vi.fn(),
  BlacklistBlockedError: class extends Error {},
}));
vi.mock('../services/user-profile-name.service.js', () => ({ syncProfileNameFromEmployee: vi.fn() }));
vi.mock('../services/roles-cache.service.js', () => ({
  getRoleByCode: vi.fn(),
  getAllRoles: vi.fn().mockResolvedValue([]),
}));
vi.mock('../services/local-auth.service.js', () => ({
  localAuthService: {
    getUserById: vi.fn(),
    createUser: vi.fn(),
    updateUser: vi.fn(),
    deleteUser: vi.fn(),
    listUsers: vi.fn(),
  },
}));
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: h.logFromRequest, log: vi.fn() },
}));
vi.mock('../services/data-scope.service.js', () => ({
  canAccessEmployeeInScope: h.canAccessEmployeeInScope,
  resolveAccessibleDepartmentIds: h.resolveAccessibleDepartmentIds,
  resolveCompanyScope: h.resolveCompanyScope,
  canWriteEmployeeInScope: h.canAccessEmployeeInScope,
}));
vi.mock('../services/department-access.service.js', () => ({
  loadEmployeeManagerAssignmentMap: vi.fn(),
  loadDeputyAssignmentMap: vi.fn(),
  loadExplicitManagerAssignmentMap: vi.fn(),
  loadAssignedEmployeeMap: vi.fn(),
  replaceUserEmployeeAccess: vi.fn(),
  normalizeAccessLevel: vi.fn(),
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
vi.mock('../services/critical-admin-access.service.js', () => ({
  ensureCriticalAdminAccess: h.ensureCriticalAdminAccess,
}));
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
vi.mock('../services/assignable-roles.service.js', () => ({
  checkRoleAssignable: vi.fn(async () => null),
  checkTargetUserManageable: h.checkTargetUserManageable,
}));
vi.mock('../services/access-control.service.js', () => ({ hasPageEdit: vi.fn(async () => true) }));
vi.mock('../services/org-wide-account-access.service.js', () => ({
  hasOrgWideAccountAccess: vi.fn(async () => true),
}));

import { adminUsersController } from './admin-users.controller.js';
import { TOMBSTONE_USER_ID } from '../config/system-users.js';
import type { AuthenticatedRequest } from '../types/index.js';

const TARGET_ID = '3ffe0987-39b1-48b0-af45-2dddf8ccd907';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null as { success: boolean; error?: string } | null,
    status: vi.fn((c: number) => { res.statusCode = c; return res; }),
    json: vi.fn((b: unknown) => { res.body = b as { success: boolean; error?: string }; return res; }),
  };
  return res;
};

const makeReq = (id: string): AuthenticatedRequest => ({
  user: { id: 'admin-1', is_admin: true },
  params: { id },
  body: {},
  query: {},
  ip: '127.0.0.1',
  headers: {},
  socket: {},
}) as unknown as AuthenticatedRequest;

/** Ошибка Postgres как её отдаёт драйвер pg. */
const pgError = (code: string, table: string): Error & { code: string; table: string } =>
  Object.assign(new Error(`${code} on ${table}`), { code, table });

describe('deleteUser — отказ вместо 500', () => {
  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    h.resolveCompanyScope.mockResolvedValue({ roots: 'all' });
    h.resolveAccessibleDepartmentIds.mockResolvedValue('all');
    h.checkTargetUserManageable.mockResolvedValue({ ok: true });
    h.ensureCriticalAdminAccess.mockResolvedValue(undefined);
    h.queryOne.mockResolvedValue({ id: TARGET_ID, employee_id: null });
    h.query.mockResolvedValue([]);
  });

  it('FK (23503) → 409 с названием раздела, а не 500 «Failed to delete user»', async () => {
    h.withTransaction.mockRejectedValue(pgError('23503', 'leave_requests'));
    const res = makeRes();

    await adminUsersController.deleteUser(makeReq(TARGET_ID), res as never);

    expect(res.statusCode).toBe(409);
    expect(res.body?.error).toContain('заявления');
    expect(res.body?.error).not.toContain('leave_requests');
    expect(h.logFromRequest).not.toHaveBeenCalled();
  });

  it('NOT NULL (23502) тоже даёт 409: SET NULL на обязательной колонке', async () => {
    h.withTransaction.mockRejectedValue(pgError('23502', 'contractor_submissions'));
    const res = makeRes();

    await adminUsersController.deleteUser(makeReq(TARGET_ID), res as never);

    expect(res.statusCode).toBe(409);
    expect(res.body?.error).toContain('подачи подрядчиков');
  });

  it('неизвестная таблица описывается обобщённо, сырое имя наружу не уходит', async () => {
    h.withTransaction.mockRejectedValue(pgError('23503', 'some_new_table'));
    const res = makeRes();

    await adminUsersController.deleteUser(makeReq(TARGET_ID), res as never);

    expect(res.statusCode).toBe(409);
    expect(res.body?.error).toContain('связанные записи');
    expect(res.body?.error).not.toContain('some_new_table');
  });

  it('прочие ошибки БД остаются 500, но с русским текстом', async () => {
    h.withTransaction.mockRejectedValue(Object.assign(new Error('boom'), { code: '08006' }));
    const res = makeRes();

    await adminUsersController.deleteUser(makeReq(TARGET_ID), res as never);

    expect(res.statusCode).toBe(500);
    expect(res.body?.error).toBe('Не удалось удалить пользователя');
  });

  it('надгробный профиль удалить нельзя — 400 и ни одного запроса в БД', async () => {
    const res = makeRes();

    await adminUsersController.deleteUser(makeReq(TOMBSTONE_USER_ID), res as never);

    expect(res.statusCode).toBe(400);
    expect(res.body?.error).toContain('Удалённый пользователь');
    expect(h.withTransaction).not.toHaveBeenCalled();
    expect(h.checkTargetUserManageable).not.toHaveBeenCalled();
  });

  it('успешное удаление пишет аудит', async () => {
    h.withTransaction.mockResolvedValue(undefined);
    const res = makeRes();

    await adminUsersController.deleteUser(makeReq(TARGET_ID), res as never);

    expect(res.statusCode).toBe(200);
    expect(h.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'admin-1', 'USER_DELETED',
      expect.objectContaining({ entityType: 'user', entityId: TARGET_ID }),
    );
  });
});
