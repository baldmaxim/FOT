import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * ФИО профиля портала (user_profiles.full_name) — зеркало карточки сотрудника.
 * Проверяем обе привязки (одобрение заявки и ручная смена employee_id) и запрет
 * встречной правки имени у связанного профиля.
 */
const h = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
  syncProfileName: vi.fn(),
  getRoleByCode: vi.fn(),
  getUserById: vi.fn(),
  resolveCompanyScope: vi.fn(),
  resolveAccessibleDepartmentIds: vi.fn(),
  canAccessEmployeeInScope: vi.fn(),
  logFromRequest: vi.fn(),
  loadEmployeeManagerAssignmentMap: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: h.queryOne,
  execute: h.execute,
  withTransaction: h.withTransaction,
}));
vi.mock('../services/user-profile-name.service.js', () => ({ syncProfileNameFromEmployee: h.syncProfileName }));
vi.mock('../services/roles-cache.service.js', () => ({
  getRoleByCode: h.getRoleByCode,
  getAllRoles: vi.fn().mockResolvedValue([]),
}));
vi.mock('../services/local-auth.service.js', () => ({
  localAuthService: {
    getUserById: h.getUserById,
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
}));
vi.mock('../services/department-access.service.js', () => ({
  loadEmployeeManagerAssignmentMap: h.loadEmployeeManagerAssignmentMap,
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

const makeReq = (body: Record<string, unknown>): AuthenticatedRequest => ({
  user: { id: 'admin-1' },
  params: { id: '3ffe0987-39b1-48b0-af45-2dddf8ccd907' },
  body,
  ip: '127.0.0.1',
  headers: {},
  socket: {},
}) as unknown as AuthenticatedRequest;

/** Транзакция: пишет SQL в calls, возвращает одну строку. */
const collectTransaction = () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  h.withTransaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn({
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [{ id: 'profile-1' }], rowCount: 1 };
    },
  }));
  return calls;
};

describe('approveUser — привязка сотрудника при одобрении', () => {
  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    h.resolveCompanyScope.mockResolvedValue({ roots: 'all' });
    h.getRoleByCode.mockResolvedValue({ id: 'role-1', code: 'worker', is_active: true });
    h.queryOne.mockResolvedValue({ id: 'profile-1' });
    h.getUserById.mockResolvedValue({ id: 'profile-1' });
    h.logFromRequest.mockResolvedValue(undefined);
    h.loadEmployeeManagerAssignmentMap.mockResolvedValue(new Map());
    h.syncProfileName.mockResolvedValue(1);
    h.query.mockResolvedValue([{ id: 'profile-1' }]);
  });

  it('с employee_id: одобрение и ФИО из карточки — одной транзакцией', async () => {
    const calls = collectTransaction();
    const res = makeRes();

    await adminUsersController.approveUser(makeReq({ position_type: 'worker', employee_id: 396 }), res as never);

    expect(res.statusCode).toBe(200);
    expect(h.withTransaction).toHaveBeenCalledTimes(1);
    expect(calls[0].sql).toContain('UPDATE user_profiles SET');
    expect(calls[0].sql).toContain('employee_id');
    expect(h.syncProfileName).toHaveBeenCalledTimes(1);
    expect(h.syncProfileName.mock.calls[0][1]).toBe(396);
  });

  it('без employee_id: транзакция не нужна, профиль остаётся с регистрационным именем', async () => {
    collectTransaction();
    const res = makeRes();

    await adminUsersController.approveUser(makeReq({ position_type: 'worker' }), res as never);

    expect(res.statusCode).toBe(200);
    expect(h.withTransaction).not.toHaveBeenCalled();
    expect(h.syncProfileName).not.toHaveBeenCalled();
  });
});

describe('updateUserEmployee — ручная привязка карточки', () => {
  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    h.resolveCompanyScope.mockResolvedValue({ roots: 'all' });
    h.syncProfileName.mockResolvedValue(1);
    h.execute.mockResolvedValue(1);
  });

  it('привязка подтягивает ФИО карточки в той же транзакции', async () => {
    const calls = collectTransaction();
    const res = makeRes();

    await adminUsersController.updateUserEmployee(makeReq({ employee_id: 396 }), res as never);

    expect(res.statusCode).toBe(200);
    expect(calls[0].sql).toContain('SET employee_id = $1');
    expect(h.syncProfileName).toHaveBeenCalledTimes(1);
    expect(h.syncProfileName.mock.calls[0][1]).toBe(396);
  });

  it('отвязка (null) идёт обычным execute и профиль не переименовывает', async () => {
    collectTransaction();
    const res = makeRes();

    await adminUsersController.updateUserEmployee(makeReq({ employee_id: null }), res as never);

    expect(res.statusCode).toBe(200);
    expect(h.withTransaction).not.toHaveBeenCalled();
    expect(h.syncProfileName).not.toHaveBeenCalled();
  });
});

describe('updateUserName — запрет правки имени связанного профиля', () => {
  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    h.resolveAccessibleDepartmentIds.mockResolvedValue('all');
    h.logFromRequest.mockResolvedValue(undefined);
  });

  it('несвязанный профиль: имя правится как раньше', async () => {
    h.query.mockResolvedValue([{ id: 'profile-1' }]);
    const res = makeRes();

    await adminUsersController.updateUserName(makeReq({ full_name: 'Иванов Иван' }), res as never);

    expect(res.statusCode).toBe(200);
    const [sql] = h.query.mock.calls[0] as unknown as [string];
    // Гард атомарный: условие в самом UPDATE, без предварительного SELECT.
    expect(sql).toContain('employee_id IS NULL');
  });

  it('связанный профиль: 400 и никакой записи имени', async () => {
    h.query.mockResolvedValue([]);
    h.queryOne.mockResolvedValue({ employee_id: 396 });
    const res = makeRes();

    await adminUsersController.updateUserName(makeReq({ full_name: 'Виноходова Екатерина' }), res as never);

    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toContain('карточке сотрудника');
  });

  it('профиля нет: 404', async () => {
    h.query.mockResolvedValue([]);
    h.queryOne.mockResolvedValue(null);
    const res = makeRes();

    await adminUsersController.updateUserName(makeReq({ full_name: 'Иванов Иван' }), res as never);

    expect(res.statusCode).toBe(404);
  });
});
