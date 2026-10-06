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

describe('«Оплачено»: только чтение', () => {
  it('ввода больше нет: у контроллера только чтение', () => {
    expect(Object.keys(payrollPaidController)).toEqual(['getByEmployee']);
  });
});
