import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const { pgQuery, pgQueryOne } = vi.hoisted(() => ({ pgQuery: vi.fn(), pgQueryOne: vi.fn() }));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

const scope = vi.hoisted(() => ({
  canReadPayrollEmployee: vi.fn(async () => true),
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
});

describe('payrollDeductionsController.getStaffByEmployee: удержания сотрудника', () => {
  it('вне скоупа — 403 без запроса; в скоупе — строки только этого сотрудника', async () => {
    scope.canReadPayrollEmployee.mockResolvedValueOnce(false);
    const denied = makeRes();
    await payrollDeductionsController.getStaffByEmployee(makeReq({ params: { empId: '7' } }), denied);
    expect(denied.statusCode).toBe(403);
    expect(pgQuery).not.toHaveBeenCalled();

    const bad = makeRes();
    await payrollDeductionsController.getStaffByEmployee(makeReq({ params: { empId: 'x' } }), bad);
    expect(bad.statusCode).toBe(403);

    const row = { id: 1, employee_id: 7, kind_name: 'Штраф за мусор', month: '2026-10', amount: '5000.00' };
    pgQuery.mockResolvedValueOnce([row]);
    const res = makeRes();
    await payrollDeductionsController.getStaffByEmployee(makeReq({ params: { empId: '7' } }), res);
    expect(res.body.data).toEqual([row]);
    expect(pgQuery.mock.calls[0][0]).toContain('FROM staff_deductions');
    expect(pgQuery.mock.calls[0][1]).toEqual([[7]]);
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

describe('payrollDeductionsController.renameKind', () => {
  it('пробелы схлопываются, название меняется, в аудит — было и стало', async () => {
    pgQueryOne.mockResolvedValue({ id: 7, name: 'Штраф за опоздание', previous_name: 'Штрафы' });
    const res = makeRes();

    await payrollDeductionsController.renameKind(
      makeReq({ params: { id: '7' }, body: { name: ' Штраф  за опоздание ' } }), res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ id: 7, name: 'Штраф за опоздание' });
    expect(pgQueryOne.mock.calls[0][1]).toEqual([7, 'Штраф за опоздание']);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'PAYROLL_DEDUCTION_KIND_RENAMED',
      expect.objectContaining({ entityId: '7', details: { from: 'Штрафы', to: 'Штраф за опоздание' } }),
    );
  });

  it('название не изменилось — аудита нет', async () => {
    pgQueryOne.mockResolvedValue({ id: 7, name: 'Штрафы', previous_name: 'Штрафы' });
    const res = makeRes();

    await payrollDeductionsController.renameKind(makeReq({ params: { id: '7' }, body: { name: 'Штрафы' } }), res);

    expect(res.statusCode).toBe(200);
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });

  it('название занято другим видом — 409; вида нет или id кривой — 404; пустое название — 400', async () => {
    pgQueryOne.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));
    const duplicate = makeRes();
    await payrollDeductionsController.renameKind(makeReq({ params: { id: '7' }, body: { name: 'Питание' } }), duplicate);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.body.code).toBe('DUPLICATE_KIND');

    pgQueryOne.mockResolvedValueOnce(null);
    const missing = makeRes();
    await payrollDeductionsController.renameKind(makeReq({ params: { id: '99' }, body: { name: 'Питание' } }), missing);
    expect(missing.statusCode).toBe(404);

    const callsBefore = pgQueryOne.mock.calls.length;
    const badId = makeRes();
    await payrollDeductionsController.renameKind(makeReq({ params: { id: 'abc' }, body: { name: 'Питание' } }), badId);
    expect(badId.statusCode).toBe(404);

    const empty = makeRes();
    await payrollDeductionsController.renameKind(makeReq({ params: { id: '7' }, body: { name: '  ' } }), empty);
    expect(empty.statusCode).toBe(400);

    expect(pgQueryOne.mock.calls.length).toBe(callsBefore);
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });
});

describe('payrollDeductionsController.deleteKind', () => {
  it('свободный вид удаляется и пишется в аудит', async () => {
    pgQueryOne.mockResolvedValue({ id: 7, name: 'Штраф за мусор' });
    const res = makeRes();

    await payrollDeductionsController.deleteKind(makeReq({ params: { id: '7' } }), res);

    expect(res.statusCode).toBe(200);
    expect(String(pgQueryOne.mock.calls[0][0])).toMatch(/DELETE FROM payroll_deduction_kinds/);
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'PAYROLL_DEDUCTION_KIND_DELETED',
      expect.objectContaining({ entityId: '7', details: { name: 'Штраф за мусор' } }),
    );
  });

  // 23503 — код внешнего ключа до PostgreSQL 18, 23001 — код ON DELETE RESTRICT с 18-й версии.
  it.each(['23503', '23001'])('вид назначен сотрудникам (код %s) — 409 с их числом, аудита нет', async code => {
    pgQueryOne
      .mockRejectedValueOnce(Object.assign(new Error('violates foreign key constraint'), { code }))
      .mockResolvedValueOnce({ total: 3 });
    const res = makeRes();

    await payrollDeductionsController.deleteKind(makeReq({ params: { id: '7' } }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'KIND_IN_USE', employees: 3, error: 'Вид назначен сотрудникам: 3' });
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });

  it('прочая ошибка БД — 500, а не «вид занят»', async () => {
    pgQueryOne.mockRejectedValueOnce(Object.assign(new Error('deadlock detected'), { code: '40P01' }));
    const res = makeRes();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await payrollDeductionsController.deleteKind(makeReq({ params: { id: '7' } }), res);
    consoleError.mockRestore();

    expect(res.statusCode).toBe(500);
    expect(pgQueryOne).toHaveBeenCalledTimes(1);
  });

  it('вида нет или id кривой — 404', async () => {
    pgQueryOne.mockResolvedValueOnce(null);
    const missing = makeRes();
    await payrollDeductionsController.deleteKind(makeReq({ params: { id: '99' } }), missing);
    expect(missing.statusCode).toBe(404);

    const badId = makeRes();
    await payrollDeductionsController.deleteKind(makeReq({ params: { id: '0' } }), badId);
    expect(badId.statusCode).toBe(404);
    expect(pgQueryOne).toHaveBeenCalledTimes(1);
  });
});
