import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

const scope = vi.hoisted(() => ({
  canReadPayrollEmployee: vi.fn(async () => true),
}));

vi.mock('../services/payroll/payroll-scope.service.js', () => scope);

const payslip = vi.hoisted(() => ({ getPayslipInfo: vi.fn() }));

vi.mock('../services/payroll/payroll-payslip.service.js', () => payslip);

import { payrollPaidController } from './payroll-paid.controller.js';

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
  user: { id: 'user-1' },
  params: { empId: '42' },
  query: {},
  body: {},
  headers: {},
  socket: {},
  ...over,
} as unknown as AuthenticatedRequest);

beforeEach(() => {
  vi.clearAllMocks();
  scope.canReadPayrollEmployee.mockResolvedValue(true);
  pgQuery.mockResolvedValue([]);
});

describe('«Оплачено»: чтение', () => {
  it('отдаёт суммы периода', async () => {
    pgQuery.mockResolvedValue([{ month: '2026-08', item: 'contract', amount: '175000.00' }]);
    const res = makeRes();

    await payrollPaidController.getByEmployee(makeReq({
      query: { from: '2026-04', to: '2026-09' },
    } as Partial<AuthenticatedRequest>), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual([{ month: '2026-08', item: 'contract', amount: '175000.00' }]);
    expect(pgQuery.mock.calls[0][1]).toEqual([42, '2026-04', '2026-09']);
  });

  it('без доступа к сотруднику — 403', async () => {
    scope.canReadPayrollEmployee.mockResolvedValue(false);
    const res = makeRes();

    await payrollPaidController.getByEmployee(makeReq({
      query: { from: '2026-04', to: '2026-09' },
    } as Partial<AuthenticatedRequest>), res);

    expect(res.statusCode).toBe(403);
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('период задом наперёд и кривой месяц — 400', async () => {
    for (const query of [{ from: '2026-09', to: '2026-04' }, { from: '2026-13', to: '2026-09' }, {}]) {
      const res = makeRes();
      await payrollPaidController.getByEmployee(makeReq({ query } as Partial<AuthenticatedRequest>), res);
      expect(res.statusCode).toBe(400);
    }
    expect(pgQuery).not.toHaveBeenCalled();
  });
});

describe('Расчётный листок месяца', () => {
  it('отдаёт период, дни и условия месяца', async () => {
    const info = {
      month: '2026-07',
      period_from: '2026-07-01',
      period_to: '2026-07-31',
      worked_days: { workday: 24, dayoff: 2 },
      terms: [{ effective_from: '2026-01-01', effective_to: null, calc_type: 'salary', amount: '130000.00' }],
    };
    payslip.getPayslipInfo.mockResolvedValue(info);
    const res = makeRes();

    await payrollPaidController.getPayslip(makeReq({ query: { month: '2026-07' } } as Partial<AuthenticatedRequest>), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual(info);
    expect(payslip.getPayslipInfo).toHaveBeenCalledWith(42, '2026-07', expect.objectContaining({ user: expect.any(Object) }));
  });

  it('без доступа к сотруднику — 403, табель не собирается', async () => {
    scope.canReadPayrollEmployee.mockResolvedValue(false);
    const res = makeRes();

    await payrollPaidController.getPayslip(makeReq({ query: { month: '2026-07' } } as Partial<AuthenticatedRequest>), res);

    expect(res.statusCode).toBe(403);
    expect(payslip.getPayslipInfo).not.toHaveBeenCalled();
  });

  it('кривой месяц — 400', async () => {
    for (const query of [{ month: '2026-13' }, { month: '2026-7' }, {}]) {
      const res = makeRes();
      await payrollPaidController.getPayslip(makeReq({ query } as Partial<AuthenticatedRequest>), res);
      expect(res.statusCode).toBe(400);
    }
    expect(payslip.getPayslipInfo).not.toHaveBeenCalled();
  });
});

describe('«Оплачено»: только чтение', () => {
  it('ввода больше нет: у контроллера только чтение', () => {
    expect(Object.keys(payrollPaidController)).toEqual(['getByEmployee', 'getPayslip']);
  });
});
