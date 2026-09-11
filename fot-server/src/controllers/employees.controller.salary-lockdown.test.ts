import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Оклады закрыты в «Управлении кадрами».
 *
 * Роль с доступом к кадрам (в т.ч. «Отдел безопасности» с флагом «Просмотр всех табелей»,
 * которая читает карточки всей организации) не должна ни видеть, ни менять оклады:
 * они ведутся в разделе «Зарплата» под ключом /salary/terms.
 */
const h = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
  canAccessEmployeeInScope: vi.fn(),
  hasGlobalDepartmentReadScope: vi.fn(),
  resolveRequestDataScope: vi.fn(),
  resolveRequestDataScopeWithDirectReports: vi.fn(),
  resolveScopedDepartmentId: vi.fn(),
  resolveManagedDepartmentIds: vi.fn(),
  listExplicitDepartmentIdsForUser: vi.fn(),
  listDirectSubordinates: vi.fn(),
  cacheGet: vi.fn(),
  logFromRequest: vi.fn(),
  updateSigurEmployee: vi.fn(),
  syncLinked: vi.fn(),
  findActiveBlacklist: vi.fn(),
}));

vi.mock('../services/blacklist.service.js', () => ({
  findActive: h.findActiveBlacklist,
  assertNotBlacklisted: vi.fn(async () => ({ strong: [], weak: [] })),
  addEntryIn: vi.fn(),
  withSigurProfileGuard: vi.fn(),
  BlacklistBlockedError: class extends Error {},
}));
vi.mock('../config/postgres.js', () => ({
  queryOne: h.queryOne,
  query: h.query,
  execute: h.execute,
  withTransaction: h.withTransaction,
}));
vi.mock('../services/user-profile-name.service.js', () => ({ syncProfileNameFromEmployee: vi.fn() }));
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: h.logFromRequest, log: vi.fn() },
}));
vi.mock('../services/employee-mapper.service.js', () => ({
  loadStructureCache: vi.fn().mockResolvedValue({ departments: new Map(), positions: new Map() }),
  decryptEmployee: (row: unknown) => row,
  decryptEmployeeList: (row: unknown) => row,
}));
vi.mock('../services/employee-cache.service.js', () => ({
  employeeCache: { invalidate: vi.fn(), get: h.cacheGet, set: vi.fn() },
}));
vi.mock('../services/employee-counts-cache.service.js', () => ({
  employeeCountsCache: { get: vi.fn(), set: vi.fn(), clear: vi.fn() },
}));
vi.mock('../services/employee-archive-department.service.js', () => ({
  getKnownArchiveDepartment: vi.fn(),
  reconcileFiredEmployeesArchiveDepartment: vi.fn(),
  isProtectedArchiveDepartment: vi.fn().mockResolvedValue(false),
}));
vi.mock('../services/employee-changes.service.js', () => ({
  DomainValidationError: class extends Error {},
  employeeChangesService: { changeSalary: vi.fn(), changePosition: vi.fn() },
}));
vi.mock('../services/sigur-linked-employees.service.js', () => ({
  ensureSigurPosition: vi.fn(),
  syncLinkedEmployeeFromSigur: h.syncLinked,
}));
vi.mock('../services/sigur.service.js', () => ({
  sigurService: { updateEmployee: h.updateSigurEmployee, isConfigured: vi.fn() },
}));
vi.mock('../services/sigur-live-employees-crud.service.js', () => ({ createSigurEmployee: vi.fn() }));
vi.mock('../services/data-scope.service.js', () => ({
  canAccessEmployeeInScope: h.canAccessEmployeeInScope,
  hasGlobalDepartmentReadScope: h.hasGlobalDepartmentReadScope,
  normalizeUuidParam: (value: unknown) => (typeof value === 'string' && value.trim() ? value : null),
  resolveManagedDepartmentIds: h.resolveManagedDepartmentIds,
  resolveRequestDataScope: h.resolveRequestDataScope,
  resolveRequestDataScopeWithDirectReports: h.resolveRequestDataScopeWithDirectReports,
  resolveScopedDepartmentId: h.resolveScopedDepartmentId,
}));
vi.mock('../services/department-access.service.js', () => ({
  listExplicitDepartmentIdsForUser: h.listExplicitDepartmentIdsForUser,
}));
vi.mock('../services/employee-direct-reports.service.js', () => ({ listDirectSubordinates: h.listDirectSubordinates }));
vi.mock('../services/skud-shared.service.js', () => ({ collectDeptIds: vi.fn(async (id: string) => [id]) }));
vi.mock('../services/realtime-broadcast.service.js', () => ({ emitDomainChange: vi.fn() }));
vi.mock('../services/recipients.service.js', () => ({
  getEmployeeOwnerAndSupervisor: vi.fn().mockResolvedValue([]),
  getUserIdsByEmployeeIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('./employee-lifecycle.controller.js', () => ({
  fire: vi.fn(), rehire: vi.fn(), cancelDismissal: vi.fn(), moveDepartment: vi.fn(),
  batchMoveEmployees: vi.fn(), getHistory: vi.fn(), updateHistoryEvent: vi.fn(), deleteHistoryEvent: vi.fn(),
}));
vi.mock('./employee-import.controller.js', () => ({ deleteAll: vi.fn() }));

import { employeesController } from './employees.controller.js';
import type { AuthenticatedRequest } from '../types/index.js';

const SALARY_COLUMNS = ['current_salary', 'salary_actual', 'salary_calculated', 'staff_units'];

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status: vi.fn((c: number) => { res.statusCode = c; return res; }),
    json: vi.fn((b: unknown) => { res.body = b; return res; }),
    setHeader: vi.fn(),
    end: vi.fn(),
  };
  return res;
};

const makeReq = (over: {
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
} = {}): AuthenticatedRequest => ({
  user: { id: 'sec-1', role_code: 'security', is_admin: false, employee_id: 441 },
  params: over.params ?? { id: '77' },
  query: over.query ?? {},
  body: over.body ?? {},
  ip: '127.0.0.1',
  headers: {},
  socket: {},
  header: () => undefined,
}) as unknown as AuthenticatedRequest;

/** Все SQL, ушедшие в БД любым способом. */
const allSql = (): string[] => [
  ...h.query.mock.calls.map(c => String(c[0])),
  ...h.queryOne.mock.calls.map(c => String(c[0])),
  ...h.execute.mock.calls.map(c => String(c[0])),
];

beforeEach(() => {
  Object.values(h).forEach(fn => fn.mockReset());
  h.canAccessEmployeeInScope.mockResolvedValue(true);
  h.hasGlobalDepartmentReadScope.mockResolvedValue(true);
  h.resolveRequestDataScope.mockResolvedValue('all');
  h.resolveRequestDataScopeWithDirectReports.mockResolvedValue('all');
  h.resolveScopedDepartmentId.mockResolvedValue(null);
  h.resolveManagedDepartmentIds.mockResolvedValue([]);
  h.listExplicitDepartmentIdsForUser.mockResolvedValue([]);
  h.listDirectSubordinates.mockResolvedValue([]);
  h.findActiveBlacklist.mockResolvedValue({ strong: [], weak: [] });
  h.logFromRequest.mockResolvedValue(undefined);
  h.query.mockResolvedValue([]);
  h.execute.mockResolvedValue(undefined);
});

describe('PUT /employees/:id — запись оклада закрыта', () => {
  it.each([
    ['current_salary', 150000],
    ['salary_actual', 150000],
    ['salary_calculated', 150000],
    ['staff_units', 0.5],
  ])('%s в теле запроса → 400 SALARY_MOVED_TO_PAYROLL, в БД и Sigur ничего не уходит', async (field, value) => {
    const res = makeRes();

    await employeesController.update(makeReq({ body: { [field]: value } }), res as never);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      code: 'SALARY_MOVED_TO_PAYROLL',
      data: { fields: [field] },
    });
    expect(h.queryOne).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.withTransaction).not.toHaveBeenCalled();
    expect(h.updateSigurEmployee).not.toHaveBeenCalled();
  });

  it('обнуление оклада (null) — тоже запись оклада, тоже отказ', async () => {
    const res = makeRes();

    await employeesController.update(makeReq({ body: { current_salary: null } }), res as never);

    expect(res.statusCode).toBe(400);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('оклад вместе с обычным полем: отказ целиком, без частичной записи гражданства', async () => {
    const res = makeRes();

    await employeesController.update(
      makeReq({ body: { country: 'КАЗАХСТАН', salary_actual: 90000 } }),
      res as never,
    );

    expect(res.statusCode).toBe(400);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.withTransaction).not.toHaveBeenCalled();
  });

  it('обычная правка карточки без оклада работает как раньше', async () => {
    h.queryOne
      .mockResolvedValueOnce({ id: 77, sigur_employee_id: 555, name_locked: false })
      .mockResolvedValueOnce({ id: 77, full_name: 'Иванов Иван', country: 'КАЗАХСТАН' });
    const res = makeRes();

    await employeesController.update(makeReq({ body: { country: 'КАЗАХСТАН' } }), res as never);

    expect(res.statusCode).toBe(200);
    const updateSql = h.execute.mock.calls.map(c => String(c[0])).find(sql => sql.startsWith('UPDATE employees'));
    expect(updateSql).toBeDefined();
    for (const column of SALARY_COLUMNS) {
      expect(updateSql).not.toContain(column);
    }
  });
});

describe('чтение — поля оклада не покидают БД', () => {
  it('список «Управления кадрами» (view=staff) не выбирает колонки оклада', async () => {
    const res = makeRes();

    await employeesController.getAll(makeReq({ query: { page: '1', view: 'staff' } }), res as never);

    expect(res.statusCode).toBe(200);
    const employeeSelects = allSql().filter(sql => sql.includes('FROM employees'));
    expect(employeeSelects.length).toBeGreaterThan(0);
    for (const sql of employeeSelects) {
      for (const column of SALARY_COLUMNS) {
        expect(sql).not.toContain(column);
      }
    }
  });

  it('карточка сотрудника (промах кэша) не выбирает колонки оклада', async () => {
    h.cacheGet.mockReturnValue(undefined);
    h.queryOne.mockResolvedValue({ id: 77, full_name: 'Иванов Иван' });
    const res = makeRes();

    await employeesController.getById(makeReq({ params: { id: '77' } }), res as never);

    const cardSelects = allSql().filter(sql => sql.includes('FROM employees WHERE id'));
    expect(cardSelects.length).toBeGreaterThan(0);
    for (const sql of cardSelects) {
      for (const column of SALARY_COLUMNS) {
        expect(sql).not.toContain(column);
      }
    }
  });
});

describe('роуты записи оклада — только с правом на раздел «Зарплата»', () => {
  const routesSource = readFileSync(
    path.resolve(__dirname, '..', 'routes', 'employees.routes.ts'),
    'utf8',
  );

  /** Гарды конкретного роута: от объявления пути до следующего router.*. */
  const guardsOf = (routePath: string): string => {
    const start = routesSource.indexOf(`'${routePath}'`);
    expect(start, `роут ${routePath} не найден`).toBeGreaterThan(-1);
    const end = routesSource.indexOf('router.', start);
    return routesSource.slice(start, end === -1 ? undefined : end);
  };

  it.each(['/:id/change-salary', '/enrich-salary', '/enrich-salary-history'])(
    '%s защищён /salary/terms edit и 2FA, а не ключом «Управления кадрами»',
    (routePath) => {
      const guards = guardsOf(routePath);
      expect(guards).toContain("requirePageAccess('/salary/terms', 'edit')");
      expect(guards).toContain('requireCritical2FA');
      expect(guards).not.toContain("'/staff-control'");
    },
  );
});
