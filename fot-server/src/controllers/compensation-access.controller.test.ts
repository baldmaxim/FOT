import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

type QueryRecord = {
  table: string;
  operations: Array<{ method: string; args: unknown[] }>;
};

type QueryResponse = {
  data?: unknown;
  error?: { message: string } | null;
};

const mockedState = vi.hoisted(() => ({
  queryLog: [] as QueryRecord[],
  resolver: (() => ({ data: [], error: null })) as (query: QueryRecord) => QueryResponse | Promise<QueryResponse>,
  canAccessEmployeeInScope: vi.fn(async () => true),
}));

function createBuilder(table: string) {
  const query: QueryRecord = { table, operations: [] };
  mockedState.queryLog.push(query);

  const builder = {
    select: (...args: unknown[]) => {
      query.operations.push({ method: 'select', args });
      return builder;
    },
    eq: (...args: unknown[]) => {
      query.operations.push({ method: 'eq', args });
      return builder;
    },
    order: (...args: unknown[]) => {
      query.operations.push({ method: 'order', args });
      return builder;
    },
    insert: (...args: unknown[]) => {
      query.operations.push({ method: 'insert', args });
      return builder;
    },
    upsert: (...args: unknown[]) => {
      query.operations.push({ method: 'upsert', args });
      return builder;
    },
    single: async () => mockedState.resolver(query),
    then: (onFulfilled: (value: QueryResponse) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(mockedState.resolver(query)).then(onFulfilled, onRejected),
  };

  return builder;
}

vi.mock('../config/database.js', () => ({
  supabase: {
    from: vi.fn((table: string) => createBuilder(table)),
  },
}));

vi.mock('../services/data-scope.service.js', () => ({
  canAccessEmployeeInScope: mockedState.canAccessEmployeeInScope,
}));

vi.mock('../services/payslip-generation.service.js', () => ({
  generatePayslipsForMonth: vi.fn(async () => ({ generated: 0, payslips: [] })),
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
    mockedState.queryLog.length = 0;
    mockedState.resolver = () => ({ data: [], error: null });
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
    expect(mockedState.queryLog).toHaveLength(0);
  });

  it('writes payslip upsert when employee is inside scope', async () => {
    mockedState.resolver = (query) => {
      if (query.table !== 'payslips') {
        throw new Error(`Unexpected query: ${query.table}`);
      }
      return {
        data: {
          id: 5,
          employee_id: 42,
          period: '2026-04',
          gross_amount: 100000,
          net_amount: 87000,
        },
        error: null,
      };
    };

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
    expect(mockedState.queryLog).toHaveLength(1);
    expect(mockedState.queryLog[0]?.table).toBe('payslips');
    expect(mockedState.queryLog[0]?.operations).toEqual(expect.arrayContaining([
      {
        method: 'upsert',
        args: [
          expect.objectContaining({
            employee_id: 42,
            period: '2026-04',
            created_by: 'user-1',
          }),
          { onConflict: 'employee_id,period' },
        ],
      },
    ]));
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
    expect(mockedState.queryLog).toHaveLength(0);
  });

  it('writes payment insert when employee is inside scope', async () => {
    mockedState.resolver = (query) => {
      if (query.table !== 'payments') {
        throw new Error(`Unexpected query: ${query.table}`);
      }
      return {
        data: {
          id: 8,
          employee_id: 42,
          payment_type: 'salary',
          amount: 100000,
        },
        error: null,
      };
    };

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
    expect(mockedState.queryLog).toHaveLength(1);
    expect(mockedState.queryLog[0]?.table).toBe('payments');
    expect(mockedState.queryLog[0]?.operations).toEqual(expect.arrayContaining([
      {
        method: 'insert',
        args: [
          expect.objectContaining({
            employee_id: 42,
            payment_date: '2026-04-10',
            payment_type: 'salary',
            created_by: 'user-1',
          }),
        ],
      },
    ]));
  });
});
