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

describe('payrollDeductionsController: удержания сотрудника по месяцам', () => {
  it('чтение — вне скоупа 403, в скоупе — записи месяц · вид · сумма', async () => {
    scope.canReadPayrollEmployee.mockResolvedValueOnce(false);
    const denied = makeRes();
    await payrollDeductionsController.getEntries(makeReq({ params: { empId: '7' } }), denied);
    expect(denied.statusCode).toBe(403);

    const entries = [{ month: '2026-09', kind_id: 5, amount: '3000.00' }];
    pgQuery.mockResolvedValue(entries);
    const res = makeRes();
    await payrollDeductionsController.getEntries(makeReq({ params: { empId: '7' } }), res);
    expect(res.body.data).toEqual({ entries });
    expect(pgQuery.mock.calls[0][1]).toEqual([7]);
  });

  it('сохранение заменяет записи в транзакции и пишет в аудит добавленные, удалённые и изменённые', async () => {
    const after = [
      { month: '2026-09', kind_id: 5, amount: '3500.00' },
      { month: '2026-09', kind_id: 2, amount: '100.50' },
    ];
    pgQuery
      .mockResolvedValueOnce([{ id: 2 }, { id: 5 }]) // все виды есть в справочнике
      .mockResolvedValueOnce(after); // итог после сохранения
    txClient.query
      .mockResolvedValueOnce({ rows: [ // было (FOR UPDATE)
        { month: '2026-09', kind_id: 5, amount: '3000.00' },
        { month: '2026-08', kind_id: 4, amount: '700.00' },
      ] })
      .mockResolvedValueOnce({ rows: [] }) // DELETE лишних
      .mockResolvedValueOnce({ rows: after }); // UPSERT: изменённая и новая
    const res = makeRes();

    await payrollDeductionsController.saveEntries(makeReq({
      params: { empId: '7' },
      body: { entries: [{ month: '2026-09', kind_id: 5, amount: 3500 }, { month: '2026-09', kind_id: '2', amount: '100.5' }] },
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ entries: after });
    expect(txClient.query.mock.calls[1][1]).toEqual([7, ['2026-08-01'], [4]]);
    expect(txClient.query.mock.calls[2][1]).toEqual([7, ['2026-09-01', '2026-09-01'], [5, 2], [3500, 100.5]]);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'PAYROLL_DEDUCTION_ENTRIES_SAVED',
      expect.objectContaining({
        details: {
          employee_id: 7,
          added: [{ month: '2026-09', kind_id: 2, amount: '100.50' }],
          removed: [{ month: '2026-08', kind_id: 4, amount: '700.00' }],
          changed: [{ month: '2026-09', kind_id: 5, amount: '3500.00', prev_amount: '3000.00' }],
        },
      }),
    );
  });

  it('пустой набор удаляет всё без UPSERT', async () => {
    pgQuery.mockResolvedValueOnce([]);
    txClient.query
      .mockResolvedValueOnce({ rows: [{ month: '2026-09', kind_id: 5, amount: '3000.00' }] })
      .mockResolvedValueOnce({ rows: [] });
    const res = makeRes();

    await payrollDeductionsController.saveEntries(makeReq({ params: { empId: '7' }, body: { entries: [] } }), res);

    expect(res.statusCode).toBe(200);
    expect(txClient.query).toHaveBeenCalledTimes(2);
    expect(audit.logFromRequest).toHaveBeenCalledTimes(1);
  });

  it('без изменений — аудита нет', async () => {
    pgQuery.mockResolvedValueOnce([{ id: 5 }]).mockResolvedValueOnce([{ month: '2026-09', kind_id: 5, amount: '3000.00' }]);
    txClient.query
      .mockResolvedValueOnce({ rows: [{ month: '2026-09', kind_id: 5, amount: '3000.00' }] })
      .mockResolvedValueOnce({ rows: [] });
    const res = makeRes();

    await payrollDeductionsController.saveEntries(makeReq({
      params: { empId: '7' }, body: { entries: [{ month: '2026-09', kind_id: 5, amount: 3000 }] },
    }), res);

    expect(res.statusCode).toBe(200);
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });

  it('вне скоупа правки — 403, неизвестный вид, повтор месяц+вид и кривые суммы — 400; записи нет', async () => {
    scope.canEditPayrollEmployee.mockResolvedValueOnce(false);
    const denied = makeRes();
    await payrollDeductionsController.saveEntries(makeReq({ params: { empId: '7' }, body: { entries: [] } }), denied);
    expect(denied.statusCode).toBe(403);

    pgQuery.mockResolvedValueOnce([{ id: 5 }]);
    const unknown = makeRes();
    await payrollDeductionsController.saveEntries(makeReq({
      params: { empId: '7' },
      body: { entries: [{ month: '2026-09', kind_id: 5, amount: 1 }, { month: '2026-09', kind_id: 999, amount: 1 }] },
    }), unknown);
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body.error).toBe('Вид удержания не найден в справочнике');

    const duplicate = makeRes();
    await payrollDeductionsController.saveEntries(makeReq({
      params: { empId: '7' },
      body: { entries: [{ month: '2026-09', kind_id: 5, amount: 1 }, { month: '2026-09', kind_id: 5, amount: 2 }] },
    }), duplicate);
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.body.error).toBe('Вид удержания за месяц указан дважды');

    for (const entry of [
      { month: '2026-13', kind_id: 5, amount: 1 },
      { month: '2026-09-01', kind_id: 5, amount: 1 },
      { month: '2026-09', kind_id: 5, amount: 0 },
      { month: '2026-09', kind_id: 5, amount: 1.005 },
      { month: '2026-09', kind_id: 5, amount: 'abc' },
    ]) {
      const res = makeRes();
      await payrollDeductionsController.saveEntries(makeReq({ params: { empId: '7' }, body: { entries: [entry] } }), res);
      expect(res.statusCode).toBe(400);
    }
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
