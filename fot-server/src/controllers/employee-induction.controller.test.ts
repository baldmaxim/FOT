import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  listInduction: vi.fn(),
  listInductionDepartments: vi.fn(),
  resolveInductionScopeIds: vi.fn(),
  setInduction: vi.fn(),
  logFromRequest: vi.fn(),
}));

vi.mock('../services/employee-induction.service.js', () => ({
  listInduction: h.listInduction,
  listInductionDepartments: h.listInductionDepartments,
  resolveInductionScopeIds: h.resolveInductionScopeIds,
  setInduction: h.setInduction,
}));
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: h.logFromRequest },
  AUDIT_ACTIONS: { EMPLOYEE_INDUCTION_CHANGED: 'EMPLOYEE_INDUCTION_CHANGED' },
}));

import { employeeInductionController } from './employee-induction.controller.js';

const SCOPE = ['11111111-1111-1111-1111-111111111111'];

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status: vi.fn(function (this: { statusCode: number }, c: number) { this.statusCode = c; return res; }),
    json: vi.fn(function (this: { body: unknown }, b: unknown) { this.body = b; return res; }),
  };
  return res;
};

const makeReq = (over: Record<string, unknown> = {}) => ({
  user: { id: 'u-1', role_code: 'otitb' },
  query: {},
  params: {},
  body: {},
  ip: '127.0.0.1',
  headers: {},
  socket: {},
  ...over,
}) as never;

beforeEach(() => {
  Object.values(h).forEach(fn => fn.mockReset());
  h.resolveInductionScopeIds.mockResolvedValue(SCOPE);
});

describe('employeeInductionController.list', () => {
  it('отдаёт строки и meta со счётчиком пройденных', async () => {
    h.listInduction.mockResolvedValue({
      rows: [{ employee_id: 1, full_name: 'Иванов', inducted_on: null }],
      total: 150,
      passed: 40,
    });
    const res = makeRes();

    await employeeInductionController.list(makeReq({ query: { page: '2', pageSize: '50' } }), res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      meta: { page: 2, pageSize: 50, total: 150, totalPages: 3, passed: 40 },
    });
    expect(h.listInduction).toHaveBeenCalledWith(expect.objectContaining({ scopeIds: SCOPE, page: 2, pageSize: 50 }));
  });

  it('передаёт фильтры отдела, поиска и статуса в сервис', async () => {
    h.listInduction.mockResolvedValue({ rows: [], total: 0, passed: 0 });
    const res = makeRes();
    const departmentId = '44444444-4444-4444-4444-444444444444';

    await employeeInductionController.list(
      makeReq({ query: { department_id: departmentId, search: '  Иван  ', status: 'missing' } }),
      res as never,
    );

    expect(h.listInduction).toHaveBeenCalledWith(expect.objectContaining({
      departmentId, search: 'Иван', status: 'missing',
    }));
  });

  it('некорректный статус — 400', async () => {
    const res = makeRes();

    await employeeInductionController.list(makeReq({ query: { status: 'whatever' } }), res as never);

    expect(res.statusCode).toBe(400);
    expect(h.listInduction).not.toHaveBeenCalled();
  });

  it('pageSize сверх лимита — 400 (защита от выкачивания всей ветки)', async () => {
    const res = makeRes();

    await employeeInductionController.list(makeReq({ query: { pageSize: '5000' } }), res as never);

    expect(res.statusCode).toBe(400);
  });
});

describe('employeeInductionController.departments', () => {
  it('отдаёт отделы из скоупа пользователя', async () => {
    h.listInductionDepartments.mockResolvedValue([{ id: SCOPE[0], name: 'Участок 1' }]);
    const res = makeRes();

    await employeeInductionController.departments(makeReq(), res as never);

    expect(h.listInductionDepartments).toHaveBeenCalledWith(SCOPE);
    expect(res.body).toEqual({ success: true, data: [{ id: SCOPE[0], name: 'Участок 1' }] });
  });

  it('пустой скоуп — пустой список, а не все отделы', async () => {
    h.resolveInductionScopeIds.mockResolvedValue([]);
    h.listInductionDepartments.mockResolvedValue([]);
    const res = makeRes();

    await employeeInductionController.departments(makeReq(), res as never);

    expect(h.listInductionDepartments).toHaveBeenCalledWith([]);
    expect(res.body).toEqual({ success: true, data: [] });
  });
});

describe('employeeInductionController.setDate', () => {
  const req = (body: unknown, id = '7') => makeReq({ params: { id }, body });

  it('первая установка даты: 200 и previous=null в аудите (не 404)', async () => {
    h.setInduction.mockResolvedValue({ found: true, changed: true, previous: null, current: '2026-07-01' });
    const res = makeRes();

    await employeeInductionController.setDate(req({ inducted_on: '2026-07-01' }), res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { employee_id: 7, inducted_on: '2026-07-01', changed: true },
    });
    expect(h.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'u-1', 'EMPLOYEE_INDUCTION_CHANGED',
      expect.objectContaining({
        entityType: 'employee',
        entityId: '7',
        details: { inducted_on: '2026-07-01', previous: null },
      }),
    );
  });

  it('сотрудник вне скоупа / уволенный / архивный — 404', async () => {
    h.setInduction.mockResolvedValue({ found: false });
    const res = makeRes();

    await employeeInductionController.setDate(req({ inducted_on: '2026-07-01' }), res as never);

    expect(res.statusCode).toBe(404);
    expect(h.logFromRequest).not.toHaveBeenCalled();
  });

  it('no-op (та же дата) — 200 без записи в аудит', async () => {
    h.setInduction.mockResolvedValue({
      found: true, changed: false, previous: '2026-07-01', current: '2026-07-01',
    });
    const res = makeRes();

    await employeeInductionController.setDate(req({ inducted_on: '2026-07-01' }), res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ data: { changed: false } });
    expect(h.logFromRequest).not.toHaveBeenCalled();
  });

  it('снятие даты (null) — проходит в сервис', async () => {
    h.setInduction.mockResolvedValue({ found: true, changed: true, previous: '2026-07-01', current: null });
    const res = makeRes();

    await employeeInductionController.setDate(req({ inducted_on: null }), res as never);

    expect(res.statusCode).toBe(200);
    expect(h.setInduction).toHaveBeenCalledWith(expect.objectContaining({ inductedOn: null, scopeIds: SCOPE }));
  });

  it('дата в будущем — 400, сервис не вызывается', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-24T12:00:00+03:00'));
    const res = makeRes();

    await employeeInductionController.setDate(req({ inducted_on: '2026-07-25' }), res as never);

    expect(res.statusCode).toBe(400);
    expect(h.setInduction).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('несуществующая календарная дата — 400', async () => {
    const res = makeRes();

    await employeeInductionController.setDate(req({ inducted_on: '2026-02-31' }), res as never);

    expect(res.statusCode).toBe(400);
    expect(h.setInduction).not.toHaveBeenCalled();
  });

  it('нечисловой id — 400', async () => {
    const res = makeRes();

    await employeeInductionController.setDate(req({ inducted_on: '2026-07-01' }, 'abc'), res as never);

    expect(res.statusCode).toBe(400);
    expect(h.setInduction).not.toHaveBeenCalled();
  });
});
