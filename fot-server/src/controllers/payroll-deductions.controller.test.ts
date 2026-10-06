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

vi.mock('../services/payroll/payroll-scope.service.js', () => ({
  resolvePayrollReadableDepartmentIds: vi.fn(async () => ['dept-1']),
  canReadPayrollEmployee: vi.fn(async () => true),
  canEditPayrollEmployee: vi.fn(async () => true),
  resolvePayrollEditPredicate: vi.fn(async () => () => true),
}));

vi.mock('../config/contractor.js', () => ({ getContractorRootId: vi.fn(async () => 'contractor-root') }));

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
});

describe('payrollDeductionsController.list', () => {
  it('только сотрудники с видом удержания, в скоупе «Зарплаты» и без подрядчиков', async () => {
    pgQuery.mockResolvedValue([{ employee_id: 1, deduction_kind_id: 5, deduction_amount: '5248.00' }]);
    const res = makeRes();

    await payrollDeductionsController.list(makeReq({ query: { date: '2026-10-06', q: '50%' } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual([{ employee_id: 1, deduction_kind_id: 5, deduction_amount: '5248.00', can_edit: true }]);
    expect(res.body.meta).toEqual({ date: '2026-10-06', contractors_excluded: true });
    const [sql, params] = pgQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE s.deduction_kind_id IS NOT NULL');
    expect(params[0]).toBe('2026-10-06');
    expect(params[5]).toBe('contractor-root');
    expect(params[6]).toEqual(['dept-1']);
    expect(params[7]).toBe('%50\\%%');
  });

  it('кривая дата — 400 до похода в БД', async () => {
    const res = makeRes();
    await payrollDeductionsController.list(makeReq({ query: { date: '06.10.2026' } }), res);
    expect(res.statusCode).toBe(400);
    expect(pgQuery).not.toHaveBeenCalled();
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
