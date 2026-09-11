import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const { pgQuery, pgQueryOne, pgExecute, pgTx, txClient } = vi.hoisted(() => {
  const txClient = { query: vi.fn() };
  return {
    pgQuery: vi.fn(),
    pgQueryOne: vi.fn(),
    pgExecute: vi.fn(),
    pgTx: vi.fn(async (fn: (c: unknown) => unknown) => fn(txClient)),
    txClient,
  };
});

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: pgExecute,
  withTransaction: pgTx,
}));

const scope = vi.hoisted(() => ({
  canAccessEmployeeInScope: vi.fn(async () => true),
  canEditEmployeeInScope: vi.fn(async () => true),
}));

vi.mock('../services/data-scope.service.js', () => scope);

vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: vi.fn(async () => undefined) },
}));

import { payrollTermsController } from './payroll-terms.controller.js';

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
  params: {},
  query: {},
  body: {},
  ...over,
} as unknown as AuthenticatedRequest);

beforeEach(() => {
  vi.clearAllMocks();
  scope.canAccessEmployeeInScope.mockResolvedValue(true);
  scope.canEditEmployeeInScope.mockResolvedValue(true);
  txClient.query.mockResolvedValue({ rows: [{ id: 77 }] });
});

describe('payrollTermsController.assign', () => {
  it('переводит сотрудника с оклада на часы: закрывает прежние условия и вставляет новые', async () => {
    pgQueryOne.mockResolvedValueOnce({ id: 5, calc_type: 'salary' });

    const req = makeReq({
      params: { empId: '42' },
      body: {
        staff_category: 'worker',
        calc_type: 'hourly',
        hourly_rate: 450,
        effective_from: '2026-06-16',
      },
    } as Partial<AuthenticatedRequest>);
    const res = makeRes();

    await payrollTermsController.assign(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);

    const statements = txClient.query.mock.calls.map(call => String(call[0]));
    // Порядок важен: сначала закрыть действующие, потом снять более поздние, потом вставить.
    expect(statements[0]).toMatch(/UPDATE payroll_compensation_terms/i);
    expect(statements[0]).toMatch(/effective_to/i);
    expect(statements[1]).toMatch(/DELETE FROM payroll_compensation_terms/i);
    expect(statements[2]).toMatch(/INSERT INTO payroll_compensation_terms/i);

    // Часовая ставка легла в hourly_rate, оклад остался пустым — иначе сработал бы XOR в БД.
    const insertParams = txClient.query.mock.calls[2][1] as unknown[];
    expect(insertParams[3]).toBe('hourly');
    expect(insertParams[4]).toBeNull();
    expect(insertParams[5]).toBe(450);
  });

  it('оклад без суммы отклоняется до похода в БД', async () => {
    const req = makeReq({
      params: { empId: '42' },
      body: { staff_category: 'office', calc_type: 'salary', effective_from: '2026-06-01' },
    } as Partial<AuthenticatedRequest>);
    const res = makeRes();

    await payrollTermsController.assign(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/оклад/i);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('часовая ставка не сохраняется как оклад при calc_type=salary', async () => {
    pgQueryOne.mockResolvedValueOnce(null);

    const req = makeReq({
      params: { empId: '7' },
      body: {
        staff_category: 'itr',
        calc_type: 'salary',
        monthly_salary: 175000,
        hourly_rate: 999,
        effective_from: '2026-01-01',
      },
    } as Partial<AuthenticatedRequest>);
    const res = makeRes();

    await payrollTermsController.assign(req, res);

    const insertParams = txClient.query.mock.calls[2][1] as unknown[];
    expect(insertParams[4]).toBe(175000);
    // hourly_rate обнуляется несмотря на то, что пришёл в теле запроса.
    expect(insertParams[5]).toBeNull();
  });

  it('сотрудник вне скоупа получает 403 до записи', async () => {
    scope.canEditEmployeeInScope.mockResolvedValue(false);

    const req = makeReq({
      params: { empId: '42' },
      body: {
        staff_category: 'worker', calc_type: 'hourly', hourly_rate: 450, effective_from: '2026-06-16',
      },
    } as Partial<AuthenticatedRequest>);
    const res = makeRes();

    await payrollTermsController.assign(req, res);

    expect(res.statusCode).toBe(403);
    expect(pgTx).not.toHaveBeenCalled();
  });
});

describe('payrollTermsController.assignBulk', () => {
  it('недоступные сотрудники попадают в skipped, а не пропадают молча', async () => {
    scope.canEditEmployeeInScope.mockImplementation(async (_req: unknown, id: number) => id !== 2);

    const req = makeReq({
      body: {
        employee_ids: [1, 2, 3],
        staff_category: 'worker',
        calc_type: 'hourly',
        hourly_rate: 400,
        effective_from: '2026-07-01',
      },
    } as Partial<AuthenticatedRequest>);
    const res = makeRes();

    await payrollTermsController.assignBulk(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.applied).toHaveLength(2);
    expect(res.body.data.skipped).toEqual([
      { employee_id: 2, reason: 'NO_ACCESS', message: 'Нет доступа к сотруднику' },
    ]);
  });

  it('пересечение периодов (SQLSTATE 23P01) не роняет всю пачку', async () => {
    let call = 0;
    pgTx.mockImplementation(async (fn: (c: unknown) => unknown) => {
      call += 1;
      if (call === 2) {
        const err = new Error('conflicting key value violates exclusion constraint');
        (err as Error & { code: string }).code = '23P01';
        throw err;
      }
      return fn(txClient);
    });

    const req = makeReq({
      body: {
        employee_ids: [10, 11, 12],
        staff_category: 'office',
        calc_type: 'salary',
        monthly_salary: 120000,
        effective_from: '2026-03-01',
      },
    } as Partial<AuthenticatedRequest>);
    const res = makeRes();

    await payrollTermsController.assignBulk(req, res);

    expect(res.body.data.applied.map((r: { employee_id: number }) => r.employee_id)).toEqual([10, 12]);
    expect(res.body.data.skipped).toEqual([
      { employee_id: 11, reason: 'OVERLAPS_EXISTING', message: 'Условия на эту дату пересекаются с существующими' },
    ]);
  });
});

describe('payrollTermsController.list', () => {
  it('сотрудники без условий остаются в выдаче: молча пропасть из расчёта они не должны', async () => {
    pgQuery.mockResolvedValueOnce([
      { employee_id: 1, full_name: 'А', terms_id: 9, calc_type: 'salary' },
      { employee_id: 2, full_name: 'Б', terms_id: null, calc_type: null },
    ]);

    const req = makeReq({ query: { date: '2026-08-01' } } as Partial<AuthenticatedRequest>);
    const res = makeRes();

    await payrollTermsController.list(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.date).toBe('2026-08-01');
    // LEFT JOIN, а не INNER: иначе сотрудники без условий исчезли бы с экрана.
    expect(String(pgQuery.mock.calls[0][0])).toMatch(/LEFT JOIN payroll_compensation_terms/i);
  });

  it('некорректная дата отклоняется', async () => {
    const req = makeReq({ query: { date: '01.08.2026' } } as Partial<AuthenticatedRequest>);
    const res = makeRes();

    await payrollTermsController.list(req, res);

    expect(res.statusCode).toBe(400);
    expect(pgQuery).not.toHaveBeenCalled();
  });
});
