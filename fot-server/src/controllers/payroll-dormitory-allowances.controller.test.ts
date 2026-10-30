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

describe('«Доплата за общежитие»: ручной ввод закрыт (миграция 339)', () => {
  it('добавление и правка — 409 DORMITORY_ALLOWANCE_AUTO, ничего не пишется и не проверяется', async () => {
    const added = makeRes();
    await controller.add(makeReq({ body: { employee_id: 42, date_from: '2026-11-01' } }), added);
    expect(added.statusCode).toBe(409);
    expect(added.body).toEqual(expect.objectContaining({ code: 'DORMITORY_ALLOWANCE_AUTO' }));

    const updated = makeRes();
    await controller.update(makeReq({ params: { id: '5' }, body: { date_from: '2026-11-01' } }), updated);
    expect(updated.statusCode).toBe(409);
    expect(updated.body.code).toBe('DORMITORY_ALLOWANCE_AUTO');

    expect(allowances.addDormitoryAllowance).not.toHaveBeenCalled();
    expect(allowances.updateDormitoryAllowance).not.toHaveBeenCalled();
    expect(audit.logFromRequestWithClient).not.toHaveBeenCalled();
  });
});

describe('«Доплата за общежитие»: удаление', () => {
  it('нет записи — 404; чужой сотрудник — 403', async () => {
    allowances.getDormitoryAllowance.mockResolvedValueOnce(null);
    const missing = makeRes();
    await controller.remove(makeReq({ params: { id: '5' } }), missing);
    expect(missing.statusCode).toBe(404);

    allowances.getDormitoryAllowance.mockResolvedValue(ROW);
    registryScope.canWritePayrollRegistryEmployee.mockResolvedValue(false);
    const foreign = makeRes();
    await controller.remove(makeReq({ params: { id: '5' } }), foreign);
    expect(foreign.statusCode).toBe(403);
    expect(allowances.deleteDormitoryAllowance).not.toHaveBeenCalled();
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
