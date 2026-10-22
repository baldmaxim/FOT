import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Поиск по ФИО в админке: «Все пользователи» (ФИО или email; опечатка — только в ФИО и только если точного нет
 * ни у одной роли — счётчики ролей и список одним режимом) и подсказки сотрудников (/admin/employees/search).
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
  hasGlobalDepartmentReadScope: vi.fn(async () => false),
  canAccessEmployeeInScope: vi.fn(),
  resolveAccessibleDepartmentIds: h.resolveAccessibleDepartmentIds,
  resolveCompanyScope: h.resolveCompanyScope,
  canWriteEmployeeInScope: vi.fn(),
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

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status: vi.fn((c: number) => { res.statusCode = c; return res; }),
    json: vi.fn((b: unknown) => { res.body = b; return res; }),
  };
  return res;
};

const makeReq = (query: Record<string, string>): AuthenticatedRequest => ({
  user: { id: 'actor-1', is_admin: true, role_code: 'admin' },
  params: {},
  query,
  body: {},
  ip: '127.0.0.1',
  headers: {},
  socket: {},
}) as unknown as AuthenticatedRequest;

beforeEach(() => {
  Object.values(h).forEach(fn => fn.mockReset());
  h.resolveAccessibleDepartmentIds.mockResolvedValue('all');
  h.hasOrgWideAccountAccess.mockResolvedValue(false);
  h.query.mockResolvedValue([]);
});

const sqlOf = (call: unknown[] | undefined) => String(call?.[0] ?? '');

describe('«Все пользователи» — поиск', () => {
  it('точное есть хоть у одной роли — счётчики и список без опечаток; email — прежним ILIKE', async () => {
    h.queryOne.mockResolvedValue({ found: true });
    const res = makeRes();
    await adminUsersController.getAllUsers(makeReq({ page: '1', search: 'гринев', role: 'worker' }), res as never);
    expect(res.statusCode).toBe(200);
    const existsSql = sqlOf(h.queryOne.mock.calls[0]);
    expect(existsSql).toContain('SELECT EXISTS');
    // Решение — по базе без фильтра роли.
    expect(existsSql).not.toContain('system_role_id');
    const roleCountsSql = sqlOf(h.query.mock.calls[0]);
    expect(roleCountsSql).toContain('(up.full_name ~* $');
    expect(roleCountsSql).toContain('email ILIKE $');
    expect(roleCountsSql).not.toContain('unnest(');
  });

  it('точного нет ни у одной роли — и счётчики, и список с одной ошибкой', async () => {
    h.queryOne.mockResolvedValue({ found: false });
    await adminUsersController.getAllUsers(makeReq({ page: '1', search: 'грнев' }), makeRes() as never);
    const sqls = h.query.mock.calls.map(call => sqlOf(call)).filter(sql => sql.includes('FROM user_profiles up'));
    expect(sqls.length).toBeGreaterThanOrEqual(2);
    for (const sql of sqls) expect(sql).toContain('up.full_name ~* ANY(');
  });

  it('короче 5 букв — без проверки и без опечаток', async () => {
    await adminUsersController.getAllUsers(makeReq({ page: '1', search: 'гри' }), makeRes() as never);
    expect(h.queryOne).not.toHaveBeenCalled();
    expect(sqlOf(h.query.mock.calls[0])).toContain('(up.full_name ~* $');
  });
});

describe('/admin/employees/search — подсказки', () => {
  it('точного нет — второй запрос с одной ошибкой; скоуп — внутри запроса', async () => {
    h.resolveAccessibleDepartmentIds.mockResolvedValue(['d1']);
    h.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 7, full_name: 'Гринёв Андрей', org_department_id: 'd1' }]);
    const res = makeRes();
    await adminUsersController.searchUnlinkedEmployees(makeReq({ q: 'грнев', include_linked: 'true' }), res as never);
    expect((res.body as { data: Array<{ id: number }> }).data.map(e => e.id)).toEqual([7]);
    const [exactSql, exactParams] = h.query.mock.calls[0] as [string, unknown[]];
    expect(exactSql).toContain('org_department_id = ANY($1::uuid[])');
    expect(exactSql).toContain('(full_name ~* $2)');
    expect(exactParams).toEqual([['d1'], 'грн[её]в']);
    expect(sqlOf(h.query.mock.calls[1])).toContain('id IN (SELECT fz.id FROM unnest($2::text[])');
  });

  it('раскладка: «uhbyt» ищется и как «грине»', async () => {
    h.query.mockResolvedValue([{ id: 7, full_name: 'Гринёв Андрей', org_department_id: null }]);
    await adminUsersController.searchUnlinkedEmployees(makeReq({ q: 'uhbyt', include_linked: 'true' }), makeRes() as never);
    expect(h.query.mock.calls[0][1]).toEqual(['uhbyt', 'грин[её]']);
  });
});
