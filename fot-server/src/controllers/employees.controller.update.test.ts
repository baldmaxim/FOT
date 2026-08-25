import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  queryOne: vi.fn(),
  query: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
  syncProfileName: vi.fn(),
  canAccessEmployeeInScope: vi.fn(),
  resolveRequestDataScope: vi.fn(),
  logFromRequest: vi.fn(),
  updateSigurEmployee: vi.fn(),
  syncLinked: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  queryOne: h.queryOne,
  query: h.query,
  execute: h.execute,
  withTransaction: h.withTransaction,
}));
vi.mock('../services/user-profile-name.service.js', () => ({
  syncProfileNameFromEmployee: h.syncProfileName,
}));
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: h.logFromRequest, log: vi.fn() },
}));
vi.mock('../services/employee-mapper.service.js', () => ({
  loadStructureCache: vi.fn().mockResolvedValue({ departments: new Map(), positions: new Map() }),
  decryptEmployee: (row: unknown) => row,
  decryptEmployeeList: (rows: unknown) => rows,
}));
vi.mock('../services/employee-cache.service.js', () => ({
  employeeCache: { invalidate: h.invalidate },
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
  resolveManagedDepartmentIds: vi.fn(),
  resolveRequestDataScope: h.resolveRequestDataScope,
  resolveRequestDataScopeWithDirectReports: vi.fn(),
  resolveScopedDepartmentId: vi.fn(),
}));
vi.mock('../services/department-access.service.js', () => ({ listExplicitDepartmentIdsForUser: vi.fn() }));
vi.mock('../services/employee-direct-reports.service.js', () => ({ listDirectSubordinates: vi.fn() }));
vi.mock('../services/skud-shared.service.js', () => ({ collectDeptIds: vi.fn() }));
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

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status: vi.fn((c: number) => { res.statusCode = c; return res; }),
    json: vi.fn((b: unknown) => { res.body = b; return res; }),
    setHeader: vi.fn(),
  };
  return res;
};

const makeReq = (body: Record<string, unknown>): AuthenticatedRequest => ({
  user: { id: 'admin-1' },
  params: { id: '77' },
  body,
  ip: '127.0.0.1',
  headers: {},
  socket: {},
}) as unknown as AuthenticatedRequest;

/** Sigur-связанный сотрудник: первый queryOne — existing, второй — refreshed. */
const setupEmployee = (nameLocked = false) => {
  h.queryOne
    .mockResolvedValueOnce({ id: 77, sigur_employee_id: 555, name_locked: nameLocked })
    .mockResolvedValueOnce({ id: 77, full_name: 'Иванов Иван', country: 'УЗБЕКИСТАН' });
};

/** Аргументы единственного UPDATE employees, ушедшего в execute. */
const lastUpdate = (): { sql: string; params: unknown[] } => {
  const call = h.execute.mock.calls.at(-1) as [string, unknown[]];
  return { sql: call[0], params: call[1] };
};

/** Значение колонки в динамическом `SET k1 = $1, k2 = $2 ...`. */
const updatedValue = (column: string): unknown => {
  const { sql, params } = lastUpdate();
  const match = sql.match(new RegExp(`${column} = \\$(\\d+)`));
  if (!match) throw new Error(`Колонки ${column} нет в UPDATE: ${sql}`);
  return params[Number(match[1]) - 1];
};

describe('updateEmployee — Sigur-связанный сотрудник', () => {
  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    h.canAccessEmployeeInScope.mockResolvedValue(true);
    h.resolveRequestDataScope.mockResolvedValue('all');
    h.execute.mockResolvedValue(undefined);
    h.logFromRequest.mockResolvedValue(undefined);
  });

  it('правка только гражданства не трогает Sigur', async () => {
    setupEmployee();
    const res = makeRes();

    await employeesController.update(makeReq({ country: 'ТАДЖИКИСТАН' }), res as never);

    expect(res.statusCode).toBe(200);
    expect(h.updateSigurEmployee).not.toHaveBeenCalled();
    expect(h.syncLinked).not.toHaveBeenCalled();

    const { sql } = lastUpdate();
    expect(updatedValue('country')).toBe('ТАДЖИКИСТАН');
    expect(sql).not.toContain('org_department_id');
    expect(sql).not.toContain('position_id');
    expect(sql).not.toContain('tab_number');
  });

  it('краевые пробелы в гражданстве срезаются', async () => {
    setupEmployee();
    const res = makeRes();

    await employeesController.update(makeReq({ country: '  УЗБЕКИСТАН  ' }), res as never);

    expect(res.statusCode).toBe(200);
    expect(updatedValue('country')).toBe('УЗБЕКИСТАН');
  });

  it('пустая строка и null пишутся как SQL NULL', async () => {
    setupEmployee();
    await employeesController.update(makeReq({ country: '' }), makeRes() as never);
    expect(updatedValue('country')).toBeNull();

    h.execute.mockClear();
    setupEmployee();
    await employeesController.update(makeReq({ country: null }), makeRes() as never);
    expect(updatedValue('country')).toBeNull();
  });

  it('правка ФИО пишет в Sigur и синкает без сброса department_locked', async () => {
    setupEmployee();
    const res = makeRes();

    await employeesController.update(makeReq({ full_name: 'Петров Пётр Петрович' }), res as never);

    expect(res.statusCode).toBe(200);
    expect(h.updateSigurEmployee).toHaveBeenCalledWith(555, { name: 'Петров Пётр Петрович' });
    expect(h.syncLinked).toHaveBeenCalledWith(77, undefined, { clearDepartmentLock: false });
  });

  it('name_locked не мешает менять гражданство', async () => {
    setupEmployee(true);
    const res = makeRes();

    await employeesController.update(makeReq({ country: 'УКРАИНА' }), res as never);

    expect(res.statusCode).toBe(200);
    expect(updatedValue('country')).toBe('УКРАИНА');
  });

  it('name_locked по-прежнему блокирует правку ФИО', async () => {
    setupEmployee(true);
    const res = makeRes();

    await employeesController.update(makeReq({ full_name: 'Петров Пётр' }), res as never);

    expect(res.statusCode).toBe(400);
    expect(h.updateSigurEmployee).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });
});

describe('updateEmployee — portal-only сотрудник (без связи с Sigur)', () => {
  /** Транзакция: UPDATE карточки идёт по client.query, зеркало — вызовом хелпера. */
  const setupTransaction = (row: Record<string, unknown> | null = { id: 77, full_name: 'Чернышева Екатерина Андреевна' }) => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    h.withTransaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn({
      query: async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      },
    }));
    return queries;
  };

  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    h.canAccessEmployeeInScope.mockResolvedValue(true);
    h.resolveRequestDataScope.mockResolvedValue('all');
    h.logFromRequest.mockResolvedValue(undefined);
    h.syncProfileName.mockResolvedValue(1);
    h.queryOne.mockResolvedValue({ id: 77, sigur_employee_id: null, name_locked: false });
  });

  it('правка ФИО обновляет карточку и профиль портала одной транзакцией', async () => {
    const queries = setupTransaction();
    const res = makeRes();

    await employeesController.update(makeReq({ full_name: 'Чернышева Екатерина Андреевна' }), res as never);

    expect(res.statusCode).toBe(200);
    expect(h.withTransaction).toHaveBeenCalledTimes(1);
    expect(queries[0].sql).toContain('UPDATE employees SET');
    expect(queries[0].sql).toContain('full_name = $2');
    // Зеркало вызвано тем же клиентом транзакции, что и UPDATE карточки.
    expect(h.syncProfileName).toHaveBeenCalledTimes(1);
    expect(h.syncProfileName.mock.calls[0][1]).toBe(77);
  });

  it('правка без ФИО идёт мимо транзакции и профиль не трогает', async () => {
    h.queryOne
      .mockResolvedValueOnce({ id: 77, sigur_employee_id: null, name_locked: false })
      .mockResolvedValueOnce({ id: 77, full_name: 'Иванов Иван' });
    const res = makeRes();

    await employeesController.update(makeReq({ country: 'КАЗАХСТАН' }), res as never);

    expect(res.statusCode).toBe(200);
    expect(h.withTransaction).not.toHaveBeenCalled();
    expect(h.syncProfileName).not.toHaveBeenCalled();
  });

  it('сотрудника нет: зеркало не вызывается', async () => {
    setupTransaction(null);
    const res = makeRes();

    await employeesController.update(makeReq({ full_name: 'Чернышева Екатерина Андреевна' }), res as never);

    expect(res.statusCode).toBe(404);
    expect(h.syncProfileName).not.toHaveBeenCalled();
  });

  it('падение зеркала не даёт отдать 200 — правка откатывается', async () => {
    h.withTransaction.mockRejectedValue(new Error('deadlock detected'));
    const res = makeRes();

    await employeesController.update(makeReq({ full_name: 'Чернышева Екатерина Андреевна' }), res as never);

    expect(res.statusCode).toBe(500);
  });
});
