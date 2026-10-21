import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const svc = vi.hoisted(() => ({
  listDeductions: vi.fn(),
  getDeduction: vi.fn(),
  addDeduction: vi.fn(),
  updateDeduction: vi.fn(),
  deleteDeduction: vi.fn(),
}));
vi.mock('../services/staff-deductions.service.js', () => svc);

const employees = vi.hoisted(() => ({ searchCandidates: vi.fn(), getEmployeeState: vi.fn() }));
vi.mock('../services/dormitory-stays.service.js', () => employees);

const kinds = vi.hoisted(() => ({
  addDeductionKindWithDefault: vi.fn(),
  updateDeductionKind: vi.fn(),
  deleteDeductionKind: vi.fn(),
}));
vi.mock('../services/payroll/payroll-deduction-kinds.service.js', () => kinds);

const scope = vi.hoisted(() => ({
  canWriteEmployeeInScope: vi.fn(),
  canSeeEmployeeInStaffList: vi.fn(),
  resolveStaffRosterEmployeeIds: vi.fn(),
}));
vi.mock('../services/data-scope.service.js', () => ({ canWriteEmployeeInScope: scope.canWriteEmployeeInScope }));
vi.mock('../services/employee-scope-filter.service.js', () => ({
  canSeeEmployeeInStaffList: scope.canSeeEmployeeInStaffList,
  resolveStaffRosterEmployeeIds: scope.resolveStaffRosterEmployeeIds,
}));

const audit = vi.hoisted(() => ({ logFromRequest: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock('../services/audit.service.js', () => ({ auditService: audit }));

import { staffDeductionsController as c } from './staff-deductions.controller.js';

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

const DEDUCTION = {
  id: 7,
  employee_id: 42,
  full_name: 'Каримов Акмал',
  department: 'бр.Менгбоев Г.И.',
  position: 'Монтажник',
  kind_id: 3,
  kind_name: 'Штраф за мусор',
  subkind_id: null,
  subkind_name: null,
  month: '2026-10',
  amount: '5000.00',
};

const ACTIVE = { id: 42, employment_status: 'active', is_archived: false, is_contractor: false };
const DISMISSED = { id: 42, employment_status: 'dismissed', is_archived: false, is_contractor: false };

beforeEach(() => {
  vi.resetAllMocks();
});

describe('список и поиск', () => {
  it('охват списка кадров; «все» — без ограничения', async () => {
    svc.listDeductions.mockResolvedValue([DEDUCTION]);
    scope.resolveStaffRosterEmployeeIds.mockResolvedValueOnce(new Set([42, 43]));
    const res = makeRes();
    await c.list(makeReq(), res);
    expect(res.body.data).toEqual([DEDUCTION]);
    expect(svc.listDeductions).toHaveBeenLastCalledWith({ employeeIds: [42, 43] });

    scope.resolveStaffRosterEmployeeIds.mockResolvedValueOnce('all');
    await c.list(makeReq(), makeRes());
    expect(svc.listDeductions).toHaveBeenLastCalledWith({ employeeIds: null });
  });

  it('поиск — от 2 символов, в охвате списка кадров', async () => {
    const short = makeRes();
    await c.searchEmployees(makeReq({ query: { q: ' к ' } }), short);
    expect(short.body.data).toEqual([]);
    expect(employees.searchCandidates).not.toHaveBeenCalled();

    scope.resolveStaffRosterEmployeeIds.mockResolvedValue(new Set([42]));
    employees.searchCandidates.mockResolvedValue([{ id: 42, full_name: 'Каримов Акмал', department: null, position: null }]);
    const res = makeRes();
    await c.searchEmployees(makeReq({ query: { q: 'Кар' } }), res);
    expect(employees.searchCandidates).toHaveBeenCalledWith('Кар', [42]);
    expect(res.body.data).toHaveLength(1);
  });
});

describe('добавление', () => {
  const body = { employee_id: 42, kind_id: 3, month: '2026-10', amount: 5000 };

  it('работающий в охвате — добавлен, запись в аудит', async () => {
    employees.getEmployeeState.mockResolvedValue(ACTIVE);
    scope.canWriteEmployeeInScope.mockResolvedValue(true);
    svc.addDeduction.mockResolvedValue(DEDUCTION);
    const res = makeRes();

    await c.add(makeReq({ body }), res);

    expect(res.statusCode).toBe(200);
    expect(svc.addDeduction).toHaveBeenCalledWith(42, { kind_id: 3, subkind_id: null, month: '2026-10', amount: 5000 });
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'STAFF_DEDUCTION_ADDED',
      expect.objectContaining({
        entityType: 'staff_deductions',
        entityId: '7',
        details: expect.objectContaining({ employee_id: 42, kind_name: 'Штраф за мусор', month: '2026-10', amount: '5000.00' }),
      }),
    );
  });

  it('неверный месяц, сумма, вид, сотрудник — 400 без записи', async () => {
    const bodies = [
      { ...body, month: '2026-13' },
      { ...body, month: '2026-10-01' },
      { ...body, month: undefined },
      { ...body, amount: 0 },
      { ...body, amount: -1 },
      { ...body, amount: '5000' },
      { ...body, amount: 10_000_000_000 },
      { ...body, kind_id: undefined },
      { ...body, kind_id: 1.5 },
      { ...body, subkind_id: '4' },
      { ...body, subkind_id: 0 },
      { ...body, employee_id: undefined },
      { ...body, employee_id: '42' },
    ];
    for (const bad of bodies) {
      const res = makeRes();
      await c.add(makeReq({ body: bad }), res);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(employees.getEmployeeState).not.toHaveBeenCalled();
    expect(svc.addDeduction).not.toHaveBeenCalled();
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
      employees.getEmployeeState.mockResolvedValue(state);
      scope.canWriteEmployeeInScope.mockResolvedValue(canWrite);
      const res = makeRes();
      await c.add(makeReq({ body }), res);
      expect(res.statusCode, JSON.stringify(state)).toBe(status);
    }
    expect(svc.addDeduction).not.toHaveBeenCalled();
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });

  it('вид или подвид удалили в соседнем окне (или подвид не этого вида) — 409 без аудита', async () => {
    employees.getEmployeeState.mockResolvedValue(ACTIVE);
    scope.canWriteEmployeeInScope.mockResolvedValue(true);
    for (const [missing, code] of [['kind_missing', 'KIND_MISSING'], ['subkind_missing', 'SUBKIND_MISSING']]) {
      svc.addDeduction.mockResolvedValueOnce(missing);
      const res = makeRes();
      await c.add(makeReq({ body: { ...body, subkind_id: 4 } }), res);
      expect(res.statusCode).toBe(409);
      expect(res.body.code).toBe(code);
    }
    expect(svc.addDeduction).toHaveBeenLastCalledWith(42, { kind_id: 3, subkind_id: 4, month: '2026-10', amount: 5000 });
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });
});

describe('правка', () => {
  const body = { kind_id: 3, subkind_id: null, month: '2026-11', amount: 3000 };
  const after = { ...DEDUCTION, month: '2026-11', amount: '3000.00' };

  it('было и стало в аудите; без изменений — аудита нет', async () => {
    svc.getDeduction.mockResolvedValue(DEDUCTION);
    scope.canWriteEmployeeInScope.mockResolvedValue(true);
    svc.updateDeduction.mockResolvedValueOnce({ before: DEDUCTION, after });
    const res = makeRes();
    await c.update(makeReq({ params: { id: '7' }, body }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual(after);
    expect(svc.updateDeduction).toHaveBeenCalledWith(7, body);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'STAFF_DEDUCTION_UPDATED',
      expect.objectContaining({
        details: { from: expect.objectContaining({ month: '2026-10' }), to: expect.objectContaining({ month: '2026-11', amount: '3000.00' }) },
      }),
    );

    svc.updateDeduction.mockResolvedValueOnce({ before: after, after });
    await c.update(makeReq({ params: { id: '7' }, body }), makeRes());
    expect(audit.logFromRequest).toHaveBeenCalledTimes(1);

    // Сменился только подвид — тоже правка.
    const withSubkind = { ...after, subkind_id: 4, subkind_name: 'Курение' };
    svc.updateDeduction.mockResolvedValueOnce({ before: after, after: withSubkind });
    await c.update(makeReq({ params: { id: '7' }, body: { ...body, subkind_id: 4 } }), makeRes());
    expect(svc.updateDeduction).toHaveBeenLastCalledWith(7, { ...body, subkind_id: 4 });
    expect(audit.logFromRequest).toHaveBeenCalledTimes(2);
    expect(audit.logFromRequest).toHaveBeenLastCalledWith(
      expect.anything(), 'user-1', 'STAFF_DEDUCTION_UPDATED',
      expect.objectContaining({ details: expect.objectContaining({ to: expect.objectContaining({ subkind_name: 'Курение' }) }) }),
    );
  });

  it('уволенный: виден в списке кадров — можно; не виден — 403; работающий вне охвата — 403', async () => {
    svc.getDeduction.mockResolvedValue(DEDUCTION);
    scope.canWriteEmployeeInScope.mockResolvedValue(false);
    svc.updateDeduction.mockResolvedValue({ before: DEDUCTION, after });

    employees.getEmployeeState.mockResolvedValue(DISMISSED);
    scope.canSeeEmployeeInStaffList.mockResolvedValueOnce(true);
    const visible = makeRes();
    await c.update(makeReq({ params: { id: '7' }, body }), visible);
    expect(visible.statusCode).toBe(200);

    scope.canSeeEmployeeInStaffList.mockResolvedValueOnce(false);
    const hidden = makeRes();
    await c.update(makeReq({ params: { id: '7' }, body }), hidden);
    expect(hidden.statusCode).toBe(403);

    employees.getEmployeeState.mockResolvedValue(ACTIVE);
    scope.canSeeEmployeeInStaffList.mockResolvedValue(true);
    const foreign = makeRes();
    await c.update(makeReq({ params: { id: '7' }, body }), foreign);
    expect(foreign.statusCode).toBe(403);
    expect(svc.updateDeduction).toHaveBeenCalledTimes(1);
  });

  it('нет записи / кривой id — 404; вида нет — 409; нулевая сумма — 400', async () => {
    svc.getDeduction.mockResolvedValueOnce(null);
    const missing = makeRes();
    await c.update(makeReq({ params: { id: '99' }, body }), missing);
    expect(missing.statusCode).toBe(404);

    const badId = makeRes();
    await c.update(makeReq({ params: { id: 'x' }, body }), badId);
    expect(badId.statusCode).toBe(404);

    svc.getDeduction.mockResolvedValueOnce(DEDUCTION);
    scope.canWriteEmployeeInScope.mockResolvedValueOnce(true);
    svc.updateDeduction.mockResolvedValueOnce('kind_missing');
    const kindMissing = makeRes();
    await c.update(makeReq({ params: { id: '7' }, body }), kindMissing);
    expect(kindMissing.statusCode).toBe(409);

    const zero = makeRes();
    await c.update(makeReq({ params: { id: '7' }, body: { ...body, amount: 0 } }), zero);
    expect(zero.statusCode).toBe(400);
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });
});

describe('удаление', () => {
  it('в охвате — удалено и в аудите; чужое — 403; нет — 404', async () => {
    svc.getDeduction.mockResolvedValue(DEDUCTION);
    scope.canWriteEmployeeInScope.mockResolvedValueOnce(true);
    svc.deleteDeduction.mockResolvedValueOnce(DEDUCTION);
    const res = makeRes();
    await c.remove(makeReq({ params: { id: '7' } }), res);
    expect(res.statusCode).toBe(200);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'STAFF_DEDUCTION_DELETED', expect.objectContaining({ entityId: '7' }),
    );

    scope.canWriteEmployeeInScope.mockResolvedValueOnce(false);
    employees.getEmployeeState.mockResolvedValueOnce(ACTIVE);
    const foreign = makeRes();
    await c.remove(makeReq({ params: { id: '7' } }), foreign);
    expect(foreign.statusCode).toBe(403);

    svc.getDeduction.mockResolvedValueOnce(null);
    const missing = makeRes();
    await c.remove(makeReq({ params: { id: '8' } }), missing);
    expect(missing.statusCode).toBe(404);
    expect(svc.deleteDeduction).toHaveBeenCalledTimes(1);
  });
});

describe('виды удержаний', () => {
  const KIND = { id: 3, name: 'Штраф за мусор', default_amount: '5000.00' };

  it('добавить: сумма по умолчанию необязательна; занято — 409; пустое название, 0 — 400', async () => {
    kinds.addDeductionKindWithDefault.mockResolvedValueOnce(KIND);
    const res = makeRes();
    await c.addKind(makeReq({ body: { name: '  Штраф  за мусор ', default_amount: 5000 } }), res);
    expect(res.statusCode).toBe(200);
    expect(kinds.addDeductionKindWithDefault).toHaveBeenLastCalledWith('Штраф за мусор', 5000);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'PAYROLL_DEDUCTION_KIND_ADDED',
      expect.objectContaining({ details: { name: 'Штраф за мусор', default_amount: '5000.00' } }),
    );

    kinds.addDeductionKindWithDefault.mockResolvedValueOnce({ id: 4, name: 'ТМЦ', default_amount: null });
    await c.addKind(makeReq({ body: { name: 'ТМЦ' } }), makeRes());
    expect(kinds.addDeductionKindWithDefault).toHaveBeenLastCalledWith('ТМЦ', null);

    kinds.addDeductionKindWithDefault.mockResolvedValueOnce(null);
    const duplicate = makeRes();
    await c.addKind(makeReq({ body: { name: 'тмц', default_amount: null } }), duplicate);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.body.code).toBe('DUPLICATE_KIND');

    for (const bad of [{ name: '   ' }, { name: 'Штраф', default_amount: 0 }, { name: 'Штраф', default_amount: '100' }]) {
      const res400 = makeRes();
      await c.addKind(makeReq({ body: bad }), res400);
      expect(res400.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(kinds.addDeductionKindWithDefault).toHaveBeenCalledTimes(3);
  });

  it('изменить: было → стало в аудите, без изменений — без аудита; нет — 404; занято — 409', async () => {
    const after = { ...KIND, default_amount: '3000.00' };
    kinds.updateDeductionKind.mockResolvedValueOnce({ before: KIND, after });
    const res = makeRes();
    await c.updateKind(makeReq({ params: { id: '3' }, body: { name: 'Штраф за мусор', default_amount: 3000 } }), res);
    expect(res.body.data).toEqual(after);
    expect(kinds.updateDeductionKind).toHaveBeenLastCalledWith(3, 'Штраф за мусор', 3000);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'PAYROLL_DEDUCTION_KIND_UPDATED',
      expect.objectContaining({
        details: { from: { name: 'Штраф за мусор', default_amount: '5000.00' }, to: { name: 'Штраф за мусор', default_amount: '3000.00' } },
      }),
    );

    kinds.updateDeductionKind.mockResolvedValueOnce({ before: after, after });
    await c.updateKind(makeReq({ params: { id: '3' }, body: { name: 'Штраф за мусор', default_amount: 3000 } }), makeRes());
    expect(audit.logFromRequest).toHaveBeenCalledTimes(1);

    kinds.updateDeductionKind.mockResolvedValueOnce(null);
    const missing = makeRes();
    await c.updateKind(makeReq({ params: { id: '99' }, body: { name: 'Х' } }), missing);
    expect(missing.statusCode).toBe(404);

    kinds.updateDeductionKind.mockResolvedValueOnce('duplicate');
    const duplicate = makeRes();
    await c.updateKind(makeReq({ params: { id: '3' }, body: { name: 'ТМЦ' } }), duplicate);
    expect(duplicate.statusCode).toBe(409);
  });

  it('удалить: свободный — удалён; назначен сотрудникам — 409 с их числом', async () => {
    kinds.deleteDeductionKind.mockResolvedValueOnce({ id: 3, name: 'Штраф за мусор' });
    const res = makeRes();
    await c.deleteKind(makeReq({ params: { id: '3' } }), res);
    expect(res.statusCode).toBe(200);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'PAYROLL_DEDUCTION_KIND_DELETED', expect.objectContaining({ details: { name: 'Штраф за мусор' } }),
    );

    kinds.deleteDeductionKind.mockResolvedValueOnce({ inUse: 2 });
    const used = makeRes();
    await c.deleteKind(makeReq({ params: { id: '3' } }), used);
    expect(used.statusCode).toBe(409);
    expect(used.body).toMatchObject({ code: 'KIND_IN_USE', employees: 2 });

    kinds.deleteDeductionKind.mockResolvedValueOnce(null);
    const missing = makeRes();
    await c.deleteKind(makeReq({ params: { id: '3' } }), missing);
    expect(missing.statusCode).toBe(404);
    expect(audit.logFromRequest).toHaveBeenCalledTimes(1);
  });
});
