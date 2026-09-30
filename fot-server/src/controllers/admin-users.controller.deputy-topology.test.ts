import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Ручные назначения «Заместитель» проверяются правилом А (миграция 292, для любой роли):
 * отдел — лист без владельца табеля выше по дереву. Иначе подача отдела и личная подача
 * (или подача родителя) забрали бы одни и те же дни.
 *
 * Проверяются только НОВЫЕ строки 'deputy' по итоговому состоянию: «Начальник» родителя
 * в этом же сохранении — тоже владелец выше. Прежние строки сохранение не блокируют.
 */

const h = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
  resolveAccessibleDepartmentIds: vi.fn(),
  canAccessEmployeeInScope: vi.fn(),
  findViolations: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: h.queryOne,
  execute: h.execute,
  withTransaction: h.withTransaction,
}));
vi.mock('../config/contractor.js', () => ({
  getContractorRootId: vi.fn(),
  CONTRACTOR_ROOT_NAME: 'подрядные организации',
  isContractorSigurDryRun: () => false,
}));
vi.mock('../services/blacklist.service.js', () => ({
  findActive: vi.fn(),
  addEntryIn: vi.fn(),
  BlacklistBlockedError: class extends Error {},
}));
vi.mock('../services/user-profile-name.service.js', () => ({ syncProfileNameFromEmployee: vi.fn() }));
vi.mock('../services/roles-cache.service.js', () => ({ getRoleByCode: vi.fn(), getAllRoles: vi.fn() }));
vi.mock('../services/local-auth.service.js', () => ({ localAuthService: {} }));
vi.mock('../services/audit.service.js', () => ({ auditService: { logFromRequest: vi.fn(), log: vi.fn() } }));
vi.mock('../services/data-scope.service.js', () => ({
  hasGlobalDepartmentReadScope: vi.fn(async () => false),
  canAccessEmployeeInScope: h.canAccessEmployeeInScope,
  resolveAccessibleDepartmentIds: h.resolveAccessibleDepartmentIds,
  resolveCompanyScope: vi.fn(),
}));
vi.mock('../services/access-control.service.js', () => ({ hasPageEdit: vi.fn() }));
vi.mock('../services/org-wide-account-access.service.js', () => ({ hasOrgWideAccountAccess: vi.fn() }));
vi.mock('../services/assignable-roles.service.js', () => ({
  checkRoleAssignable: vi.fn(),
  checkTargetUserManageable: vi.fn(),
}));
vi.mock('../services/department-access.service.js', () => ({
  loadEmployeeManagerAssignmentMap: vi.fn(),
  loadDeputyAssignmentMap: vi.fn(),
  loadExplicitManagerAssignmentMap: vi.fn(),
  loadAssignedEmployeeMap: vi.fn(),
  replaceUserEmployeeAccess: vi.fn(),
  normalizeAccessLevel: (level: string) => level,
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
  loadEmployeeFullNamesMap: vi.fn(async () => new Map()),
  loadDepartmentNamesMap: vi.fn(async () => new Map()),
  loadUserFullName: vi.fn(async () => 'Сотрудник'),
}));
vi.mock('../socket/io-instance.js', () => ({ getIo: () => null }));
vi.mock('../services/deputy-role.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/deputy-role.service.js')>()),
  findDeputyTopologyViolations: h.findViolations,
}));

import { adminUsersController } from './admin-users.controller.js';
import type { AuthenticatedRequest } from '../types/index.js';

const EMPLOYEE_ID = 441;
const PARENT = '11111111-1111-4111-8111-111111111111';
const LEAF_A = '22222222-2222-4222-8222-222222222222';
const LEAF_B = '33333333-3333-4333-8333-333333333333';
const ROOT_WITH_CHILDREN = '44444444-4444-4444-8444-444444444444';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status: vi.fn((c: number) => { res.statusCode = c; return res; }),
    json: vi.fn((b: unknown) => { res.body = b; return res; }),
  };
  return res;
};

const makeReq = (params: Record<string, string>, body: Record<string, unknown>): AuthenticatedRequest => ({
  user: { id: 'actor-1', is_admin: true, role_code: 'admin' },
  params,
  body,
  headers: {},
}) as unknown as AuthenticatedRequest;

let currentDeputyRows: string[] = [];

beforeEach(() => {
  Object.values(h).forEach(fn => fn.mockReset());
  currentDeputyRows = [];
  h.resolveAccessibleDepartmentIds.mockResolvedValue('all');
  h.canAccessEmployeeInScope.mockResolvedValue(true);
  h.findViolations.mockResolvedValue([]);
  h.execute.mockResolvedValue(1);
  h.queryOne.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM user_profiles')) return { employee_id: EMPLOYEE_ID };
    if (sql.includes('FROM employees')) return { id: EMPLOYEE_ID, full_name: 'Сотрудник' };
    return null;
  });
  h.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM org_departments WHERE id = ANY')) {
      return (params[0] as string[]).map(id => ({ id }));
    }
    if (sql.includes("access_level = 'deputy'")) {
      return currentDeputyRows.map(department_id => ({ department_id }));
    }
    return [];
  });
});

type TEndpoint = 'employee' | 'user';
const call = async (endpoint: TEndpoint, body: Record<string, unknown>) => {
  const res = makeRes();
  if (endpoint === 'employee') {
    await adminUsersController.updateEmployeeDepartmentAccess(makeReq({ id: String(EMPLOYEE_ID) }, body), res as never);
  } else {
    await adminUsersController.updateUserDepartmentAccess(makeReq({ id: '9a0c9b1e-0000-4000-8000-000000000001' }, body), res as never);
  }
  return res;
};

describe.each<TEndpoint>(['employee', 'user'])('топология назначений «Заместитель» (%s)', (endpoint) => {
  it('отдел с подотделами — 409 с названием и причиной, назначения не пишутся', async () => {
    h.findViolations.mockResolvedValue([
      { department_id: ROOT_WITH_CHILDREN, department_name: 'Служба', reason: 'has_children', owner_department_name: null },
    ]);
    const res = await call(endpoint, {
      department_ids: [ROOT_WITH_CHILDREN],
      deputy_department_ids: [ROOT_WITH_CHILDREN],
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: 'DEPUTY_DEPARTMENT_TOPOLOGY' });
    expect(String((res.body as { error: string }).error)).toContain('«Служба» — есть подотделы');
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('лист под существующим владельцем — 409', async () => {
    h.findViolations.mockResolvedValue([
      { department_id: LEAF_A, department_name: 'Лист', reason: 'owner_above', owner_department_name: 'Родитель' },
    ]);
    const res = await call(endpoint, { department_ids: [LEAF_A], deputy_department_ids: [LEAF_A] });
    expect(res.statusCode).toBe(409);
    expect(String((res.body as { error: string }).error)).toContain('выше уже есть владелец табеля («Родитель»)');
  });

  it('«Начальник» родителя и «Заместитель» ребёнка в одном сохранении — проверяются по итоговому состоянию', async () => {
    await call(endpoint, { department_ids: [PARENT, LEAF_A], deputy_department_ids: [LEAF_A] });
    expect(h.findViolations).toHaveBeenCalledWith({
      employeeId: EMPLOYEE_ID,
      checkDepartmentIds: [LEAF_A],
      finalOwnedDepartmentIds: [PARENT, LEAF_A],
    });
  });

  it('«Только просмотр» владельцем не считается', async () => {
    await call(endpoint, {
      department_ids: [PARENT, LEAF_A],
      view_only_department_ids: [PARENT],
      deputy_department_ids: [LEAF_A],
    });
    expect(h.findViolations.mock.calls[0]![0]).toMatchObject({ finalOwnedDepartmentIds: [LEAF_A] });
  });

  it('два независимых листа — сохраняется', async () => {
    const res = await call(endpoint, { department_ids: [LEAF_A, LEAF_B], deputy_department_ids: [LEAF_A, LEAF_B] });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true });
    expect(h.execute).toHaveBeenCalled();
  });

  it('уже действующие строки «Заместитель» не перепроверяются', async () => {
    currentDeputyRows = [ROOT_WITH_CHILDREN];
    const res = await call(endpoint, {
      department_ids: [ROOT_WITH_CHILDREN, LEAF_A],
      deputy_department_ids: [ROOT_WITH_CHILDREN, LEAF_A],
    });
    expect(res.statusCode).toBe(200);
    expect(h.findViolations.mock.calls[0]![0]).toMatchObject({ checkDepartmentIds: [LEAF_A] });
  });

  it('без новых «Заместителей» проверка не зовётся', async () => {
    const res = await call(endpoint, { department_ids: [PARENT] });
    expect(res.statusCode).toBe(200);
    expect(h.findViolations).not.toHaveBeenCalled();
  });
});
