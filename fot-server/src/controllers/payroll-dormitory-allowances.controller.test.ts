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

const allowances = vi.hoisted(() => ({
  listDormitoryAllowances: vi.fn(),
  getDormitoryAllowance: vi.fn(),
  addDormitoryAllowance: vi.fn(),
  updateDormitoryAllowance: vi.fn(),
  deleteDormitoryAllowance: vi.fn(),
}));
// Ошибка правила и код пересечения — настоящие: контроллер различает их через instanceof и код.
vi.mock('../services/payroll/payroll-dormitory-allowances.service.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/payroll/payroll-dormitory-allowances.service.js')>(),
  ...allowances,
}));

// Транзакция в тесте — вызов колбэка с фиктивным клиентом: запросы делает замоканный сервис.
const TX_CLIENT = { tx: true };
vi.mock('../config/postgres.js', () => ({ withTransaction: vi.fn(async (fn: (client: unknown) => unknown) => fn(TX_CLIENT)) }));

const audit = vi.hoisted(() => ({ logFromRequestWithClient: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock('../services/audit.service.js', () => ({ auditService: audit }));

import { DormitoryAllowanceConflictError } from '../services/payroll/payroll-dormitory-allowances.service.js';
import { payrollDormitoryAllowancesController as controller } from './payroll-dormitory-allowances.controller.js';

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

const ROW = {
  id: 5, employee_id: 42, full_name: 'Каримов Акмал', department: null, position: null,
  date_from: '2026-11-01', date_to: null, amount: '500.00', dormitory_stays: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  registryScope.resolvePayrollStaffScope.mockResolvedValue({ contractorRootId: 'root', departmentIds: null });
  payrollScope.resolvePayrollEditPredicate.mockResolvedValue((employeeId: number) => employeeId !== 99);
  registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(true);
});

describe('«Доплата за общежитие»: список', () => {
  it('строки с признаком правки по охвату', async () => {
    allowances.listDormitoryAllowances.mockResolvedValue([ROW, { ...ROW, id: 6, employee_id: 99 }]);
    const res = makeRes();
    await controller.list(makeReq(), res);
    expect(res.body.data.map((row: { id: number; can_edit: boolean }) => [row.id, row.can_edit])).toEqual([[5, true], [6, false]]);
  });
});

describe('«Доплата за общежитие»: добавление', () => {
  const body = { employee_id: 42, date_from: '2026-11-01' };

  it('не «штат зарплаты» — 403, ничего не пишется', async () => {
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(false);
    const res = makeRes();
    await controller.add(makeReq({ body }), res);
    expect(res.statusCode).toBe(403);
    expect(allowances.addDormitoryAllowance).not.toHaveBeenCalled();
  });

  it('«по» раньше «с», нет даты — 400', async () => {
    for (const bad of [{ ...body, date_to: '2026-10-31' }, { employee_id: 42 }, { ...body, date_from: '2026-02-31' }]) {
      const res = makeRes();
      await controller.add(makeReq({ body: bad }), res);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(allowances.addDormitoryAllowance).not.toHaveBeenCalled();
  });

  it('добавлено — аудит тем же клиентом транзакции; «по» не передано — бессрочно', async () => {
    allowances.addDormitoryAllowance.mockResolvedValue({ status: 'saved', allowance: ROW });
    const res = makeRes();
    await controller.add(makeReq({ body }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual(ROW);
    expect(allowances.addDormitoryAllowance).toHaveBeenCalledWith(TX_CLIENT, 42, { date_from: '2026-11-01', date_to: null });
    expect(audit.logFromRequestWithClient).toHaveBeenCalledWith(
      TX_CLIENT, expect.anything(), 'user-1', 'PAYROLL_DORMITORY_ALLOWANCE_ADDED',
      expect.objectContaining({ entityId: '5', details: expect.objectContaining({ employee_id: 42, date_to: null }) }),
    );
  });

  it('повтор того же периода — 200 с той же строкой, аудит не пишется', async () => {
    allowances.addDormitoryAllowance.mockResolvedValue({ status: 'unchanged', allowance: ROW });
    const res = makeRes();
    await controller.add(makeReq({ body }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual(ROW);
    expect(audit.logFromRequestWithClient).not.toHaveBeenCalled();
  });

  it('правила — 409 с кодом и текстом сервиса; пересечение периодов (23P01) — 409 ALLOWANCE_OVERLAP', async () => {
    for (const code of ['LIVES_IN_DORMITORY', 'HAS_HOUSING'] as const) {
      allowances.addDormitoryAllowance.mockRejectedValueOnce(new DormitoryAllowanceConflictError(code, `текст ${code}`));
      const res = makeRes();
      await controller.add(makeReq({ body }), res);
      expect(res.statusCode).toBe(409);
      expect(res.body).toEqual({ success: false, error: `текст ${code}`, code });
    }
    allowances.addDormitoryAllowance.mockRejectedValueOnce(Object.assign(new Error('exclusion'), { code: '23P01' }));
    const overlap = makeRes();
    await controller.add(makeReq({ body }), overlap);
    expect(overlap.statusCode).toBe(409);
    expect(overlap.body.code).toBe('ALLOWANCE_OVERLAP');
    expect(audit.logFromRequestWithClient).not.toHaveBeenCalled();
  });

  it('сбой аудита — 500: запись откатывается вместе с транзакцией', async () => {
    allowances.addDormitoryAllowance.mockResolvedValue({ status: 'saved', allowance: ROW });
    audit.logFromRequestWithClient.mockRejectedValueOnce(new Error('audit down'));
    const res = makeRes();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.add(makeReq({ body }), res);
    expect(res.statusCode).toBe(500);
  });
});

describe('«Доплата за общежитие»: правка и удаление', () => {
  it('нет записи — 404; чужой сотрудник — 403', async () => {
    allowances.getDormitoryAllowance.mockResolvedValueOnce(null);
    const missing = makeRes();
    await controller.update(makeReq({ params: { id: '5' }, body: { date_from: '2026-11-01' } }), missing);
    expect(missing.statusCode).toBe(404);

    allowances.getDormitoryAllowance.mockResolvedValue(ROW);
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(false);
    const foreign = makeRes();
    await controller.update(makeReq({ params: { id: '5' }, body: { date_from: '2026-11-01' } }), foreign);
    expect(foreign.statusCode).toBe(403);
    const foreignDelete = makeRes();
    await controller.remove(makeReq({ params: { id: '5' } }), foreignDelete);
    expect(foreignDelete.statusCode).toBe(403);
    expect(allowances.updateDormitoryAllowance).not.toHaveBeenCalled();
    expect(allowances.deleteDormitoryAllowance).not.toHaveBeenCalled();
  });

  it('«по» — аудит «было → стало»; те же даты — без аудита', async () => {
    allowances.getDormitoryAllowance.mockResolvedValue(ROW);
    const after = { ...ROW, date_to: '2026-12-31' };
    allowances.updateDormitoryAllowance.mockResolvedValueOnce({ status: 'saved', allowance: after, before: ROW });
    const res = makeRes();
    await controller.update(makeReq({ params: { id: '5' }, body: { date_from: '2026-11-01', date_to: '2026-12-31' } }), res);
    expect(res.body.data).toEqual(after);
    expect(allowances.updateDormitoryAllowance).toHaveBeenCalledWith(TX_CLIENT, 5, { date_from: '2026-11-01', date_to: '2026-12-31' });
    expect(audit.logFromRequestWithClient).toHaveBeenCalledWith(
      TX_CLIENT, expect.anything(), 'user-1', 'PAYROLL_DORMITORY_ALLOWANCE_UPDATED',
      expect.objectContaining({ details: { from: expect.objectContaining({ date_to: null }), to: expect.objectContaining({ date_to: '2026-12-31' }) } }),
    );

    allowances.updateDormitoryAllowance.mockResolvedValueOnce({ status: 'unchanged', allowance: after, before: after });
    const same = makeRes();
    await controller.update(makeReq({ params: { id: '5' }, body: { date_from: '2026-11-01', date_to: '2026-12-31' } }), same);
    expect(same.statusCode).toBe(200);
    expect(audit.logFromRequestWithClient).toHaveBeenCalledTimes(1);
  });

  it('правка в дни проживания — 409', async () => {
    allowances.getDormitoryAllowance.mockResolvedValue(ROW);
    allowances.updateDormitoryAllowance.mockRejectedValue(new DormitoryAllowanceConflictError('LIVES_IN_DORMITORY', 'живёт'));
    const res = makeRes();
    await controller.update(makeReq({ params: { id: '5' }, body: { date_from: '2026-10-01' } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('LIVES_IN_DORMITORY');
  });

  it('удаление — аудит в транзакции; уже удалена — 404 без аудита', async () => {
    allowances.getDormitoryAllowance.mockResolvedValue(ROW);
    allowances.deleteDormitoryAllowance.mockResolvedValueOnce(ROW);
    const res = makeRes();
    await controller.remove(makeReq({ params: { id: '5' } }), res);
    expect(res.statusCode).toBe(200);
    expect(audit.logFromRequestWithClient).toHaveBeenCalledWith(
      TX_CLIENT, expect.anything(), 'user-1', 'PAYROLL_DORMITORY_ALLOWANCE_DELETED', expect.objectContaining({ entityId: '5' }),
    );

    allowances.deleteDormitoryAllowance.mockResolvedValueOnce(null);
    const again = makeRes();
    await controller.remove(makeReq({ params: { id: '5' } }), again);
    expect(again.statusCode).toBe(404);
    expect(audit.logFromRequestWithClient).toHaveBeenCalledTimes(1);
  });
});
