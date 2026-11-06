import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

// Расчётный лист в ЛК: сотрудник — только из сессии; без него 403 до обращения к данным; чужого месяца — 404.

const service = vi.hoisted(() => ({
  getEmployeePayslip: vi.fn(),
  getEmployeeVacationLeft: vi.fn(),
  listEmployeePayslipMonths: vi.fn(),
}));

vi.mock('../services/payroll/employee-payslip.service.js', () => service);

const { employeePayslipController } = await import('./employee-payslip.controller.js');

const makeReq = (employeeId: number | null, month?: string): AuthenticatedRequest => ({
  params: month ? { month } : {},
  user: { id: 'u1', employee_id: employeeId },
} as unknown as AuthenticatedRequest);

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as Record<string, unknown> | undefined,
    status(code: number) { res.statusCode = code; return res; },
    json(payload: Record<string, unknown>) { res.body = payload; return res; },
  };
  return res as unknown as Response & { statusCode: number; body?: Record<string, unknown> };
};

beforeEach(() => {
  vi.clearAllMocks();
  service.listEmployeePayslipMonths.mockResolvedValue(['2026-08', '2026-07']);
  service.getEmployeeVacationLeft.mockResolvedValue({ days: '16.31', until: '2026-11-06' });
  service.getEmployeePayslip.mockResolvedValue({ state: 'not_ready', month: '2026-08' });
});

describe('employeePayslipController', () => {
  it('сводка: месяцы и остаток отпуска своего сотрудника', async () => {
    const res = makeRes();
    await employeePayslipController.getSummary(makeReq(2520), res);
    expect(res.body).toEqual({
      success: true,
      data: { months: ['2026-08', '2026-07'], vacation: { days: '16.31', until: '2026-11-06' } },
    });
    expect(service.listEmployeePayslipMonths).toHaveBeenCalledWith(2520);
  });

  it('учётка без сотрудника — 403, данные не читаются', async () => {
    for (const handler of [employeePayslipController.getSummary, employeePayslipController.getMonth]) {
      const res = makeRes();
      await handler(makeReq(null, '2026-08'), res);
      expect(res.statusCode).toBe(403);
    }
    expect(service.listEmployeePayslipMonths).not.toHaveBeenCalled();
    expect(service.getEmployeePayslip).not.toHaveBeenCalled();
  });

  it('некорректный месяц — 400', async () => {
    const res = makeRes();
    await employeePayslipController.getMonth(makeReq(2520, '2026-13'), res);
    expect(res.statusCode).toBe(400);
    expect(service.getEmployeePayslip).not.toHaveBeenCalled();
  });

  it('месяца нет в списке — 404', async () => {
    service.getEmployeePayslip.mockResolvedValue(null);
    const res = makeRes();
    await employeePayslipController.getMonth(makeReq(2520, '2025-01'), res);
    expect(res.statusCode).toBe(404);
  });

  it('месяц — ready / not_ready как есть', async () => {
    const res = makeRes();
    await employeePayslipController.getMonth(makeReq(2520, '2026-08'), res);
    expect(res.body).toEqual({ success: true, data: { state: 'not_ready', month: '2026-08' } });
    expect(service.getEmployeePayslip.mock.calls[0]?.slice(0, 2)).toEqual([2520, '2026-08']);
  });
});
