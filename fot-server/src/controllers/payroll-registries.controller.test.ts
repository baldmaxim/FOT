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

const housing = vi.hoisted(() => ({ listHousingAllowances: vi.fn(), setHousingFrom: vi.fn() }));
vi.mock('../services/payroll/payroll-housing.service.js', () => housing);

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

const deductionKinds = vi.hoisted(() => ({
  listDeductionRegistry: vi.fn(),
  allDeductionKindsExist: vi.fn(),
  setEmployeeDeductionKinds: vi.fn(),
}));
vi.mock('../services/payroll/payroll-deduction-kinds.service.js', () => deductionKinds);

const termsAmount = vi.hoisted(() => ({ setTermsAmountFrom: vi.fn() }));
vi.mock('../services/payroll/payroll-terms-amount.service.js', () => termsAmount);

// Порядок вызовов в транзакции «Удержаний»: блокировка, проверка видов, виды, сумма.
const calls = vi.hoisted(() => [] as string[]);
const terms = vi.hoisted(() => ({ lockPayrollEmployee: vi.fn() }));
vi.mock('../services/payroll/payroll-terms.service.js', () => terms);

// Транзакция в тесте — вызов колбэка с фиктивным клиентом: запросы делает замоканный сервис.
vi.mock('../config/postgres.js', () => ({ withTransaction: vi.fn(async (fn: (client: unknown) => unknown) => fn({})) }));

const audit = vi.hoisted(() => ({ logFromRequest: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock('../services/audit.service.js', () => ({ auditService: audit }));

import { payrollHousingController as housingC } from './payroll-housing.controller.js';
import { payrollSupplementsController as supplementsC } from './payroll-supplements.controller.js';
import { payrollCompensationStopsController as stopsC } from './payroll-compensation-stops.controller.js';
import { payrollRegistryController as registryC } from './payroll-registry.controller.js';

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
  calls.length = 0;
  registryScope.resolvePayrollStaffScope.mockResolvedValue(SCOPE);
  payrollScope.resolvePayrollEditPredicate.mockResolvedValue((employeeId: number) => employeeId !== 99);
  terms.lockPayrollEmployee.mockImplementation(async () => { calls.push('lock'); });
  deductionKinds.allDeductionKindsExist.mockImplementation(async () => { calls.push('kinds-exist'); return true; });
  deductionKinds.setEmployeeDeductionKinds.mockImplementation(async () => {
    calls.push('kinds');
    return { added: [], removed: [] };
  });
  termsAmount.setTermsAmountFrom.mockImplementation(async () => {
    calls.push('amount');
    return { status: 'unchanged' };
  });
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
    deductionKinds.listDeductionRegistry.mockResolvedValue([
      { employee_id: 42, full_name: 'Каримов Акмал', kinds: ['ТМЦ'], kind_ids: [2], amount: null },
      { employee_id: 99, full_name: 'Сам Себе', kinds: [], kind_ids: [], amount: '1500.00' },
    ]);
    stops.listCompensationStops.mockResolvedValue([]);
    const res = makeRes();
    await registryC.listDeductions(makeReq(), res);
    await stopsC.list(makeReq(), makeRes());
    expect(deductionKinds.listDeductionRegistry).toHaveBeenCalledWith(expect.objectContaining(SCOPE));
    expect(stops.listCompensationStops).toHaveBeenCalledWith(SCOPE);
    expect(res.body.data.map((row: { can_edit: boolean }) => row.can_edit)).toEqual([true, false]);
  });
});

describe('месяцы в «Доплате за проживание» и «Удержаниях»', () => {
  const periodOf = (mock: { mock: { calls: unknown[][] } }) => (mock.mock.calls[0][0] as { period: unknown }).period;

  it('старый клиент без months — на сегодня (МСК), как до выбора месяца', async () => {
    housing.listHousingAllowances.mockResolvedValue([]);
    deductionKinds.listDeductionRegistry.mockResolvedValue([]);
    await housingC.list(makeReq(), makeRes());
    await registryC.listDeductions(makeReq(), makeRes());
    expect(periodOf(housing.listHousingAllowances)).toEqual({ onDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(periodOf(deductionKinds.listDeductionRegistry)).toEqual({ onDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });

  it('список месяцев — первые числа без повторов по возрастанию; all — весь период', async () => {
    housing.listHousingAllowances.mockResolvedValue([]);
    await housingC.list(makeReq({ query: { months: '2026-10,2026-09,2026-10' } }), makeRes());
    await housingC.list(makeReq({ query: { months: 'all' } }), makeRes());
    expect((housing.listHousingAllowances.mock.calls[0][0] as { period: unknown }).period)
      .toEqual({ monthStarts: ['2026-09-01', '2026-10-01'] });
    expect((housing.listHousingAllowances.mock.calls[1][0] as { period: unknown }).period).toEqual({ monthStarts: null });
  });

  it('неверный месяц — 400, список не читается', async () => {
    for (const months of ['2026-13', '', '2026-1', ['2026-09', '2026-10']]) {
      const res = makeRes();
      await registryC.listDeductions(makeReq({ query: { months } as never }), res);
      expect(res.statusCode, JSON.stringify(months)).toBe(400);
    }
    expect(deductionKinds.listDeductionRegistry).not.toHaveBeenCalled();
  });
});

describe('«Удержания»: сохранение из таблицы', () => {
  const body = { kind_ids: [2, 5], amount: 1500, effective_from: '2026-10-19' };
  const save = async (over: Record<string, unknown> = {}) => {
    const res = makeRes();
    await registryC.saveDeductions(makeReq({ params: { empId: '42' }, body: { ...body, ...over } }), res);
    return res;
  };

  it('не «штат зарплаты» или чужой — 403, транзакции нет', async () => {
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(false);
    const res = await save();
    expect(res.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it('блокировка сотрудника — первой, затем виды, затем сумма', async () => {
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    const res = await save();
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['lock', 'kinds-exist', 'kinds', 'amount']);
    expect(deductionKinds.allDeductionKindsExist).toHaveBeenCalledWith([2, 5], {});
    expect(termsAmount.setTermsAmountFrom).toHaveBeenCalledWith({}, {
      column: 'deduction_amount', employeeId: 42, amount: 1500, from: '2026-10-19', createdBy: 'user-1',
    });
  });

  it('неизвестный вид — 400, ничего не пишется', async () => {
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    deductionKinds.allDeductionKindsExist.mockResolvedValue(false);
    const res = await save();
    expect(res.statusCode).toBe(400);
    expect(deductionKinds.setEmployeeDeductionKinds).not.toHaveBeenCalled();
    expect(termsAmount.setTermsAmountFrom).not.toHaveBeenCalled();
  });

  it('сумма без условий на дату — 409 NO_TERMS (транзакция откатывается), аудита нет', async () => {
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    deductionKinds.setEmployeeDeductionKinds.mockResolvedValue({ added: [2, 5], removed: [] });
    termsAmount.setTermsAmountFrom.mockResolvedValue({ status: 'no_terms' });
    const res = await save();
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('NO_TERMS');
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });

  it('сумма null без условий — сохраняются только виды, аудит видов', async () => {
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    deductionKinds.setEmployeeDeductionKinds.mockResolvedValue({ added: [2], removed: [7] });
    termsAmount.setTermsAmountFrom.mockResolvedValue({ status: 'no_terms' });
    const res = await save({ amount: null });
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ changed: true });
    expect(audit.logFromRequest.mock.calls.map(call => call[2])).toEqual(['PAYROLL_EMPLOYEE_DEDUCTIONS_SAVED']);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'PAYROLL_EMPLOYEE_DEDUCTIONS_SAVED',
      expect.objectContaining({ details: { source: 'deduction_registry', employee_id: 42, added: [2], removed: [7] } }),
    );
  });

  it('аудит — только изменившиеся части: сумма с source deduction_registry', async () => {
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    termsAmount.setTermsAmountFrom.mockResolvedValue({
      status: 'saved', termsId: 21, previousTermsId: 20, previousAmount: '1000.00', laterUpdated: 0,
    });
    const res = await save();
    expect(res.body.data).toEqual({ changed: true });
    expect(audit.logFromRequest.mock.calls.map(call => call[2])).toEqual(['PAYROLL_TERMS_ASSIGNED']);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'PAYROLL_TERMS_ASSIGNED',
      expect.objectContaining({
        entityId: '21',
        details: expect.objectContaining({
          source: 'deduction_registry', deduction_amount: 1500, previous_deduction_amount: '1000.00',
        }),
      }),
    );

    audit.logFromRequest.mockClear();
    termsAmount.setTermsAmountFrom.mockResolvedValue({ status: 'unchanged' });
    const same = await save();
    expect(same.body.data).toEqual({ changed: false });
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });

  it('сумма 0, строкой, вид не массивом, дата 31.02 — 400', async () => {
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    for (const patch of [{ amount: 0 }, { amount: '1500' }, { kind_ids: 'x' }, { effective_from: '2026-02-31' }]) {
      const res = await save(patch);
      expect(res.statusCode, JSON.stringify(patch)).toBe(400);
    }
    expect(calls).toEqual([]);
  });
});

describe('«Доплата за проживание»', () => {
  const body = { amount: 630, effective_from: '2026-10-19' };

  it('не «штат зарплаты» (подрядчик, уволенный, чужой) — 403, ничего не пишется', async () => {
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(false);
    const res = makeRes();
    await housingC.set(makeReq({ params: { empId: '42' }, body }), res);
    expect(res.statusCode).toBe(403);
    expect(housing.setHousingFrom).not.toHaveBeenCalled();
  });

  it('без условий на дату — 409 NO_TERMS', async () => {
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    housing.setHousingFrom.mockResolvedValue({ status: 'no_terms' });
    const res = makeRes();
    await housingC.set(makeReq({ params: { empId: '42' }, body }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('NO_TERMS');
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });

  it('сохранено — событие условий с source; без изменений — без аудита', async () => {
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    housing.setHousingFrom.mockResolvedValueOnce({
      status: 'saved', termsId: 12, previousTermsId: 11, previousAmount: null, laterUpdated: 1,
    });
    const res = makeRes();
    await housingC.set(makeReq({ params: { empId: '42' }, body }), res);
    expect(res.body.data).toEqual({ changed: true });
    expect(housing.setHousingFrom).toHaveBeenCalledWith({}, {
      employeeId: 42, amount: 630, from: '2026-10-19', createdBy: 'user-1',
    });
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'PAYROLL_TERMS_ASSIGNED',
      expect.objectContaining({
        entityId: '12',
        details: expect.objectContaining({ source: 'housing_registry', housing_compensation: 630, previous_terms_id: 11 }),
      }),
    );

    housing.setHousingFrom.mockResolvedValueOnce({ status: 'unchanged' });
    const same = makeRes();
    await housingC.set(makeReq({ params: { empId: '42' }, body }), same);
    expect(same.body.data).toEqual({ changed: false });
    expect(audit.logFromRequest).toHaveBeenCalledTimes(1);
  });

  it('снять — amount null; сумма 0 или строкой — 400', async () => {
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
    housing.setHousingFrom.mockResolvedValue({ status: 'unchanged' });
    await housingC.set(makeReq({ params: { empId: '42' }, body: { amount: null, effective_from: '2026-10-19' } }), makeRes());
    expect(housing.setHousingFrom).toHaveBeenCalledWith({}, expect.objectContaining({ amount: null }));

    for (const amount of [0, '630', -5]) {
      const res = makeRes();
      await housingC.set(makeReq({ params: { empId: '42' }, body: { amount, effective_from: '2026-10-19' } }), res);
      expect(res.statusCode, String(amount)).toBe(400);
    }
    const badDate = makeRes();
    await housingC.set(makeReq({ params: { empId: '42' }, body: { amount: 630, effective_from: '2026-02-31' } }), badDate);
    expect(badDate.statusCode).toBe(400);
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
