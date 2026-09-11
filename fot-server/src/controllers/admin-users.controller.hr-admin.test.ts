import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Работа кадрового админа с чужими учётными записями (миграция 270):
 *  - одобрение и отклонение доступны не только системному админу, но company-admin
 *    остаётся с прежним поведением (пустая очередь);
 *  - approve и reject атомарны: повторное одобрение и отклонение уже одобренного
 *    не проходят, включая гонку между проверкой и удалением;
 *  - выдать себе или коллеге админскую роль нельзя.
 */
const h = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
  getRoleByCode: vi.fn(),
  getUserById: vi.fn(),
  resolveCompanyScope: vi.fn(),
  logFromRequest: vi.fn(),
  hasPageEdit: vi.fn(),
  checkRoleAssignable: vi.fn(),
  checkTargetUserManageable: vi.fn(),
  hasOrgWideAccountAccess: vi.fn(),
  resolveAccessibleDepartmentIds: vi.fn(),
  updateUserById: vi.fn(),
}));

vi.mock('../services/blacklist.service.js', () => ({
  // Чёрный список пуст — проверяем, что поведение прежнее (миграция 273).
  findActive: vi.fn(async () => ({ strong: [], weak: [] })),
  assertNotBlacklisted: vi.fn(async () => ({ strong: [], weak: [] })),
  addEntryIn: vi.fn(async () => ({ entry: { id: 'b1' }, created: true })),
  withSigurProfileGuard: vi.fn(async (_id: number, action: () => Promise<unknown>) => action()),
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
vi.mock('../services/local-auth.service.js', () => ({
  localAuthService: { getUserById: h.getUserById, updateUserById: h.updateUserById },
}));
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: h.logFromRequest, log: vi.fn() },
}));
vi.mock('../services/data-scope.service.js', () => ({
  canAccessEmployeeInScope: vi.fn(),
  resolveAccessibleDepartmentIds: h.resolveAccessibleDepartmentIds,
  resolveCompanyScope: h.resolveCompanyScope,
}));
vi.mock('../services/access-control.service.js', () => ({ hasPageEdit: h.hasPageEdit }));
vi.mock('../services/org-wide-account-access.service.js', () => ({
  hasOrgWideAccountAccess: h.hasOrgWideAccountAccess,
}));
vi.mock('../services/assignable-roles.service.js', () => ({
  checkRoleAssignable: h.checkRoleAssignable,
  checkTargetUserManageable: h.checkTargetUserManageable,
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
import type { AuthenticatedRequest } from '../types/index.js';

const TARGET_ID = '3ffe0987-39b1-48b0-af45-2dddf8ccd907';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status: vi.fn((c: number) => { res.statusCode = c; return res; }),
    json: vi.fn((b: unknown) => { res.body = b; return res; }),
  };
  return res;
};

const makeReq = (user: Record<string, unknown>, body: Record<string, unknown> = {}): AuthenticatedRequest => ({
  user: { id: 'actor-1', is_admin: false, role_code: 'hr_admin', ...user },
  params: { id: TARGET_ID },
  body,
  ip: '127.0.0.1',
  headers: {},
  socket: {},
}) as unknown as AuthenticatedRequest;

const HR_ADMIN = { id: 'actor-1', is_admin: false, role_code: 'hr_admin' };
const COMPANY_ADMIN = { id: 'actor-2', is_admin: true, role_code: 'admin' };

beforeEach(() => {
  Object.values(h).forEach(fn => fn.mockReset());
  h.logFromRequest.mockResolvedValue(undefined);
  h.checkRoleAssignable.mockResolvedValue(null);
  h.checkTargetUserManageable.mockResolvedValue({ ok: true });
  h.hasPageEdit.mockResolvedValue(true);
  h.getRoleByCode.mockResolvedValue({
    id: 'role-1', code: 'worker', is_active: true, all_departments_scope: true,
  });
  h.getUserById.mockResolvedValue({ id: 'profile-1' });
  h.queryOne.mockResolvedValue({ id: 'profile-1' });
  h.query.mockResolvedValue([{ id: 'profile-1' }]);
  // Не системный админ: у кадрового админа company_scope пустой.
  h.resolveCompanyScope.mockResolvedValue({ roots: [] });
  h.resolveAccessibleDepartmentIds.mockResolvedValue('all');
  h.hasOrgWideAccountAccess.mockResolvedValue(false);
  h.updateUserById.mockResolvedValue(undefined);
});

describe('очередь заявок: кто её видит', () => {
  it('кадровый админ с флагом и edit на /admin/users — видит', async () => {
    const res = makeRes();
    await adminUsersController.getPendingUsers(makeReq(HR_ADMIN), res as never);
    expect(res.statusCode).toBe(200);
    expect(h.hasPageEdit).toHaveBeenCalledWith('hr_admin', '/admin/users');
  });

  it('company-admin по-прежнему получает пустой список — поведение не изменилось', async () => {
    h.resolveCompanyScope.mockResolvedValue({ roots: ['root-1'] });
    const res = makeRes();
    await adminUsersController.getPendingUsers(makeReq(COMPANY_ADMIN), res as never);
    expect(res.body).toEqual({ success: true, data: [] });
    // is_admin отсекается до проверки страниц: page-access он всё равно обходит.
    expect(h.hasPageEdit).not.toHaveBeenCalled();
  });

  it('роль без флага скоупа к очереди не допускается', async () => {
    h.getRoleByCode.mockResolvedValue({ code: 'office', all_departments_scope: false });
    const res = makeRes();
    await adminUsersController.getPendingUsers(makeReq({ role_code: 'office' }), res as never);
    expect(res.body).toEqual({ success: true, data: [] });
  });
});

describe('approveUser: атомарность и allowlist ролей', () => {
  it('повторное одобрение уже одобренного → 409, роль не меняется', async () => {
    // UPDATE ... AND is_approved = false не нашёл строк.
    h.query.mockResolvedValue([]);
    const res = makeRes();
    await adminUsersController.approveUser(makeReq(HR_ADMIN, { position_type: 'worker' }), res as never);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: 'Пользователь уже одобрен' });
  });

  it('UPDATE содержит условие is_approved = false', async () => {
    const res = makeRes();
    await adminUsersController.approveUser(makeReq(HR_ADMIN, { position_type: 'worker' }), res as never);
    const sql = String(h.query.mock.calls.at(-1)?.[0] ?? '');
    expect(sql).toContain('is_approved = false');
  });

  it('неназначаемая роль → 403 до любой записи', async () => {
    h.checkRoleAssignable.mockResolvedValue('Эта роль недоступна для назначения.');
    const res = makeRes();
    await adminUsersController.approveUser(makeReq(HR_ADMIN, { position_type: 'admin' }), res as never);
    expect(res.statusCode).toBe(403);
    expect(h.query).not.toHaveBeenCalled();
  });
});

describe('rejectUser: одна транзакция вместо чтения и удаления по отдельности', () => {
  const txReturning = (row: { is_approved: boolean } | null) => {
    const queries: string[] = [];
    h.withTransaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn({
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('is_approved')) {
          return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }
        return { rows: [], rowCount: 1 };
      },
    }));
    return queries;
  };

  it('заявка pending — удаляется, строка блокируется FOR UPDATE', async () => {
    const queries = txReturning({ is_approved: false });
    const res = makeRes();
    await adminUsersController.rejectUser(makeReq(HR_ADMIN), res as never);
    expect(res.statusCode).toBe(200);
    expect(queries[0]).toContain('FOR UPDATE');
    expect(queries.some(sql => sql.includes('DELETE FROM app_auth.users'))).toBe(true);
  });

  it('одобренный пользователь не удаляется через отклонение → 409', async () => {
    const queries = txReturning({ is_approved: true });
    const res = makeRes();
    await adminUsersController.rejectUser(makeReq(HR_ADMIN), res as never);
    expect(res.statusCode).toBe(409);
    expect(queries.some(sql => sql.includes('DELETE'))).toBe(false);
  });

  it('чужая админская учётка не отклоняется', async () => {
    h.checkTargetUserManageable.mockResolvedValue({ ok: false, status: 403, error: 'нельзя' });
    const res = makeRes();
    await adminUsersController.rejectUser(makeReq(HR_ADMIN), res as never);
    expect(res.statusCode).toBe(403);
    expect(h.withTransaction).not.toHaveBeenCalled();
  });
});

/**
 * Ключ /admin/users/accounts (роль «Отдел безопасности»): учётки всей организации
 * без all_departments_scope. Скоуп отделов у такой роли узкий, флага нет.
 */
describe('ключ /admin/users/accounts без глобального скоупа', () => {
  const SECURITY = { id: 'actor-3', is_admin: false, role_code: 'security' };

  beforeEach(() => {
    h.getRoleByCode.mockResolvedValue({ code: 'security', all_departments_scope: false });
    h.resolveAccessibleDepartmentIds.mockResolvedValue(['dept-own']);
    // Цель — новая регистрация без привязки к сотруднику.
    h.queryOne.mockResolvedValue({ id: 'profile-1', employee_id: null });
  });

  it('с ключом — одобрение регистрации проходит', async () => {
    h.hasOrgWideAccountAccess.mockResolvedValue(true);
    const res = makeRes();
    await adminUsersController.approveUser(makeReq(SECURITY, { position_type: 'contractor' }), res as never);
    expect(res.statusCode).not.toBe(403);
    expect(h.hasOrgWideAccountAccess).toHaveBeenCalledWith(expect.anything(), 'edit');
  });

  it('без ключа и без флага — одобрение 403', async () => {
    const res = makeRes();
    await adminUsersController.approveUser(makeReq(SECURITY, { position_type: 'contractor' }), res as never);
    expect(res.statusCode).toBe(403);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('с ключом — email подтверждается учётке без сотрудника (скоуп отделов не мешает)', async () => {
    h.hasOrgWideAccountAccess.mockResolvedValue(true);
    const res = makeRes();
    await adminUsersController.confirmUserEmail(makeReq(SECURITY), res as never);
    expect(res.statusCode).toBe(200);
    expect(h.updateUserById).toHaveBeenCalledWith(TARGET_ID, { emailConfirm: true });
  });

  it('без ключа — учётка без сотрудника вне скоупа → 403', async () => {
    const res = makeRes();
    await adminUsersController.confirmUserEmail(makeReq(SECURITY), res as never);
    expect(res.statusCode).toBe(403);
    expect(h.updateUserById).not.toHaveBeenCalled();
  });

  it('ключ не открывает админскую учётку: checkTargetUserManageable → 403', async () => {
    h.hasOrgWideAccountAccess.mockResolvedValue(true);
    h.checkTargetUserManageable.mockResolvedValue({ ok: false, status: 403, error: 'нельзя' });
    const res = makeRes();
    await adminUsersController.confirmUserEmail(makeReq(SECURITY), res as never);
    expect(res.statusCode).toBe(403);
    expect(h.updateUserById).not.toHaveBeenCalled();
  });

  it('ключ не открывает смену роли (/admin/users/access): скоуп отделов действует', async () => {
    h.hasOrgWideAccountAccess.mockResolvedValue(true);
    const res = makeRes();
    await adminUsersController.updateUserPosition(makeReq(SECURITY, { position_type: 'worker' }), res as never);
    expect(res.statusCode).toBe(403);
  });
});
