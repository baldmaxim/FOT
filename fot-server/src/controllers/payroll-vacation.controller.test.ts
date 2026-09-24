import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const scope = vi.hoisted(() => ({
  canAccessEmployeeInScope: vi.fn(async () => true),
}));

vi.mock('../services/data-scope.service.js', () => scope);

const vacation = vi.hoisted(() => ({
  getVacationSummary: vi.fn(),
  getVacationHistory: vi.fn(),
}));

vi.mock('../services/payroll/payroll-vacation.service.js', () => vacation);

import { payrollVacationController } from './payroll-vacation.controller.js';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: any };
};

const makeReq = (empId: string): AuthenticatedRequest => ({
  user: { id: 'user-1' },
  params: { empId },
  query: {},
  body: {},
} as unknown as AuthenticatedRequest);

beforeEach(() => {
  vi.clearAllMocks();
  scope.canAccessEmployeeInScope.mockResolvedValue(true);
});

describe('payrollVacationController.getByEmployee', () => {
  it('сотрудник вне скоупа — 403, отпуска не читаются', async () => {
    scope.canAccessEmployeeInScope.mockResolvedValueOnce(false);
    const res = makeRes();

    await payrollVacationController.getByEmployee(makeReq('42'), res);

    expect(res.statusCode).toBe(403);
    expect(vacation.getVacationSummary).not.toHaveBeenCalled();
    expect(vacation.getVacationHistory).not.toHaveBeenCalled();
  });

  it('некорректный id — 403 без проверки скоупа', async () => {
    const res = makeRes();

    await payrollVacationController.getByEmployee(makeReq('abc'), res);

    expect(res.statusCode).toBe(403);
    expect(scope.canAccessEmployeeInScope).not.toHaveBeenCalled();
  });

  it('отдаёт сводку на сегодня по Москве и историю', async () => {
    const summary = { year: 2026, today: '2026-09-24', used_days: 9, planned_days: 5, unpaid_days: 3 };
    vacation.getVacationSummary.mockResolvedValueOnce(summary);
    vacation.getVacationHistory.mockResolvedValueOnce([]);
    const res = makeRes();

    await payrollVacationController.getByEmployee(makeReq('42'), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ summary, history: [] });
    const [employeeId, today] = vacation.getVacationSummary.mock.calls[0];
    expect(employeeId).toBe(42);
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(vacation.getVacationHistory).toHaveBeenCalledWith(42);
  });

  it('ошибка БД — 500 с понятным текстом', async () => {
    vacation.getVacationSummary.mockRejectedValueOnce(new Error('db down'));
    vacation.getVacationHistory.mockResolvedValueOnce([]);
    const res = makeRes();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await payrollVacationController.getByEmployee(makeReq('42'), res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/отпуск/i);
    consoleError.mockRestore();
  });
});
