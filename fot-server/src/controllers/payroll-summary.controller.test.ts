import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const registryScope = vi.hoisted(() => ({ resolvePayrollStaffScope: vi.fn() }));
vi.mock('../services/payroll/payroll-registry-scope.service.js', () => registryScope);

const summary = vi.hoisted(() => ({ listPayrollSummaryMonths: vi.fn(), loadPayrollSummary: vi.fn() }));
vi.mock('../services/payroll/payroll-summary.service.js', () => summary);

import { payrollSummaryController } from './payroll-summary.controller.js';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: any };
};

const makeReq = (query: Record<string, unknown> = {}): AuthenticatedRequest => ({
  user: { id: 'user-1' }, params: {}, query, body: {},
} as unknown as AuthenticatedRequest);

const SCOPE = { contractorRootId: 'contractor-root', departmentIds: ['d-1'] };

beforeEach(() => {
  vi.resetAllMocks();
  registryScope.resolvePayrollStaffScope.mockResolvedValue(SCOPE);
  summary.loadPayrollSummary.mockResolvedValue({ months: [], rows: [] });
});

describe('«Свод»', () => {
  it('месяцы — в охвате пользователя', async () => {
    summary.listPayrollSummaryMonths.mockResolvedValue(['2026-07', '2026-08']);
    const res = makeRes();
    await payrollSummaryController.months(makeReq(), res);
    expect(summary.listPayrollSummaryMonths).toHaveBeenCalledWith(SCOPE);
    expect(res.body.data).toEqual(['2026-07', '2026-08']);
  });

  it('список месяцев — первые числа; all или без параметра — все месяцы', async () => {
    await payrollSummaryController.get(makeReq({ months: '2026-08,2026-07' }), makeRes());
    await payrollSummaryController.get(makeReq({ months: 'all' }), makeRes());
    await payrollSummaryController.get(makeReq(), makeRes());
    expect(summary.loadPayrollSummary.mock.calls.map(call => call[0])).toEqual([
      { scope: SCOPE, monthStarts: ['2026-07-01', '2026-08-01'] },
      { scope: SCOPE, monthStarts: null },
      { scope: SCOPE, monthStarts: null },
    ]);
  });

  it('неверный месяц — 400', async () => {
    const res = makeRes();
    await payrollSummaryController.get(makeReq({ months: '2026-13' }), res);
    expect(res.statusCode).toBe(400);
    expect(summary.loadPayrollSummary).not.toHaveBeenCalled();
  });
});
