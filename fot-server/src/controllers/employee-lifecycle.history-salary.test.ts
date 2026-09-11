import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Лента истории сотрудника: события оклада видны только с правом на раздел «Зарплата».
 *
 * Доступ к карточке (кадры, руководитель, «Отдел безопасности» с чтением всей организации)
 * сам по себе права на оклады не даёт. Фильтр — в SQL, чтобы суммы не покидали БД.
 */
const h = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  canAccessEmployeeInScope: vi.fn(),
  resolveEffectivePageAccess: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  queryOne: h.queryOne,
  query: h.query,
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../services/access-control.service.js', () => ({
  resolveEffectivePageAccess: h.resolveEffectivePageAccess,
}));
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: vi.fn(), log: vi.fn() },
}));
vi.mock('../services/audit-context.helpers.js', () => ({ loadEmployeeFullName: vi.fn() }));
vi.mock('../services/employee-changes.service.js', () => ({
  DomainValidationError: class extends Error {},
  employeeChangesService: {},
}));
vi.mock('../services/employee-mapper.service.js', () => ({
  loadStructureCache: vi.fn().mockResolvedValue({ departments: new Map(), positions: new Map() }),
  decryptEmployee: (row: unknown) => row,
}));
vi.mock('../services/employee-cache.service.js', () => ({ employeeCache: { invalidate: vi.fn() } }));
vi.mock('../services/employee-archive-department.service.js', () => ({
  isProtectedArchiveDepartment: vi.fn().mockResolvedValue(false),
}));
vi.mock('../services/sigur-linked-employees.service.js', () => ({ syncLinkedEmployeeFromSigur: vi.fn() }));
vi.mock('../services/sigur.service.js', () => ({ sigurService: {} }));
vi.mock('../services/data-scope.service.js', () => ({
  canAccessEmployeeInScope: h.canAccessEmployeeInScope,
  canAccessDepartmentInScope: vi.fn().mockResolvedValue(true),
  resolveRequestDataScope: vi.fn().mockResolvedValue('all'),
}));
vi.mock('../services/employee-department-access.service.js', () => ({ upsertTechnicalDepartmentAccess: vi.fn() }));
vi.mock('../services/realtime-broadcast.service.js', () => ({ emitDomainChange: vi.fn() }));
vi.mock('../services/recipients.service.js', () => ({
  getEmployeeOwnerAndSupervisor: vi.fn().mockResolvedValue([]),
  getUserIdsByEmployeeIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('../services/employee-lifecycle-operations.service.js', () => ({}));

import { getHistory } from './employee-lifecycle.controller.js';
import type { AuthenticatedRequest } from '../types/index.js';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null as unknown as { success: boolean; data: Array<{ event_type: string }> },
    status: vi.fn((c: number) => { res.statusCode = c; return res; }),
    json: vi.fn((b: never) => { res.body = b; return res; }),
  };
  return res;
};

const makeReq = (): AuthenticatedRequest => ({
  user: { id: 'sec-1', role_code: 'security', is_admin: false },
  params: { id: '77' },
  query: {},
  body: {},
}) as unknown as AuthenticatedRequest;

/** БД умеет фильтровать сама: эмулируем ровно то условие, которое передаёт контроллер. */
const HISTORY = [
  { employee_id: 77, event_type: 'assignment', event_id: 'a1', event_date: '2026-01-10', event_data: {} },
  { employee_id: 77, event_type: 'salary', event_id: 's1', event_date: '2026-02-01', event_data: { salary: '150000' } },
  { employee_id: 77, event_type: 'dismissal', event_id: 'd1', event_date: '2026-03-01', event_data: {} },
];

beforeEach(() => {
  Object.values(h).forEach(fn => fn.mockReset());
  h.canAccessEmployeeInScope.mockResolvedValue(true);
  h.queryOne.mockResolvedValue({ id: 77 });
  h.query.mockImplementation(async (_sql: string, params: unknown[]) => {
    const canViewSalary = params[1] === true;
    return HISTORY.filter(row => canViewSalary || row.event_type !== 'salary');
  });
});

const historySql = (): { sql: string; params: unknown[] } => {
  const call = h.query.mock.calls.find(c => String(c[0]).includes('employee_history')) as [string, unknown[]];
  return { sql: call[0], params: call[1] };
};

describe('GET /employees/:id/history — события оклада', () => {
  it('без права на /salary/terms события оклада не выбираются из БД', async () => {
    h.resolveEffectivePageAccess.mockResolvedValue(false);
    const res = makeRes();

    await getHistory(makeReq(), res as never);

    expect(res.statusCode).toBe(200);
    expect(h.resolveEffectivePageAccess).toHaveBeenCalledWith(expect.anything(), '/salary/terms', 'view');

    const { sql, params } = historySql();
    expect(sql).toMatch(/event_type\s*<>\s*'salary'/);
    expect(params[1]).toBe(false);

    const types = res.body.data.map(event => event.event_type);
    expect(types).toEqual(['assignment', 'dismissal']);
    // Сумма оклада не должна попасть в ответ ни в каком виде.
    expect(JSON.stringify(res.body)).not.toContain('150000');
  });

  it('с правом на /salary/terms история оклада видна полностью', async () => {
    h.resolveEffectivePageAccess.mockResolvedValue(true);
    const res = makeRes();

    await getHistory(makeReq(), res as never);

    expect(res.statusCode).toBe(200);
    expect(historySql().params[1]).toBe(true);
    expect(res.body.data.map(event => event.event_type)).toContain('salary');
  });

  it('сотрудник вне скоупа — 403 до проверки прав на оклады и до запроса истории', async () => {
    h.canAccessEmployeeInScope.mockResolvedValue(false);
    const res = makeRes();

    await getHistory(makeReq(), res as never);

    expect(res.statusCode).toBe(403);
    expect(h.query).not.toHaveBeenCalled();
  });
});
