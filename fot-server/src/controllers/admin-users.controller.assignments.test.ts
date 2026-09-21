import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Экран «Назначения сотрудников» (GET /api/admin/employees/department-access).
 *
 * Прежний LIMIT 10000 упирался в реальные ~10.9k активных и молча срезал хвост
 * алфавита: 176 штатных сотрудников и 10 их назначений на экран не попадали.
 * Лимит поднят до 50000 и стал страховкой, а ветка «Подрядные организации» из
 * выдачи не режется — она помечается флагом is_contractor и фильтруется клиентом,
 * иначе выданный подрядчику доступ нечем было бы отозвать.
 */
const h = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
  resolveAccessibleDepartmentIds: vi.fn(),
  getContractorRootId: vi.fn(),
  loadEmployeeManagerAssignmentMap: vi.fn(),
  getActiveDirectManagersFor: vi.fn(),
  listFullManagersForDepartments: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: h.queryOne,
  execute: h.execute,
  withTransaction: h.withTransaction,
}));
vi.mock('../config/contractor.js', () => ({
  getContractorRootId: h.getContractorRootId,
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
  canAccessEmployeeInScope: vi.fn(),
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
  loadEmployeeManagerAssignmentMap: h.loadEmployeeManagerAssignmentMap,
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
vi.mock('../services/critical-admin-access.service.js', () => ({ ensureCriticalAdminAccess: vi.fn() }));
vi.mock('../services/notification.service.js', () => ({ notificationService: { createMany: vi.fn() } }));
vi.mock('../services/push.service.js', () => ({ pushService: { sendGenericNotification: vi.fn() } }));
vi.mock('../services/employee-direct-reports.service.js', () => ({
  getActiveDirectManagersFor: h.getActiveDirectManagersFor,
}));
vi.mock('../services/approval-routing.service.js', () => ({
  listFullManagersForDepartments: h.listFullManagersForDepartments,
}));
vi.mock('../services/audit-context.helpers.js', () => ({
  loadEmployeeFullNamesMap: vi.fn(),
  loadDepartmentNamesMap: vi.fn(),
  loadUserFullName: vi.fn(),
}));
vi.mock('../socket/io-instance.js', () => ({ getIo: () => null }));

import { adminUsersController } from './admin-users.controller.js';
import type { AuthenticatedRequest } from '../types/index.js';

const CONTRACTOR_ROOT = '44444444-4444-4444-4444-444444444444';
const STAFF_DEPT = '11111111-1111-1111-1111-111111111111';
const CONTRACTOR_DEPT = '22222222-2222-2222-2222-222222222222';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status: vi.fn((c: number) => { res.statusCode = c; return res; }),
    json: vi.fn((b: unknown) => { res.body = b; return res; }),
  };
  return res;
};

const makeReq = (): AuthenticatedRequest => ({
  user: { id: 'actor-1', is_admin: true, role_code: 'system_admin' },
  params: {},
  body: {},
  headers: {},
}) as unknown as AuthenticatedRequest;

/** Первый вызов query — выборка сотрудников, остальные (уровни, должности, отделы) пустые. */
const employeesQueryCall = (): { sql: string; params: unknown[] } => {
  const call = h.query.mock.calls[0] as [string, unknown[]?];
  return { sql: call[0], params: (call[1] ?? []) as unknown[] };
};

type Payload = { success: boolean; data: Array<Record<string, unknown>> };

beforeEach(() => {
  Object.values(h).forEach(fn => fn.mockReset());
  h.resolveAccessibleDepartmentIds.mockResolvedValue('all');
  h.getContractorRootId.mockResolvedValue(CONTRACTOR_ROOT);
  h.loadEmployeeManagerAssignmentMap.mockResolvedValue(new Map());
  h.getActiveDirectManagersFor.mockResolvedValue(new Map());
  h.listFullManagersForDepartments.mockResolvedValue(new Map());
  h.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM employees')) {
      return [
        { id: 1, full_name: 'Иванов И.И.', position_id: null, org_department_id: STAFF_DEPT, is_contractor: false },
        { id: 2, full_name: 'Исаев Д.В.', position_id: null, org_department_id: CONTRACTOR_DEPT, is_contractor: true },
      ];
    }
    return [];
  });
});

describe('getEmployeeDepartmentAssignments: выборка сотрудников', () => {
  it('лимит поднят до 50000 — хвост алфавита больше не срезается', async () => {
    await adminUsersController.getEmployeeDepartmentAssignments(makeReq(), makeRes() as never);

    const { sql } = employeesQueryCall();
    expect(sql).toContain('LIMIT 50000');
    expect(sql).not.toContain('LIMIT 10000');
  });

  it('ветка подрядчиков не режется из выдачи, а помечается флагом is_contractor', async () => {
    const res = makeRes();
    await adminUsersController.getEmployeeDepartmentAssignments(makeReq(), res as never);

    const { sql, params } = employeesQueryCall();
    expect(sql).toContain('get_descendant_department_ids($1::uuid[])');
    expect(params[0]).toEqual([CONTRACTOR_ROOT]);

    const body = res.body as Payload;
    expect(body.data.map(row => [row.employee_id, row.is_contractor])).toEqual([[1, false], [2, true]]);
  });

  it('корень подрядчиков не синхронизирован — пустой uuid[], флаг у всех false', async () => {
    h.getContractorRootId.mockResolvedValue(null);
    h.query.mockImplementation(async (sql: string) => (sql.includes('FROM employees')
      ? [{ id: 1, full_name: 'Иванов И.И.', position_id: null, org_department_id: STAFF_DEPT, is_contractor: false }]
      : []));

    const res = makeRes();
    await adminUsersController.getEmployeeDepartmentAssignments(makeReq(), res as never);

    expect(employeesQueryCall().params[0]).toEqual([]);
    expect((res.body as Payload).data[0].is_contractor).toBe(false);
  });

  it('скоупный админ: отделы скоупа вторым параметром, корень подрядчиков — первым', async () => {
    h.resolveAccessibleDepartmentIds.mockResolvedValue([STAFF_DEPT]);

    await adminUsersController.getEmployeeDepartmentAssignments(makeReq(), makeRes() as never);

    const { sql, params } = employeesQueryCall();
    expect(sql).toContain('org_department_id = ANY($2::uuid[])');
    expect(params).toEqual([[CONTRACTOR_ROOT], [STAFF_DEPT]]);
  });

  it('пустой скоуп — запрос к employees не выполняется вовсе', async () => {
    h.resolveAccessibleDepartmentIds.mockResolvedValue([]);

    const res = makeRes();
    await adminUsersController.getEmployeeDepartmentAssignments(makeReq(), res as never);

    expect(h.query).not.toHaveBeenCalled();
    expect((res.body as Payload).data).toEqual([]);
  });
});
