import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const registryScope = vi.hoisted(() => ({
  canWritePayrollRegistryEmployee: vi.fn(),
  resolvePayrollStaffScope: vi.fn(),
}));
vi.mock('../services/payroll/payroll-registry-scope.service.js', () => registryScope);

const payrollScope = vi.hoisted(() => ({ resolvePayrollEditPredicate: vi.fn() }));
vi.mock('../services/payroll/payroll-scope.service.js', () => payrollScope);

const housing = vi.hoisted(() => ({ listHousingAllowances: vi.fn() }));
vi.mock('../services/payroll/payroll-housing.service.js', () => housing);

// «Доплата за проживание» пишет квартиры «Проживания» (миграция 320).
const stays = vi.hoisted(() => ({
  getStay: vi.fn(), addStay: vi.fn(), updateStay: vi.fn(), deleteStay: vi.fn(), getEmployeeState: vi.fn(),
}));
vi.mock('../services/dormitory-stays.service.js', () => stays);

const supplements = vi.hoisted(() => ({
  listSupplements: vi.fn(),
  savePlannedSupplement: vi.fn(),
  getOneTimeSupplement: vi.fn(),
  addOneTimeSupplement: vi.fn(),
  updateOneTimeSupplement: vi.fn(),
  deleteOneTimeSupplement: vi.fn(),
}));
vi.mock('../services/payroll/payroll-supplements.service.js', () => supplements);

const stops = vi.hoisted(() => ({
  listCompensationStops: vi.fn(),
  getCompensationStop: vi.fn(),
  addCompensationStop: vi.fn(),
  updateCompensationStop: vi.fn(),
  deleteCompensationStop: vi.fn(),
}));
vi.mock('../services/payroll/payroll-compensation-stops.service.js', () => stops);

// «Удержания» пишут удержания staff_deductions — те же записи, что во вкладке кадров (миграция 321).
const deductions = vi.hoisted(() => ({
  listPayrollDeductions: vi.fn(),
  getDeduction: vi.fn(),
  addDeduction: vi.fn(),
  updateDeduction: vi.fn(),
  deleteDeduction: vi.fn(),
}));
vi.mock('../services/staff-deductions.service.js', () => deductions);

const terms = vi.hoisted(() => ({ lockPayrollEmployee: vi.fn() }));
vi.mock('../services/payroll/payroll-terms.service.js', () => terms);

// Транзакция в тесте — вызов колбэка с фиктивным клиентом: запросы делает замоканный сервис.
vi.mock('../config/postgres.js', () => ({ withTransaction: vi.fn(async (fn: (client: unknown) => unknown) => fn({})) }));

const audit = vi.hoisted(() => ({ logFromRequest: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock('../services/audit.service.js', () => ({ auditService: audit }));

import { DormitoryAllowanceConflictError } from '../services/payroll/payroll-dormitory-allowances.service.js';
import { payrollHousingController as housingC } from './payroll-housing.controller.js';
import { payrollSupplementsController as supplementsC } from './payroll-supplements.controller.js';
import { payrollCompensationStopsController as stopsC } from './payroll-compensation-stops.controller.js';
import { payrollRegistryController as registryC } from './payroll-registry.controller.js';
import { payrollStaffDeductionsController as deductionsC } from './payroll-staff-deductions.controller.js';

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

const SCOPE = { contractorRootId: 'contractor-root', departmentIds: ['d-1'] };

beforeEach(() => {
  vi.resetAllMocks();
  registryScope.resolvePayrollStaffScope.mockResolvedValue(SCOPE);
  payrollScope.resolvePayrollEditPredicate.mockResolvedValue((employeeId: number) => employeeId !== 99);
});

describe('списки', () => {
  it('охват «штата зарплаты» и can_edit по строке', async () => {
    housing.listHousingAllowances.mockResolvedValue([
      { employee_id: 42, full_name: 'Каримов Акмал', amount: '630.00' },
      { employee_id: 99, full_name: 'Сам Себе', amount: '700.00' },
    ]);
    const res = makeRes();
    await housingC.list(makeReq(), res);
    expect(housing.listHousingAllowances).toHaveBeenCalledWith(expect.objectContaining(SCOPE));
    expect(res.body.data.map((row: { can_edit: boolean }) => row.can_edit)).toEqual([true, false]);
  });

  it('«Удержания» и «Без проезда» — в том же охвате; у «Удержаний» can_edit по строке', async () => {
    deductions.listPayrollDeductions.mockResolvedValue([
      { id: 1, employee_id: 42, full_name: 'Каримов Акмал', kind_name: 'ТМЦ', month: '2026-10', amount: '500.00' },
      { id: 2, employee_id: 99, full_name: 'Сам Себе', kind_name: 'Штрафы', month: '2026-10', amount: '1500.00' },
    ]);
    stops.listCompensationStops.mockResolvedValue([]);
    const res = makeRes();
    await deductionsC.list(makeReq(), res);
    await stopsC.list(makeReq(), makeRes());
    expect(deductions.listPayrollDeductions).toHaveBeenCalledWith(expect.objectContaining(SCOPE));
    expect(stops.listCompensationStops).toHaveBeenCalledWith(SCOPE);
    expect(res.body.data.map((row: { can_edit: boolean }) => row.can_edit)).toEqual([true, false]);
  });
});

describe('месяцы в «Доплате за проживание» и «Удержаниях»', () => {
  const periodOf = (mock: { mock: { calls: unknown[][] } }) => (mock.mock.calls[0][0] as { period: unknown }).period;

  it('старый клиент без months — на сегодня (МСК), как до выбора месяца', async () => {
    housing.listHousingAllowances.mockResolvedValue([]);
    deductions.listPayrollDeductions.mockResolvedValue([]);
    await housingC.list(makeReq(), makeRes());
    await deductionsC.list(makeReq(), makeRes());
    expect(periodOf(housing.listHousingAllowances)).toEqual({ onDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(periodOf(deductions.listPayrollDeductions)).toEqual({ onDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });

  it('список месяцев — первые числа без повторов по возрастанию; all — весь период', async () => {
    housing.listHousingAllowances.mockResolvedValue([]);
    deductions.listPayrollDeductions.mockResolvedValue([]);
    await housingC.list(makeReq({ query: { months: '2026-10,2026-09,2026-10' } }), makeRes());
    await housingC.list(makeReq({ query: { months: 'all' } }), makeRes());
    await deductionsC.list(makeReq({ query: { months: '2026-10,2026-09' } }), makeRes());
    expect((housing.listHousingAllowances.mock.calls[0][0] as { period: unknown }).period)
      .toEqual({ monthStarts: ['2026-09-01', '2026-10-01'] });
    expect((housing.listHousingAllowances.mock.calls[1][0] as { period: unknown }).period).toEqual({ monthStarts: null });
    expect(periodOf(deductions.listPayrollDeductions)).toEqual({ monthStarts: ['2026-09-01', '2026-10-01'] });
  });

  it('неверный месяц — 400, список не читается', async () => {
    for (const months of ['2026-13', '', '2026-1', ['2026-09', '2026-10']]) {
      const res = makeRes();
      await deductionsC.list(makeReq({ query: { months } as never }), res);
      expect(res.statusCode, JSON.stringify(months)).toBe(400);
    }
    expect(deductions.listPayrollDeductions).not.toHaveBeenCalled();
  });
});

describe('«Удержания»: те же записи, что во вкладке кадров', () => {
  const ACTIVE = { employment_status: 'active', is_archived: false, is_contractor: false };
  const DEDUCTION = {
    id: 7, employee_id: 42, full_name: 'Каримов Акмал', department: null, position: null,
    kind_id: 4, kind_name: 'Спецодежда', subkind_id: 9, subkind_name: 'Каска', month: '2026-10', amount: '800.00',
  };
  const body = { employee_id: 42, kind_id: 4, subkind_id: 9, month: '2026-10', amount: 800 };
  const add = async (over: Record<string, unknown> = {}) => {
    const res = makeRes();
    await deductionsC.add(makeReq({ body: { ...body, ...over } }), res);
    return res;
  };

  it('добавить: работающему из «штата зарплаты»; аудит удержания с source', async () => {
    stays.getEmployeeState.mockResolvedValue(ACTIVE);
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    deductions.addDeduction.mockResolvedValue(DEDUCTION);
    const res = await add();
    expect(res.statusCode).toBe(200);
    expect(deductions.addDeduction).toHaveBeenCalledWith(42, { kind_id: 4, subkind_id: 9, month: '2026-10', amount: 800 });
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'STAFF_DEDUCTION_ADDED',
      expect.objectContaining({
        entityId: '7',
        details: expect.objectContaining({ source: 'deduction_registry', subkind_id: 9, subkind_name: 'Каска' }),
      }),
    );
  });

  it('добавить без подвида — subkind_id null', async () => {
    stays.getEmployeeState.mockResolvedValue(ACTIVE);
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    deductions.addDeduction.mockResolvedValue({ ...DEDUCTION, subkind_id: null, subkind_name: null });
    const { subkind_id: _omitted, ...withoutSubkind } = body;
    const res = makeRes();
    await deductionsC.add(makeReq({ body: withoutSubkind }), res);
    expect(res.statusCode).toBe(200);
    expect(deductions.addDeduction).toHaveBeenCalledWith(42, { kind_id: 4, subkind_id: null, month: '2026-10', amount: 800 });
  });

  it('добавить: уволенному — 400, не «штат зарплаты» — 403, подвид чужого вида — 409', async () => {
    stays.getEmployeeState.mockResolvedValueOnce({ ...ACTIVE, employment_status: 'dismissed' });
    expect((await add()).statusCode).toBe(400);

    stays.getEmployeeState.mockResolvedValue(ACTIVE);
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValueOnce(false);
    expect((await add()).statusCode).toBe(403);
    expect(deductions.addDeduction).not.toHaveBeenCalled();

    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    deductions.addDeduction.mockResolvedValue('subkind_missing');
    const missing = await add();
    expect(missing.statusCode).toBe(409);
    expect(missing.body.code).toBe('SUBKIND_MISSING');
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });

  it('добавить: сумма 0 или строкой, без вида, месяц 13, подвид строкой — 400', async () => {
    for (const patch of [{ amount: 0 }, { amount: '800' }, { kind_id: null }, { month: '2026-13' }, { subkind_id: '9' }]) {
      const res = await add(patch);
      expect(res.statusCode, JSON.stringify(patch)).toBe(400);
    }
    expect(deductions.addDeduction).not.toHaveBeenCalled();
  });

  it('изменить: только удержание «штата зарплаты»; было и стало в аудите, без изменений — аудита нет', async () => {
    const patch = { kind_id: 4, subkind_id: null, month: '2026-10', amount: 800 };
    deductions.getDeduction.mockResolvedValue(DEDUCTION);
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValueOnce(false);
    const denied = makeRes();
    await deductionsC.update(makeReq({ params: { id: '7' }, body: patch }), denied);
    expect(denied.statusCode).toBe(403);
    expect(deductions.updateDeduction).not.toHaveBeenCalled();

    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    const after = { ...DEDUCTION, subkind_id: null, subkind_name: null };
    deductions.updateDeduction.mockResolvedValueOnce({ before: DEDUCTION, after });
    const res = makeRes();
    await deductionsC.update(makeReq({ params: { id: '7' }, body: patch }), res);
    expect(res.body.data).toEqual(after);
    expect(deductions.updateDeduction).toHaveBeenCalledWith(7, patch);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'STAFF_DEDUCTION_UPDATED',
      expect.objectContaining({
        details: expect.objectContaining({
          source: 'deduction_registry',
          from: expect.objectContaining({ subkind_id: 9 }),
          to: expect.objectContaining({ subkind_id: null }),
        }),
      }),
    );

    audit.logFromRequest.mockClear();
    deductions.updateDeduction.mockResolvedValueOnce({ before: DEDUCTION, after: DEDUCTION });
    await deductionsC.update(makeReq({ params: { id: '7' }, body: { ...patch, subkind_id: 9 } }), makeRes());
    expect(audit.logFromRequest).not.toHaveBeenCalled();

    deductions.getDeduction.mockResolvedValueOnce(null);
    const missing = makeRes();
    await deductionsC.update(makeReq({ params: { id: '8' }, body: patch }), missing);
    expect(missing.statusCode).toBe(404);
  });

  it('удалить: аудит с source; чужое — 403', async () => {
    deductions.getDeduction.mockResolvedValue(DEDUCTION);
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValueOnce(false);
    const denied = makeRes();
    await deductionsC.remove(makeReq({ params: { id: '7' } }), denied);
    expect(denied.statusCode).toBe(403);
    expect(deductions.deleteDeduction).not.toHaveBeenCalled();

    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    deductions.deleteDeduction.mockResolvedValue(DEDUCTION);
    const res = makeRes();
    await deductionsC.remove(makeReq({ params: { id: '7' } }), res);
    expect(res.statusCode).toBe(200);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'STAFF_DEDUCTION_DELETED',
      expect.objectContaining({ entityId: '7', details: expect.objectContaining({ source: 'deduction_registry' }) }),
    );
  });
});

describe('«Доплата за проживание»: квартиры «Проживания»', () => {
  const body = { employee_id: 42, check_in: '2026-10-01', check_out: null, amount: 630, address: '  ул. Рабочая,  5 ' };
  const APARTMENT = {
    id: 7, employee_id: 42, full_name: 'Каримов Акмал', department: null, position: null, kind: 'apartment',
    check_in: '2026-10-01', check_out: null, address: 'ул. Рабочая, 5', amount: '630.00',
  };

  it('добавить: квартира с суммой, адрес без лишних пробелов; аудит проживания с source', async () => {
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    stays.addStay.mockResolvedValue(APARTMENT);
    const res = makeRes();
    await housingC.add(makeReq({ body }), res);
    expect(res.statusCode).toBe(200);
    expect(stays.addStay).toHaveBeenCalledWith(42, {
      kind: 'apartment', check_in: '2026-10-01', check_out: null, amount: 630, address: 'ул. Рабочая, 5',
    });
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'DORMITORY_STAY_ADDED',
      expect.objectContaining({ entityId: '7', details: expect.objectContaining({ source: 'housing_registry', kind: 'apartment' }) }),
    );
  });

  it('добавить: не «штат зарплаты» — 403; пересечение — 409; доплата за общежитие — 409 с текстом', async () => {
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValueOnce(false);
    const denied = makeRes();
    await housingC.add(makeReq({ body }), denied);
    expect(denied.statusCode).toBe(403);
    expect(stays.addStay).not.toHaveBeenCalled();

    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    stays.addStay.mockResolvedValueOnce('overlap');
    const overlap = makeRes();
    await housingC.add(makeReq({ body }), overlap);
    expect(overlap.statusCode).toBe(409);
    expect(overlap.body.code).toBe('DORMITORY_OVERLAP');

    stays.addStay.mockRejectedValueOnce(new DormitoryAllowanceConflictError(
      'HAS_DORMITORY_ALLOWANCE', 'С 01.11.2026 у сотрудника доплата за общежитие',
    ));
    const conflict = makeRes();
    await housingC.add(makeReq({ body }), conflict);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body).toEqual({
      success: false, error: 'С 01.11.2026 у сотрудника доплата за общежитие', code: 'HAS_DORMITORY_ALLOWANCE',
    });
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });

  it('добавить: без суммы, сумма 0 или строкой, выезд не позже въезда, без сотрудника — 400', async () => {
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    const bodies = [
      { ...body, amount: undefined }, { ...body, amount: 0 }, { ...body, amount: '630' },
      { ...body, check_out: '2026-10-01' }, { ...body, check_in: '2026-02-31' }, { ...body, employee_id: undefined },
    ];
    for (const bad of bodies) {
      const res = makeRes();
      await housingC.add(makeReq({ body: bad }), res);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(stays.addStay).not.toHaveBeenCalled();
  });

  it('изменить и удалить — только квартиру «штата зарплаты»; общежитие — 404', async () => {
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    stays.getStay.mockResolvedValue(APARTMENT);
    stays.updateStay.mockResolvedValueOnce({ before: APARTMENT, after: { ...APARTMENT, check_out: '2026-11-01' } });
    const res = makeRes();
    await housingC.update(makeReq({ params: { id: '7' }, body: { ...body, check_out: '2026-11-01' } }), res);
    expect(res.statusCode).toBe(200);
    expect(stays.updateStay).toHaveBeenCalledWith(7, expect.objectContaining({ check_out: '2026-11-01', amount: 630 }));
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'DORMITORY_STAY_UPDATED', expect.objectContaining({ entityId: '7' }),
    );

    stays.deleteStay.mockResolvedValueOnce(APARTMENT);
    const removed = makeRes();
    await housingC.remove(makeReq({ params: { id: '7' } }), removed);
    expect(removed.statusCode).toBe(200);

    stays.getStay.mockResolvedValue({ ...APARTMENT, kind: 'dormitory', amount: null });
    const dormitory = makeRes();
    await housingC.remove(makeReq({ params: { id: '7' } }), dormitory);
    expect(dormitory.statusCode).toBe(404);

    stays.getStay.mockResolvedValue(APARTMENT);
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(false);
    const foreign = makeRes();
    await housingC.update(makeReq({ params: { id: '7' }, body }), foreign);
    expect(foreign.statusCode).toBe(403);
    expect(stays.updateStay).toHaveBeenCalledTimes(1);
    expect(stays.deleteStay).toHaveBeenCalledTimes(1);
  });
});

describe('«Доплата»: плановая', () => {
  const body = { employee_id: 42, amount: 5000, date_from: '2026-10-01', date_to: '2026-12-31' };

  it('добавление при уже действующей — 409, без аудита', async () => {
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    supplements.savePlannedSupplement.mockResolvedValue({ status: 'exists' });
    const res = makeRes();
    await supplementsC.addPlanned(makeReq({ body }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('SUPPLEMENT_EXISTS');
    expect(supplements.savePlannedSupplement).toHaveBeenCalledWith(expect.objectContaining({ onlyIfNone: true }));
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });

  it('изменение и снятие — одно событие PAYROLL_PLANNED_SUPPLEMENT_SET', async () => {
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    supplements.savePlannedSupplement.mockResolvedValue({ status: 'saved', previous: null });
    const { employee_id: _employeeId, ...fields } = body;
    await supplementsC.setPlanned(makeReq({ params: { empId: '42' }, body: fields }), makeRes());
    await supplementsC.removePlanned(makeReq({ params: { empId: '42' } }), makeRes());
    expect(supplements.savePlannedSupplement).toHaveBeenNthCalledWith(1, expect.objectContaining({
      employeeId: 42, value: { amount: 5000, dateFrom: '2026-10-01', dateTo: '2026-12-31' }, onlyIfNone: false,
    }));
    expect(supplements.savePlannedSupplement).toHaveBeenNthCalledWith(2, expect.objectContaining({ value: null }));
    expect(audit.logFromRequest.mock.calls.map(call => call[2]))
      .toEqual(['PAYROLL_PLANNED_SUPPLEMENT_SET', 'PAYROLL_PLANNED_SUPPLEMENT_SET']);
  });

  it('без «по» — бессрочно: dateTo null', async () => {
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    supplements.savePlannedSupplement.mockResolvedValue({ status: 'saved', previous: null });
    const { date_to: _dateTo, ...open } = body;
    const res = makeRes();
    await supplementsC.addPlanned(makeReq({ body: open }), res);
    await supplementsC.addPlanned(makeReq({ body: { ...open, date_to: null } }), makeRes());
    expect(res.statusCode).toBe(200);
    expect(supplements.savePlannedSupplement.mock.calls.map(call => call[0].value)).toEqual([
      { amount: 5000, dateFrom: '2026-10-01', dateTo: null },
      { amount: 5000, dateFrom: '2026-10-01', dateTo: null },
    ]);
  });

  it('окончание раньше начала — 400; чужой — 403', async () => {
    const order = makeRes();
    await supplementsC.addPlanned(makeReq({ body: { ...body, date_to: '2026-09-30' } }), order);
    expect(order.statusCode).toBe(400);

    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(false);
    const denied = makeRes();
    await supplementsC.addPlanned(makeReq({ body }), denied);
    expect(denied.statusCode).toBe(403);
    expect(supplements.savePlannedSupplement).not.toHaveBeenCalled();
  });
});

describe('«Доплата»: разовая', () => {
  const ONE_TIME = { id: 5, employee_id: 42, full_name: 'Каримов Акмал', month: '2026-10', amount: '10000.00', reason: 'Премия' };

  it('добавление: основание без лишних пробелов, аудит', async () => {
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    supplements.addOneTimeSupplement.mockResolvedValue(ONE_TIME);
    const res = makeRes();
    await supplementsC.addOneTime(makeReq({
      body: { employee_id: 42, month: '2026-10', amount: 10000, reason: '  Премия  ' },
    }), res);
    expect(res.statusCode).toBe(200);
    expect(supplements.addOneTimeSupplement).toHaveBeenCalledWith(42, { month: '2026-10', amount: 10000, reason: 'Премия' });
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'PAYROLL_ONE_TIME_SUPPLEMENT_ADDED', expect.objectContaining({ entityId: '5' }),
    );
  });

  it('пустое основание и месяц 13 — 400', async () => {
    for (const patch of [{ reason: '   ' }, { month: '2026-13' }]) {
      const res = makeRes();
      await supplementsC.addOneTime(makeReq({
        body: { employee_id: 42, month: '2026-10', amount: 10000, reason: 'Премия', ...patch },
      }), res);
      expect(res.statusCode, JSON.stringify(patch)).toBe(400);
    }
    expect(supplements.addOneTimeSupplement).not.toHaveBeenCalled();
  });

  it('правка и удаление: право проверяется по сотруднику строки', async () => {
    supplements.getOneTimeSupplement.mockResolvedValue(ONE_TIME);
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(false);
    const res = makeRes();
    await supplementsC.removeOneTime(makeReq({ params: { id: '5' } }), res);
    expect(res.statusCode).toBe(403);
    expect(registryScope.canWritePayrollRegistryEmployee).toHaveBeenCalledWith(expect.anything(), 42);
    expect(supplements.deleteOneTimeSupplement).not.toHaveBeenCalled();

    supplements.getOneTimeSupplement.mockResolvedValue(null);
    const missing = makeRes();
    await supplementsC.updateOneTime(makeReq({ params: { id: '6' }, body: {} }), missing);
    expect(missing.statusCode).toBe(404);
  });
});

describe('«Без проезда»', () => {
  const STOP = {
    id: 3, employee_id: 42, full_name: 'Каримов Акмал', department: null, position: null,
    date_from: '2026-08-01', date_to: null,
  };

  it('пересечение — 409; «по» раньше «с» — 400', async () => {
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    stops.addCompensationStop.mockResolvedValue('overlap');
    const res = makeRes();
    await stopsC.add(makeReq({ body: { employee_id: 42, date_from: '2026-08-01' } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('STOP_OVERLAP');
    expect(stops.addCompensationStop).toHaveBeenCalledWith(42, { date_from: '2026-08-01', date_to: null });

    const order = makeRes();
    await stopsC.add(makeReq({ body: { employee_id: 42, date_from: '2026-08-01', date_to: '2026-07-31' } }), order);
    expect(order.statusCode).toBe(400);
  });

  it('возобновили — «по»: аудит «было → стало»', async () => {
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    stops.getCompensationStop.mockResolvedValue(STOP);
    stops.updateCompensationStop.mockResolvedValue({ before: STOP, after: { ...STOP, date_to: '2026-10-31' } });
    const res = makeRes();
    await stopsC.update(makeReq({ params: { id: '3' }, body: { date_from: '2026-08-01', date_to: '2026-10-31' } }), res);
    expect(res.body.data.date_to).toBe('2026-10-31');
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'PAYROLL_COMPENSATION_STOP_UPDATED',
      expect.objectContaining({ details: expect.objectContaining({ to: expect.objectContaining({ date_to: '2026-10-31' }) }) }),
    );
  });
});

describe('экспорт', () => {
  it('неизвестная таблица — 404', async () => {
    for (const table of ['unknown', 'constructor', '__proto__']) {
      const res = makeRes();
      await registryC.exportTable(makeReq({ params: { table } }), res);
      expect(res.statusCode, table).toBe(404);
    }
  });
});
