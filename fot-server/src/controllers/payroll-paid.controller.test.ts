import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const { pgQuery, pgTx, txClient } = vi.hoisted(() => {
  const txClient = { query: vi.fn() };
  return {
    pgQuery: vi.fn(),
    pgTx: vi.fn(async (fn: (c: unknown) => unknown) => fn(txClient)),
    txClient,
  };
});

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: pgTx,
}));

const scope = vi.hoisted(() => ({
  canReadPayrollEmployee: vi.fn(async () => true),
  canEditPayrollEmployee: vi.fn(async () => true),
}));

vi.mock('../services/payroll/payroll-scope.service.js', () => scope);

const audit = vi.hoisted(() => ({
  logFromRequest: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('../services/audit.service.js', () => ({
  auditService: audit,
}));

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

const save = async (cells: unknown[]) => {
  const res = makeRes();
  await payrollPaidController.save(makeReq({ body: { cells } } as Partial<AuthenticatedRequest>), res);
  return res;
};

beforeAll(() => {
  // «Текущий месяц» по МСК — октябрь 2026.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-02T09:00:00Z'));
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  scope.canReadPayrollEmployee.mockResolvedValue(true);
  scope.canEditPayrollEmployee.mockResolvedValue(true);
  txClient.query.mockResolvedValue({ rowCount: 1 });
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

describe('«Оплачено»: сохранение', () => {
  it('удаляет очищенные ячейки и записывает заполненные одной транзакцией, пишет аудит', async () => {
    const res = await save([
      { month: '2026-08', item: 'contract', amount: 175000 },
      { month: '2026-08', item: 'travel', amount: 2730.5 },
      { month: '2026-07', item: 'bonus', amount: null },
    ]);

    expect(res.statusCode).toBe(200);
    expect(pgTx).toHaveBeenCalledTimes(1);
    const [deleteCall, upsertCall] = txClient.query.mock.calls;
    expect(deleteCall[0]).toContain('DELETE FROM payroll_paid_amounts');
    expect(deleteCall[1]).toEqual([42, ['2026-07'], ['bonus']]);
    expect(upsertCall[0]).toContain('INSERT INTO payroll_paid_amounts');
    expect(upsertCall[1]).toEqual([42, ['2026-08', '2026-08'], ['contract', 'travel'], [175000, 2730.5], 'user-1']);
    expect(res.body.data).toEqual({ changed: 2 });
    expect(audit.logFromRequest).toHaveBeenCalledTimes(1);
    expect(audit.logFromRequest.mock.calls[0][2]).toBe('PAYROLL_PAID_AMOUNTS_SAVED');
  });

  it('без изменений в БД аудит не пишется', async () => {
    txClient.query.mockResolvedValue({ rowCount: 0 });

    const res = await save([{ month: '2026-08', item: 'contract', amount: 175000 }]);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ changed: 0 });
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });

  it('минус допустим только у перерасчёта', async () => {
    expect((await save([{ month: '2026-08', item: 'recalc_prev', amount: -1500 }])).statusCode).toBe(200);

    const res = await save([{ month: '2026-08', item: 'vacation', amount: -1500 }]);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Сумма не может быть отрицательной');
  });

  it('отклоняет до записи: три знака, будущий месяц, дубль ячейки, чужой код, пустой список', async () => {
    const invalid: unknown[][] = [
      [{ month: '2026-08', item: 'contract', amount: 1.005 }],
      [{ month: '2026-11', item: 'contract', amount: 100 }],
      [{ month: '2026-08', item: 'contract', amount: 1 }, { month: '2026-08', item: 'contract', amount: 2 }],
      [{ month: '2026-08', item: 'kpi', amount: 1 }],
      [{ month: '2026-08', item: 'contract', amount: 10_000_000_000 }],
      [],
    ];
    for (const cells of invalid) {
      expect((await save(cells)).statusCode).toBe(400);
    }
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('принимает статьи удержаний; минус у них — 400', async () => {
    const cells = [
      { month: '2026-07', item: 'housing', amount: 160 },
      { month: '2026-07', item: 'meals', amount: 5248 },
      { month: '2026-07', item: 'workwear', amount: 3050.51 },
    ];
    const res = await save(cells);
    expect(res.statusCode).toBe(200);
    expect(txClient.query.mock.calls[0][1][2]).toEqual(['housing', 'meals', 'workwear']);

    for (const item of ['writ_deduction', 'fines']) {
      expect((await save([{ month: '2026-07', item, amount: -100 }])).statusCode).toBe(400);
    }
  });

  it('удалённые статьи «Выплачено» и «Моб. телефон» — 400 без записи', async () => {
    for (const item of ['fss', 'advance', 'bank_transfer', 'bonus_payout', 'mobile']) {
      expect((await save([{ month: '2026-07', item, amount: 100 }])).statusCode).toBe(400);
    }
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('текущий месяц принимается', async () => {
    expect((await save([{ month: '2026-10', item: 'contract', amount: 100 }])).statusCode).toBe(200);
  });

  it('без права правки сотрудника — 403 без записи', async () => {
    scope.canEditPayrollEmployee.mockResolvedValue(false);

    const res = await save([{ month: '2026-08', item: 'contract', amount: 175000 }]);

    expect(res.statusCode).toBe(403);
    expect(pgTx).not.toHaveBeenCalled();
  });
});
