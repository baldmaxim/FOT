import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const svc = vi.hoisted(() => ({
  listStays: vi.fn(),
  getStay: vi.fn(),
  searchCandidates: vi.fn(),
  listAddresses: vi.fn(),
  getEmployeeState: vi.fn(),
  addStay: vi.fn(),
  updateStay: vi.fn(),
  deleteStay: vi.fn(),
}));
vi.mock('../services/dormitory-stays.service.js', () => svc);

const scope = vi.hoisted(() => ({
  canWriteEmployeeInScope: vi.fn(),
  canSeeEmployeeInStaffList: vi.fn(),
  resolveStaffRosterEmployeeIds: vi.fn(),
  resolvePayrollReadableDepartmentIds: vi.fn(),
}));
vi.mock('../services/data-scope.service.js', () => ({ canWriteEmployeeInScope: scope.canWriteEmployeeInScope }));
vi.mock('../services/employee-scope-filter.service.js', () => ({
  canSeeEmployeeInStaffList: scope.canSeeEmployeeInStaffList,
  resolveStaffRosterEmployeeIds: scope.resolveStaffRosterEmployeeIds,
}));
vi.mock('../services/payroll/payroll-scope.service.js', () => ({
  resolvePayrollReadableDepartmentIds: scope.resolvePayrollReadableDepartmentIds,
}));

const audit = vi.hoisted(() => ({ logFromRequest: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock('../services/audit.service.js', () => ({ auditService: audit }));

import { dormitoryStaysController as c } from './dormitory-stays.controller.js';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: any };
};

const makeReq = (over: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest => ({
  user: { id: 'user-1' }, params: {}, query: {}, body: {}, ...over,
} as unknown as AuthenticatedRequest);

const STAY = {
  id: 7,
  employee_id: 42,
  full_name: 'Каримов Акмал',
  department: 'бр.Менгбоев Г.И.',
  position: 'Монтажник',
  check_in: '2026-10-01',
  check_out: null,
  address: 'Общежитие №2, комн. 14',
};

const ACTIVE = { id: 42, employment_status: 'active', is_archived: false, is_contractor: false };
const DISMISSED = { id: 42, employment_status: 'dismissed', is_archived: false, is_contractor: false };

beforeEach(() => {
  vi.resetAllMocks();
});

describe('список', () => {
  it('кадры: охват списка кадров; «все» — без ограничения', async () => {
    svc.listStays.mockResolvedValue([STAY]);
    scope.resolveStaffRosterEmployeeIds.mockResolvedValueOnce(new Set([42, 43]));
    const res = makeRes();
    await c.list(makeReq(), res);
    expect(res.body.data).toEqual([STAY]);
    expect(svc.listStays).toHaveBeenLastCalledWith({ employeeIds: [42, 43] });

    scope.resolveStaffRosterEmployeeIds.mockResolvedValueOnce('all');
    await c.list(makeReq(), makeRes());
    expect(svc.listStays).toHaveBeenLastCalledWith({ employeeIds: null });
  });

  it('«Зарплата»: охват условий оплаты по отделам', async () => {
    svc.listStays.mockResolvedValue([]);
    scope.resolvePayrollReadableDepartmentIds.mockResolvedValueOnce(['d-1']);
    await c.listForPayroll(makeReq(), makeRes());
    expect(svc.listStays).toHaveBeenLastCalledWith({ departmentIds: ['d-1'] });

    scope.resolvePayrollReadableDepartmentIds.mockResolvedValueOnce('all');
    await c.listForPayroll(makeReq(), makeRes());
    expect(svc.listStays).toHaveBeenLastCalledWith({ departmentIds: null });
  });

  it('сохранённые адреса — списком для подсказок', async () => {
    svc.listAddresses.mockResolvedValue(['Общ. База Мытищи', 'Общежитие №2']);
    const res = makeRes();
    await c.listAddresses(makeReq(), res);
    expect(res.body).toEqual({ success: true, data: ['Общ. База Мытищи', 'Общежитие №2'] });
  });

  it('поиск — от 2 символов, в охвате списка кадров', async () => {
    const short = makeRes();
    await c.searchEmployees(makeReq({ query: { q: ' к ' } }), short);
    expect(short.body.data).toEqual([]);
    expect(svc.searchCandidates).not.toHaveBeenCalled();

    scope.resolveStaffRosterEmployeeIds.mockResolvedValue('all');
    svc.searchCandidates.mockResolvedValue([{ id: 42, full_name: 'Каримов Акмал', department: null, position: null }]);
    const res = makeRes();
    await c.searchEmployees(makeReq({ query: { q: 'Кар' } }), res);
    expect(svc.searchCandidates).toHaveBeenCalledWith('Кар', null);
    expect(res.body.data).toHaveLength(1);
  });
});

describe('добавление', () => {
  const body = { employee_id: 42, check_in: '2026-10-01', check_out: null, address: '  Общежитие №2,  комн. 14 ' };

  it('работающий в охвате — добавлен, адрес без лишних пробелов, запись в аудит', async () => {
    svc.getEmployeeState.mockResolvedValue(ACTIVE);
    scope.canWriteEmployeeInScope.mockResolvedValue(true);
    svc.addStay.mockResolvedValue(STAY);
    const res = makeRes();

    await c.add(makeReq({ body }), res);

    expect(res.statusCode).toBe(200);
    expect(svc.addStay).toHaveBeenCalledWith(42, { check_in: '2026-10-01', check_out: null, address: 'Общежитие №2, комн. 14' });
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'DORMITORY_STAY_ADDED',
      expect.objectContaining({ entityId: '7', details: expect.objectContaining({ employee_id: 42, check_in: '2026-10-01' }) }),
    );
  });

  it('несуществующая дата, выезд не позже въезда, пустой адрес, нет сотрудника — 400 без записи', async () => {
    const bodies = [
      { ...body, check_in: '2026-02-31' },
      { ...body, check_in: '2026-13-01' },
      { ...body, check_in: '01.10.2026' },
      { ...body, check_out: '2026-02-30' },
      { ...body, check_out: '2026-10-01' },
      { ...body, check_out: '2026-09-30' },
      { ...body, address: '   ' },
      { ...body, address: 'а'.repeat(201) },
      { ...body, employee_id: undefined },
      { ...body, employee_id: '42' },
    ];
    for (const bad of bodies) {
      const res = makeRes();
      await c.add(makeReq({ body: bad }), res);
      expect(res.statusCode, JSON.stringify(bad).slice(0, 80)).toBe(400);
    }
    expect(svc.getEmployeeState).not.toHaveBeenCalled();
    expect(svc.addStay).not.toHaveBeenCalled();
  });

  it('уволенного, архивного, подрядчика, несуществующего, чужого — не добавить', async () => {
    const cases: Array<[unknown, boolean, number]> = [
      [DISMISSED, true, 400],
      [{ ...ACTIVE, is_archived: true }, true, 400],
      [{ ...ACTIVE, is_contractor: true }, true, 400],
      [null, true, 404],
      [ACTIVE, false, 403],
    ];
    for (const [state, canWrite, status] of cases) {
      // Не Once: при раннем отказе проверка охвата не вызывается, очередь ушла бы следующему случаю.
      svc.getEmployeeState.mockResolvedValue(state);
      scope.canWriteEmployeeInScope.mockResolvedValue(canWrite);
      const res = makeRes();
      await c.add(makeReq({ body }), res);
      expect(res.statusCode, JSON.stringify(state)).toBe(status);
    }
    expect(svc.addStay).not.toHaveBeenCalled();
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });

  it('пересечение с другим проживанием — 409', async () => {
    svc.getEmployeeState.mockResolvedValue(ACTIVE);
    scope.canWriteEmployeeInScope.mockResolvedValue(true);
    svc.addStay.mockResolvedValue('overlap');
    const res = makeRes();
    await c.add(makeReq({ body }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('DORMITORY_OVERLAP');
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });
});

describe('правка', () => {
  const body = { check_in: '2026-10-01', check_out: '2026-10-20', address: 'Общежитие №2, комн. 14' };
  const after = { ...STAY, check_out: '2026-10-20' };

  it('дата выезда — было и стало в аудите; без изменений — аудита нет', async () => {
    svc.getStay.mockResolvedValue(STAY);
    scope.canWriteEmployeeInScope.mockResolvedValue(true);
    svc.updateStay.mockResolvedValueOnce({ before: STAY, after });
    const res = makeRes();
    await c.update(makeReq({ params: { id: '7' }, body }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual(after);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'DORMITORY_STAY_UPDATED',
      expect.objectContaining({ details: { from: expect.objectContaining({ check_out: null }), to: expect.objectContaining({ check_out: '2026-10-20' }) } }),
    );

    svc.updateStay.mockResolvedValueOnce({ before: after, after });
    await c.update(makeReq({ params: { id: '7' }, body }), makeRes());
    expect(audit.logFromRequest).toHaveBeenCalledTimes(1);
  });

  it('уволенный: виден в списке кадров (админ) — можно; не виден (право по отделам) — 403', async () => {
    svc.getStay.mockResolvedValue(STAY);
    scope.canWriteEmployeeInScope.mockResolvedValue(false);
    svc.getEmployeeState.mockResolvedValue(DISMISSED);
    svc.updateStay.mockResolvedValue({ before: STAY, after });

    scope.canSeeEmployeeInStaffList.mockResolvedValueOnce(true);
    const admin = makeRes();
    await c.update(makeReq({ params: { id: '7' }, body }), admin);
    expect(admin.statusCode).toBe(200);

    scope.canSeeEmployeeInStaffList.mockResolvedValueOnce(false);
    const limited = makeRes();
    await c.update(makeReq({ params: { id: '7' }, body }), limited);
    expect(limited.statusCode).toBe(403);
    expect(svc.updateStay).toHaveBeenCalledTimes(1);
  });

  it('работающий вне охвата записи — 403, видимость в списке не спасает', async () => {
    svc.getStay.mockResolvedValue(STAY);
    scope.canWriteEmployeeInScope.mockResolvedValue(false);
    svc.getEmployeeState.mockResolvedValue(ACTIVE);
    scope.canSeeEmployeeInStaffList.mockResolvedValue(true);
    const res = makeRes();
    await c.update(makeReq({ params: { id: '7' }, body }), res);
    expect(res.statusCode).toBe(403);
    expect(svc.updateStay).not.toHaveBeenCalled();
  });

  it('нет записи / кривой id — 404; пересечение — 409; выезд = въезд — 400', async () => {
    svc.getStay.mockResolvedValueOnce(null);
    const missing = makeRes();
    await c.update(makeReq({ params: { id: '99' }, body }), missing);
    expect(missing.statusCode).toBe(404);

    const badId = makeRes();
    await c.update(makeReq({ params: { id: 'x' }, body }), badId);
    expect(badId.statusCode).toBe(404);

    svc.getStay.mockResolvedValueOnce(STAY);
    scope.canWriteEmployeeInScope.mockResolvedValueOnce(true);
    svc.updateStay.mockResolvedValueOnce('overlap');
    const overlap = makeRes();
    await c.update(makeReq({ params: { id: '7' }, body }), overlap);
    expect(overlap.statusCode).toBe(409);

    const sameDay = makeRes();
    await c.update(makeReq({ params: { id: '7' }, body: { ...body, check_out: '2026-10-01' } }), sameDay);
    expect(sameDay.statusCode).toBe(400);
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });
});

describe('удаление', () => {
  it('в охвате — удалено и в аудите; чужое — 403; нет — 404', async () => {
    svc.getStay.mockResolvedValue(STAY);
    scope.canWriteEmployeeInScope.mockResolvedValueOnce(true);
    svc.deleteStay.mockResolvedValueOnce(STAY);
    const res = makeRes();
    await c.remove(makeReq({ params: { id: '7' } }), res);
    expect(res.statusCode).toBe(200);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'DORMITORY_STAY_DELETED', expect.objectContaining({ entityId: '7' }),
    );

    scope.canWriteEmployeeInScope.mockResolvedValueOnce(false);
    svc.getEmployeeState.mockResolvedValueOnce(ACTIVE);
    const foreign = makeRes();
    await c.remove(makeReq({ params: { id: '7' } }), foreign);
    expect(foreign.statusCode).toBe(403);

    svc.getStay.mockResolvedValueOnce(null);
    const missing = makeRes();
    await c.remove(makeReq({ params: { id: '8' } }), missing);
    expect(missing.statusCode).toBe(404);
    expect(svc.deleteStay).toHaveBeenCalledTimes(1);
  });
});
