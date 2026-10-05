import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const { pgQueryOne } = vi.hoisted(() => ({ pgQueryOne: vi.fn() }));

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: pgQueryOne,
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

const scope = vi.hoisted(() => ({
  canReadPayrollEmployee: vi.fn(async () => true),
  canEditPayrollEmployee: vi.fn(async () => true),
}));

vi.mock('../services/payroll/payroll-scope.service.js', () => scope);

import { payrollCommunicationController } from './payroll-communication.controller.js';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: any };
};

const request = async (query: Record<string, unknown>, empId = '42') => {
  const res = makeRes();
  await payrollCommunicationController.getByEmployee({
    user: { id: 'user-1' },
    params: { empId },
    query,
  } as unknown as AuthenticatedRequest, res);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  scope.canReadPayrollEmployee.mockResolvedValue(true);
});

describe('«Связь» в карточке зарплаты', () => {
  it('отдаёт сверхтраты за месяц по всем SIM сотрудника', async () => {
    pgQueryOne.mockResolvedValue({ sims: 2, rows: 31, amount: '484.00' });

    const res = await request({ month: '2026-10' });

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ month: '2026-10', sims: 2, amount: '484.00' });
    expect(pgQueryOne.mock.calls[0][1]).toEqual([42, '2026-10', ['call', 'sms', 'mms', 'traffic']]);
    expect(pgQueryOne.mock.calls[0][0]).toContain("r.category <> 'topups'");
    expect(pgQueryOne.mock.calls[0][0]).toContain('FILTER (WHERE r.network_event = ANY($3::text[]))');
  });

  it('нет SIM — sims 0 и amount null', async () => {
    pgQueryOne.mockResolvedValue({ sims: 0, rows: 0, amount: '0' });

    const res = await request({ month: '2026-10' });

    expect(res.body.data).toEqual({ month: '2026-10', sims: 0, amount: null });
  });

  it('SIM есть, строк выписки за месяц нет — amount null («нет данных»), а не 0', async () => {
    pgQueryOne.mockResolvedValue({ sims: 1, rows: 0, amount: '0' });

    const res = await request({ month: '2026-05' });

    expect(res.body.data).toEqual({ month: '2026-05', sims: 1, amount: null });
  });

  it('без доступа к сотруднику — 403 без запроса в БД', async () => {
    scope.canReadPayrollEmployee.mockResolvedValue(false);

    const res = await request({ month: '2026-10' });

    expect(res.statusCode).toBe(403);
    expect(pgQueryOne).not.toHaveBeenCalled();
  });

  it('кривой id — 403, кривой или пустой месяц — 400', async () => {
    expect((await request({ month: '2026-10' }, 'abc')).statusCode).toBe(403);
    for (const query of [{ month: '2026-13' }, { month: '2026-1' }, {}]) {
      expect((await request(query)).statusCode).toBe(400);
    }
    expect(pgQueryOne).not.toHaveBeenCalled();
  });
});
