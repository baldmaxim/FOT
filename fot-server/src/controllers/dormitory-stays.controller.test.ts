import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const svc = vi.hoisted(() => ({
  listStays: vi.fn(),
  listPayrollDormitoryStays: vi.fn(),
  getStay: vi.fn(),
  searchCandidates: vi.fn(),
  listAddresses: vi.fn(),
  getHousingRateAmount: vi.fn(),
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
  resolvePayrollEditPredicate: vi.fn(),
  resolvePayrollStaffScope: vi.fn(),
  canWritePayrollRegistryEmployee: vi.fn(),
}));
vi.mock('../services/data-scope.service.js', () => ({ canWriteEmployeeInScope: scope.canWriteEmployeeInScope }));
vi.mock('../services/employee-scope-filter.service.js', () => ({
  canSeeEmployeeInStaffList: scope.canSeeEmployeeInStaffList,
  resolveStaffRosterEmployeeIds: scope.resolveStaffRosterEmployeeIds,
}));
vi.mock('../services/payroll/payroll-scope.service.js', () => ({
  resolvePayrollEditPredicate: scope.resolvePayrollEditPredicate,
}));
vi.mock('../services/payroll/payroll-registry-scope.service.js', () => ({
  resolvePayrollStaffScope: scope.resolvePayrollStaffScope,
  canWritePayrollRegistryEmployee: scope.canWritePayrollRegistryEmployee,
}));

const audit = vi.hoisted(() => ({ logFromRequest: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock('../services/audit.service.js', () => ({ auditService: audit }));

import { DormitoryAllowanceConflictError } from '../services/payroll/payroll-dormitory-allowances.service.js';
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
  kind: 'dormitory',
  check_in: '2026-10-01',
  check_out: null,
  address: 'Общежитие №2, комн. 14',
  amount: null,
};

const APARTMENT = { ...STAY, id: 8, kind: 'apartment', address: null, amount: '630.00' };

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

  it('«Зарплата»: «штат зарплаты» и can_edit по праву на сотрудника', async () => {
    const payrollScope = { contractorRootId: 'root', departmentIds: ['d-1'] };
    scope.resolvePayrollStaffScope.mockResolvedValue(payrollScope);
    scope.resolvePayrollEditPredicate.mockResolvedValue((employeeId: number) => employeeId === 42);
    svc.listPayrollDormitoryStays.mockResolvedValue([STAY, { ...STAY, id: 9, employee_id: 43 }]);
    const res = makeRes();
    await c.listForPayroll(makeReq(), res);
    expect(svc.listPayrollDormitoryStays).toHaveBeenCalledWith(payrollScope);
    expect(svc.listStays).not.toHaveBeenCalled();
    expect(res.body.data.map((row: { id: number; can_edit: boolean }) => [row.id, row.can_edit])).toEqual([[7, true], [9, false]]);
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
    expect(svc.addStay).toHaveBeenCalledWith(42, {
      kind: 'dormitory', check_in: '2026-10-01', check_out: null, address: 'Общежитие №2, комн. 14', amount: null,
    });
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

  it('квартира: сумма — ставка «Доплата за проживание», присланная не читается; адрес — по желанию', async () => {
    svc.getEmployeeState.mockResolvedValue(ACTIVE);
    scope.canWriteEmployeeInScope.mockResolvedValue(true);
    svc.getHousingRateAmount.mockResolvedValue('630.00');
    svc.addStay.mockResolvedValue(APARTMENT);

    await c.add(makeReq({ body: { employee_id: 42, kind: 'apartment', check_in: '2026-10-01', address: '  ' } }), makeRes());
    expect(svc.addStay).toHaveBeenLastCalledWith(42, {
      kind: 'apartment', check_in: '2026-10-01', check_out: null, address: null, amount: 630,
    });
    // Прежний клиент присылает сумму — она не пишется: сумму задаёт «Зарплата».
    await c.add(makeReq({ body: { employee_id: 42, kind: 'apartment', check_in: '2026-10-01', amount: 700, address: ' ул. Рабочая ' } }), makeRes());
    expect(svc.addStay).toHaveBeenLastCalledWith(42, expect.objectContaining({ address: 'ул. Рабочая', amount: 630 }));
    await c.add(makeReq({ body: { ...body, amount: 999 } }), makeRes());
    expect(svc.addStay).toHaveBeenLastCalledWith(42, expect.objectContaining({ kind: 'dormitory', amount: null }));

    for (const bad of [
      { employee_id: 42, kind: 'apartment' },
      { employee_id: 42, kind: 'apartment', check_in: '2026-10-01', address: 'а'.repeat(201) },
      { employee_id: 42, kind: 'flat', check_in: '2026-10-01' },
    ]) {
      const res = makeRes();
      await c.add(makeReq({ body: bad }), res);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(svc.addStay).toHaveBeenCalledTimes(3);
  });

  it('квартира без ставки «Доплата за проживание» (не задана или 0) — 409, общежитию ставка не нужна', async () => {
    svc.getEmployeeState.mockResolvedValue(ACTIVE);
    scope.canWriteEmployeeInScope.mockResolvedValue(true);
    svc.addStay.mockResolvedValue(STAY);
    for (const rate of [null, '0.00']) {
      svc.getHousingRateAmount.mockResolvedValueOnce(rate);
      const res = makeRes();
      await c.add(makeReq({ body: { employee_id: 42, kind: 'apartment', check_in: '2026-10-01' } }), res);
      expect(res.statusCode, String(rate)).toBe(409);
      expect(res.body.code).toBe('HOUSING_RATE_MISSING');
    }
    expect(svc.addStay).not.toHaveBeenCalled();

    svc.getHousingRateAmount.mockClear();
    const dormitory = makeRes();
    await c.add(makeReq({ body }), dormitory);
    expect(dormitory.statusCode).toBe(200);
    expect(svc.getHousingRateAmount).not.toHaveBeenCalled();
  });

  it('квартира в днях доплаты за общежитие — 409 с текстом, без аудита', async () => {
    svc.getEmployeeState.mockResolvedValue(ACTIVE);
    scope.canWriteEmployeeInScope.mockResolvedValue(true);
    svc.getHousingRateAmount.mockResolvedValue('630.00');
    svc.addStay.mockRejectedValue(new DormitoryAllowanceConflictError('HAS_DORMITORY_ALLOWANCE', 'С 01.11.2026 у сотрудника доплата за общежитие'));
    const res = makeRes();
    await c.add(makeReq({ body: { employee_id: 42, kind: 'apartment', check_in: '2026-10-01' } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'HAS_DORMITORY_ALLOWANCE', error: expect.stringContaining('01.11.2026') });
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

    svc.getStay.mockResolvedValueOnce(STAY);
    const sameDay = makeRes();
    await c.update(makeReq({ params: { id: '7' }, body: { ...body, check_out: '2026-10-01' } }), sameDay);
    expect(sameDay.statusCode).toBe(400);
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });

  it('правка квартиры — по её виду: сумма не меняется (null — прежняя), вид и сумма из тела не читаются', async () => {
    svc.getStay.mockResolvedValue(APARTMENT);
    scope.canWriteEmployeeInScope.mockResolvedValue(true);
    svc.updateStay.mockResolvedValue({ before: APARTMENT, after: { ...APARTMENT, check_out: '2026-12-01' } });

    const res = makeRes();
    await c.update(makeReq({
      params: { id: '8' },
      body: { kind: 'dormitory', check_in: '2026-10-01', check_out: '2026-12-01', amount: 700 },
    }), res);
    expect(res.statusCode).toBe(200);
    expect(svc.updateStay).toHaveBeenCalledWith(8, { check_in: '2026-10-01', check_out: '2026-12-01', address: null, amount: null });
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'DORMITORY_STAY_UPDATED',
      expect.objectContaining({ details: { from: expect.objectContaining({ check_out: null }), to: expect.objectContaining({ check_out: '2026-12-01' }) } }),
    );
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

describe('«Зарплата» заселяет в общежитие', () => {
  const body = { employee_id: 42, check_in: '2026-09-01', address: ' Общ. Свободы 35 ', kind: 'apartment', amount: 999 };

  it('работающий из «Справочника» — общежитие (вид и сумма из тела не читаются), аудит с источником', async () => {
    svc.getEmployeeState.mockResolvedValue(ACTIVE);
    scope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    svc.addStay.mockResolvedValue({ ...STAY, address: 'Общ. Свободы 35' });
    const res = makeRes();

    await c.addForPayroll(makeReq({ body }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual(expect.objectContaining({ id: 7, can_edit: true }));
    expect(svc.addStay).toHaveBeenCalledWith(42, {
      kind: 'dormitory', check_in: '2026-09-01', check_out: null, address: 'Общ. Свободы 35', amount: null,
    });
    expect(scope.canWritePayrollRegistryEmployee).toHaveBeenCalledWith(expect.anything(), 42);
    expect(scope.canWriteEmployeeInScope).not.toHaveBeenCalled();
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'DORMITORY_STAY_ADDED',
      expect.objectContaining({ entityId: '7', details: expect.objectContaining({ source: 'payroll_dormitory_registry' }) }),
    );
  });

  it('без адреса — 400; уволенный, подрядчик, нет, не из «Справочника» — отказ; пересечение — 409', async () => {
    const empty = makeRes();
    await c.addForPayroll(makeReq({ body: { ...body, address: '' } }), empty);
    expect(empty.statusCode).toBe(400);

    const cases: Array<[unknown, boolean, number]> = [
      [DISMISSED, true, 400],
      [{ ...ACTIVE, is_contractor: true }, true, 400],
      [null, true, 404],
      [ACTIVE, false, 403],
    ];
    for (const [state, canWrite, status] of cases) {
      svc.getEmployeeState.mockResolvedValue(state);
      scope.canWritePayrollRegistryEmployee.mockResolvedValue(canWrite);
      const res = makeRes();
      await c.addForPayroll(makeReq({ body }), res);
      expect(res.statusCode, JSON.stringify(state)).toBe(status);
    }
    expect(svc.addStay).not.toHaveBeenCalled();

    svc.getEmployeeState.mockResolvedValue(ACTIVE);
    scope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    svc.addStay.mockResolvedValue('overlap');
    const overlap = makeRes();
    await c.addForPayroll(makeReq({ body }), overlap);
    expect(overlap.statusCode).toBe(409);
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });
});

describe('«Зарплата» убирает общежитие', () => {
  const LIVING = { ...STAY, check_in: '2026-07-01', check_out: null };

  it('выезд 1-м числом: въезд и адрес прежние, в аудите было → стало с источником', async () => {
    svc.getStay.mockResolvedValue(LIVING);
    scope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    const after = { ...LIVING, check_out: '2026-10-01' };
    svc.updateStay.mockResolvedValue({ before: LIVING, after });
    const res = makeRes();

    await c.closeForPayroll(makeReq({ params: { id: '7' }, body: { check_out: '2026-10-01', check_in: '2020-01-01', address: 'Другое' } }), res);

    expect(res.statusCode).toBe(200);
    expect(svc.updateStay).toHaveBeenCalledWith(7, {
      check_in: '2026-07-01', check_out: '2026-10-01', address: 'Общежитие №2, комн. 14', amount: null,
    });
    expect(scope.canWritePayrollRegistryEmployee).toHaveBeenCalledWith(expect.anything(), 42);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'DORMITORY_STAY_UPDATED',
      expect.objectContaining({ entityId: '7', details: expect.objectContaining({ source: 'payroll_dormitory_registry' }) }),
    );
  });

  it('выезд позже прежнего, пустой или не позже въезда — 400 без записи', async () => {
    scope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    svc.getStay.mockResolvedValueOnce({ ...LIVING, check_out: '2026-11-01' });
    const later = makeRes();
    await c.closeForPayroll(makeReq({ params: { id: '7' }, body: { check_out: '2026-12-01' } }), later);
    expect(later.statusCode).toBe(400);

    svc.getStay.mockResolvedValueOnce(LIVING);
    const empty = makeRes();
    await c.closeForPayroll(makeReq({ params: { id: '7' }, body: {} }), empty);
    expect(empty.statusCode).toBe(400);

    svc.getStay.mockResolvedValueOnce(LIVING);
    const beforeCheckIn = makeRes();
    await c.closeForPayroll(makeReq({ params: { id: '7' }, body: { check_out: '2026-07-01' } }), beforeCheckIn);
    expect(beforeCheckIn.statusCode).toBe(400);
    expect(svc.updateStay).not.toHaveBeenCalled();
  });

  it('квартира, нет записи — 404; не в «Справочнике» (уволенный, чужой) — 403', async () => {
    svc.getStay.mockResolvedValueOnce(APARTMENT);
    const apartment = makeRes();
    await c.closeForPayroll(makeReq({ params: { id: '8' }, body: { check_out: '2026-10-01' } }), apartment);
    expect(apartment.statusCode).toBe(404);

    svc.getStay.mockResolvedValueOnce(APARTMENT);
    const apartmentDelete = makeRes();
    await c.removeForPayroll(makeReq({ params: { id: '8' } }), apartmentDelete);
    expect(apartmentDelete.statusCode).toBe(404);

    svc.getStay.mockResolvedValueOnce(null);
    const missing = makeRes();
    await c.removeForPayroll(makeReq({ params: { id: '9' } }), missing);
    expect(missing.statusCode).toBe(404);

    svc.getStay.mockResolvedValue(STAY);
    scope.canWritePayrollRegistryEmployee.mockResolvedValue(false);
    const foreignClose = makeRes();
    await c.closeForPayroll(makeReq({ params: { id: '7' }, body: { check_out: '2026-11-01' } }), foreignClose);
    expect(foreignClose.statusCode).toBe(403);
    const foreignDelete = makeRes();
    await c.removeForPayroll(makeReq({ params: { id: '7' } }), foreignDelete);
    expect(foreignDelete.statusCode).toBe(403);

    expect(svc.updateStay).not.toHaveBeenCalled();
    expect(svc.deleteStay).not.toHaveBeenCalled();
    expect(scope.canWriteEmployeeInScope).not.toHaveBeenCalled();
  });

  it('ошибочная строка — удалена, в аудите с источником', async () => {
    svc.getStay.mockResolvedValue(STAY);
    scope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    svc.deleteStay.mockResolvedValue(STAY);
    const res = makeRes();
    await c.removeForPayroll(makeReq({ params: { id: '7' } }), res);
    expect(res.statusCode).toBe(200);
    expect(svc.deleteStay).toHaveBeenCalledWith(7);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'DORMITORY_STAY_DELETED',
      expect.objectContaining({ entityId: '7', details: expect.objectContaining({ source: 'payroll_dormitory_registry' }) }),
    );
  });
});
