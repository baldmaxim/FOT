import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const { pgQuery, pgQueryOne, pgExecute, pgTx } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  pgExecute: vi.fn(),
  pgTx: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: pgExecute,
  withTransaction: pgTx,
}));

const mockedState = vi.hoisted(() => ({
  canAccessEmployeeInScope: vi.fn(async () => true),
}));

vi.mock('../services/data-scope.service.js', () => ({
  canAccessEmployeeInScope: mockedState.canAccessEmployeeInScope,
}));

vi.mock('../services/payslip-generation.service.js', () => ({
  generatePayslipsForMonth: vi.fn(async () => ({ generated: 0, payslips: [] })),
}));

// Realtime-уведомления резолвят получателей отдельным запросом (recipients.service).
// В этих тестах нас интересует только storage-запись — мокаем, чтобы лишний
// queryOne от роутинга уведомлений не искажал счётчик вызовов.
vi.mock('../services/recipients.service.js', () => ({
  getEmployeeUserId: vi.fn(async () => null),
  getUserIdsByEmployeeIds: vi.fn(async () => []),
}));

import { payslipsController } from './payslips.controller.js';
import { paymentsController } from './payments.controller.js';

function makeReq(overrides: Partial<AuthenticatedRequest>): AuthenticatedRequest {
  return {
    params: {},
    query: {},
    body: {},
    user: {
      id: 'user-1',
      email: 'hr@example.com',
      position_type: 'admin',
      employee_id: 1,
      department_id: 'dept-1',
      is_approved: true,
      two_factor_enabled: false,
      two_factor_verified: true,
    },
    ...overrides,
  } as AuthenticatedRequest;
}

function makeRes() {
  const response = {
    statusCode: 200,
    payload: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
      return this;
    },
  };

  return response as Response & { statusCode: number; payload: unknown };
}

describe('compensation access controllers', () => {
  beforeEach(() => {
    pgQuery.mockReset();
    pgQueryOne.mockReset();
    pgExecute.mockReset();
    pgTx.mockReset();
    mockedState.canAccessEmployeeInScope.mockReset();
    mockedState.canAccessEmployeeInScope.mockResolvedValue(true);
  });

  it('denies payslip access for employee outside scope before querying storage', async () => {
    mockedState.canAccessEmployeeInScope.mockResolvedValue(false);
    const req = makeReq({ params: { empId: '42' } });
    const res = makeRes();

    await payslipsController.getByEmployee(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.payload).toEqual({ success: false, error: 'Нет доступа к сотруднику' });
    expect(pgQuery).not.toHaveBeenCalled();
    expect(pgQueryOne).not.toHaveBeenCalled();
  });

  it('writes payslip upsert when employee is inside scope', async () => {
    pgQueryOne.mockResolvedValueOnce({
      id: 5,
      employee_id: 42,
      period: '2026-04',
      gross_amount: 100000,
      net_amount: 87000,
    });

    const req = makeReq({
      body: {
        employee_id: 42,
        period: '2026-04',
        gross_amount: 100000,
        net_amount: 87000,
        deductions: 13000,
      },
    });
    const res = makeRes();

    await payslipsController.create(req, res);

    expect(res.statusCode).toBe(200);
    expect(pgQueryOne).toHaveBeenCalledOnce();
    const [sql, params] = pgQueryOne.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO payslips/i);
    expect(sql).toMatch(/ON CONFLICT \(employee_id, period\) DO UPDATE/i);
    // params: [employee_id, period, gross_amount, net_amount, deductions, details, document_id, created_by]
    expect(params[0]).toBe(42);
    expect(params[1]).toBe('2026-04');
    expect(params[2]).toBe(100000);
    expect(params[3]).toBe(87000);
    expect(params[4]).toBe(13000);
    expect(params[7]).toBe('user-1');
  });

  it('denies payments batch import when at least one employee is out of scope', async () => {
    mockedState.canAccessEmployeeInScope
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const req = makeReq({
      body: {
        items: [
          { employee_id: 1, payment_date: '2026-04-10', amount: 1000, payment_type: 'salary' },
          { employee_id: 2, payment_date: '2026-04-10', amount: 500, payment_type: 'bonus' },
        ],
      },
    });
    const res = makeRes();

    await paymentsController.importBatch(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.payload).toEqual({ success: false, error: 'Нет доступа к одному из сотрудников в batch' });
    expect(pgQuery).not.toHaveBeenCalled();
    expect(pgQueryOne).not.toHaveBeenCalled();
  });

  it('writes payment insert when employee is inside scope', async () => {
    pgQueryOne.mockResolvedValueOnce({
      id: 8,
      employee_id: 42,
      payment_type: 'salary',
      amount: 100000,
    });

    const req = makeReq({
      body: {
        employee_id: 42,
        payment_date: '2026-04-10',
        amount: 100000,
        payment_type: 'salary',
        description: 'April salary',
        period: '2026-04',
      },
    });
    const res = makeRes();

    await paymentsController.create(req, res);

    expect(res.statusCode).toBe(200);
    expect(pgQueryOne).toHaveBeenCalledOnce();
    const [sql, params] = pgQueryOne.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO payments/i);
    // params: [employee_id, payment_date, amount, payment_type, description, period, created_by]
    expect(params[0]).toBe(42);
    expect(params[1]).toBe('2026-04-10');
    expect(params[2]).toBe(100000);
    expect(params[3]).toBe('salary');
    expect(params[4]).toBe('April salary');
    expect(params[5]).toBe('2026-04');
    expect(params[6]).toBe('user-1');
  });
});
