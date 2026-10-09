import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const { pgQuery, pgQueryOne, pgTx, txClient } = vi.hoisted(() => {
  const txClient = { query: vi.fn() };
  return {
    pgQuery: vi.fn(),
    pgQueryOne: vi.fn(),
    pgTx: vi.fn(async (fn: (c: unknown) => unknown) => fn(txClient)),
    txClient,
  };
});

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: vi.fn(),
  withTransaction: pgTx,
}));

const scope = vi.hoisted(() => ({
  canReadPayrollEmployee: vi.fn(async () => true),
  canEditPayrollEmployee: vi.fn(async () => true),
}));
vi.mock('../services/payroll/payroll-scope.service.js', () => scope);

const audit = vi.hoisted(() => ({ logFromRequest: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock('../services/audit.service.js', () => ({ auditService: audit }));

import { payrollDeductionsController } from './payroll-deductions.controller.js';

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

beforeEach(() => {
  vi.clearAllMocks();
  scope.canReadPayrollEmployee.mockResolvedValue(true);
  scope.canEditPayrollEmployee.mockResolvedValue(true);
});

describe('payrollDeductionsController: виды сотрудника', () => {
  it('чтение — вне скоупа 403, в скоупе — виды по порядку справочника', async () => {
    scope.canReadPayrollEmployee.mockResolvedValueOnce(false);
    const denied = makeRes();
    await payrollDeductionsController.getByEmployee(makeReq({ params: { empId: '7' } }), denied);
    expect(denied.statusCode).toBe(403);

    pgQuery.mockResolvedValue([{ kind_id: 5 }, { kind_id: 2 }]);
    const res = makeRes();
    await payrollDeductionsController.getByEmployee(makeReq({ params: { empId: '7' } }), res);
    expect(res.body.data).toEqual({ kind_ids: [5, 2] });
  });

  it('сохранение заменяет набор в транзакции и пишет в аудит добавленные и снятые', async () => {
    pgQuery
      .mockResolvedValueOnce([{ id: 2 }, { id: 5 }]) // все виды есть в справочнике
      .mockResolvedValueOnce([{ kind_id: 2 }, { kind_id: 5 }]); // итог после сохранения
    txClient.query
      .mockResolvedValueOnce({ rows: [{ kind_id: 4 }] }) // DELETE снятых
      .mockResolvedValueOnce({ rows: [{ kind_id: 2 }] }); // INSERT новых
    const res = makeRes();

    await payrollDeductionsController.saveByEmployee(makeReq({ params: { empId: '7' }, body: { kind_ids: [5, 2, 5] } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ kind_ids: [2, 5] });
    expect(txClient.query.mock.calls[0][1]).toEqual([7, [5, 2]]);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'PAYROLL_EMPLOYEE_DEDUCTIONS_SAVED',
      expect.objectContaining({ details: { employee_id: 7, added: [2], removed: [4] } }),
    );
  });

  it('без изменений — аудита нет', async () => {
    pgQuery.mockResolvedValueOnce([{ id: 5 }]).mockResolvedValueOnce([{ kind_id: 5 }]);
    txClient.query.mockResolvedValue({ rows: [] });
    const res = makeRes();

    await payrollDeductionsController.saveByEmployee(makeReq({ params: { empId: '7' }, body: { kind_ids: [5] } }), res);

    expect(res.statusCode).toBe(200);
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });

  it('вне скоупа правки — 403, неизвестный вид — 400; записи нет', async () => {
    scope.canEditPayrollEmployee.mockResolvedValueOnce(false);
    const denied = makeRes();
    await payrollDeductionsController.saveByEmployee(makeReq({ params: { empId: '7' }, body: { kind_ids: [5] } }), denied);
    expect(denied.statusCode).toBe(403);

    pgQuery.mockResolvedValueOnce([{ id: 5 }]);
    const unknown = makeRes();
    await payrollDeductionsController.saveByEmployee(makeReq({ params: { empId: '7' }, body: { kind_ids: [5, 999] } }), unknown);
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body.error).toBe('Вид удержания не найден в справочнике');

    const invalid = makeRes();
    await payrollDeductionsController.saveByEmployee(makeReq({ params: { empId: '7' }, body: { kind_ids: 'x' } }), invalid);
    expect(invalid.statusCode).toBe(400);
    expect(pgTx).not.toHaveBeenCalled();
  });
});

describe('payrollDeductionsController.addKind', () => {
  it('пробелы схлопываются, вид добавляется и пишется в аудит', async () => {
    pgQueryOne.mockResolvedValue({ id: 7, name: 'Штраф за опоздание' });
    const res = makeRes();

    await payrollDeductionsController.addKind(makeReq({ body: { name: '  Штраф   за опоздание ' } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ id: 7, name: 'Штраф за опоздание' });
    expect(pgQueryOne.mock.calls[0][1]).toEqual(['Штраф за опоздание', 1000]);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'PAYROLL_DEDUCTION_KIND_ADDED', expect.objectContaining({ entityId: '7' }),
    );
  });

  it('пустое и слишком длинное название — 400 без записи', async () => {
    for (const name of ['   ', 'а'.repeat(101)]) {
      const res = makeRes();
      await payrollDeductionsController.addKind(makeReq({ body: { name } }), res);
      expect(res.statusCode).toBe(400);
    }
    expect(pgQueryOne).not.toHaveBeenCalled();
  });

  it('такой вид уже есть — 409, аудита нет', async () => {
    pgQueryOne.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505' }));
    const res = makeRes();

    await payrollDeductionsController.addKind(makeReq({ body: { name: 'штрафы' } }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_KIND');
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });
});
