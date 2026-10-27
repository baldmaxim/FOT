import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

// Расчёт и SQL проверяют calc- и PG-тесты; здесь — разбор запроса, скоуп отдела, состав бригады, аудит.
const svc = vi.hoisted(() => ({
  loadSalaryDepartment: vi.fn(),
  canReadSalaryDepartment: vi.fn(),
  getTimesheetSalary: vi.fn(),
  setBrigadeOutput: vi.fn(),
  setBrigadeKtu: vi.fn(),
  listBrigadeMemberIds: vi.fn(),
  listBrigadeSupervisorEmployeeIdsForDepartments: vi.fn(),
  canEditPayrollEmployee: vi.fn(),
}));

vi.mock('../services/payroll/timesheet-salary.service.js', () => ({
  loadSalaryDepartment: svc.loadSalaryDepartment,
  canReadSalaryDepartment: svc.canReadSalaryDepartment,
  getTimesheetSalary: svc.getTimesheetSalary,
}));
vi.mock('../services/payroll/brigade-salary-inputs.service.js', () => ({
  setBrigadeOutput: svc.setBrigadeOutput,
  setBrigadeKtu: svc.setBrigadeKtu,
}));
vi.mock('../services/payroll/brigade-salary-source.service.js', () => ({
  listBrigadeMemberIds: svc.listBrigadeMemberIds,
}));
vi.mock('../services/payroll/payroll-scope.service.js', () => ({
  canEditPayrollEmployee: svc.canEditPayrollEmployee,
}));
vi.mock('./timesheet-assigned-export.controller.js', () => ({
  listBrigadeSupervisorEmployeeIdsForDepartments: svc.listBrigadeSupervisorEmployeeIdsForDepartments,
}));

const audit = vi.hoisted(() => ({ logFromRequest: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock('../services/audit.service.js', () => ({ auditService: audit }));

import { timesheetSalaryController } from './timesheet-salary.controller.js';

const BRIGADE_ID = '5049c2c9-1334-49e6-8d55-7a04bebcaa8c';
const BRIGADE = { id: BRIGADE_ID, name: 'бр.Аюби М.С.', kind: 'brigade' };
const DEPARTMENT = { id: '11111111-1111-4111-8111-111111111111', name: 'Отдел цифровой трансформации', kind: 'department' };

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
  user: { id: 'user-1' }, params: {}, query: {}, body: {}, ...over,
} as unknown as AuthenticatedRequest);

const putOutput = async (body: Record<string, unknown>) => {
  const res = makeRes();
  await timesheetSalaryController.setOutput(makeReq({ body }), res);
  return res;
};

const putKtu = async (body: Record<string, unknown>) => {
  const res = makeRes();
  await timesheetSalaryController.setKtu(makeReq({ body }), res);
  return res;
};

beforeEach(() => {
  vi.resetAllMocks();
  svc.loadSalaryDepartment.mockResolvedValue(BRIGADE);
  svc.canReadSalaryDepartment.mockResolvedValue(true);
  svc.listBrigadeMemberIds.mockResolvedValue([1951, 2325]);
  svc.listBrigadeSupervisorEmployeeIdsForDepartments.mockResolvedValue(new Set([1438]));
  svc.canEditPayrollEmployee.mockResolvedValue(true);
});

describe('timesheetSalaryController.get', () => {
  it('неверный месяц — 400', async () => {
    const res = makeRes();
    await timesheetSalaryController.get(makeReq({ query: { department_id: BRIGADE_ID, month: '2026-13' } }), res);
    expect(res.statusCode).toBe(400);
  });

  it('чужой отдел — 403, расчёт не запускается', async () => {
    svc.canReadSalaryDepartment.mockResolvedValue(false);
    const res = makeRes();
    await timesheetSalaryController.get(makeReq({ query: { department_id: BRIGADE_ID, month: '2026-10' } }), res);
    expect(res.statusCode).toBe(403);
    expect(svc.getTimesheetSalary).not.toHaveBeenCalled();
  });

  it('нет отдела — 404', async () => {
    svc.loadSalaryDepartment.mockResolvedValue(null);
    const res = makeRes();
    await timesheetSalaryController.get(makeReq({ query: { department_id: BRIGADE_ID, month: '2026-10' } }), res);
    expect(res.statusCode).toBe(404);
  });
});

describe('timesheetSalaryController.setOutput', () => {
  it('сохраняет до копеек и пишет «было → стало» в аудит', async () => {
    svc.setBrigadeOutput.mockResolvedValue({ before: null, after: '1000000.00' });
    const res = await putOutput({ department_id: BRIGADE_ID, month: '2026-10', amount: 1000000 });
    expect(res.statusCode).toBe(200);
    expect(svc.setBrigadeOutput).toHaveBeenCalledWith(BRIGADE_ID, '2026-10-01', '1000000.00', 'user-1');
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'BRIGADE_SALARY_OUTPUT_SET',
      expect.objectContaining({ details: expect.objectContaining({ amount: { from: null, to: '1000000.00' } }) }),
    );
  });

  it('0,00 — разрешено, null — убрать', async () => {
    svc.setBrigadeOutput.mockResolvedValue({ before: '5.00', after: '0.00' });
    expect((await putOutput({ department_id: BRIGADE_ID, month: '2026-10', amount: 0 })).statusCode).toBe(200);
    svc.setBrigadeOutput.mockResolvedValue({ before: '0.00', after: null });
    expect((await putOutput({ department_id: BRIGADE_ID, month: '2026-10', amount: null })).statusCode).toBe(200);
    expect(svc.setBrigadeOutput).toHaveBeenLastCalledWith(BRIGADE_ID, '2026-10-01', null, 'user-1');
  });

  it('третий знак после запятой и минус — 400', async () => {
    expect((await putOutput({ department_id: BRIGADE_ID, month: '2026-10', amount: 1.005 })).statusCode).toBe(400);
    expect((await putOutput({ department_id: BRIGADE_ID, month: '2026-10', amount: -1 })).statusCode).toBe(400);
    expect(svc.setBrigadeOutput).not.toHaveBeenCalled();
  });

  it('чужой отдел — 403, отдел (не бригада) — 400', async () => {
    svc.canReadSalaryDepartment.mockResolvedValueOnce(false);
    expect((await putOutput({ department_id: BRIGADE_ID, month: '2026-10', amount: 10 })).statusCode).toBe(403);
    svc.loadSalaryDepartment.mockResolvedValueOnce(DEPARTMENT);
    expect((await putOutput({ department_id: DEPARTMENT.id, month: '2026-10', amount: 10 })).statusCode).toBe(400);
    expect(svc.setBrigadeOutput).not.toHaveBeenCalled();
  });
});

describe('timesheetSalaryController.setKtu', () => {
  it('КТУ 1,5 — сохраняется в десятых, аудит', async () => {
    svc.setBrigadeKtu.mockResolvedValue({ before: 10, after: 15 });
    const res = await putKtu({ department_id: BRIGADE_ID, month: '2026-10', employee_id: 1951, ktu: 1.5 });
    expect(res.statusCode).toBe(200);
    expect(svc.setBrigadeKtu).toHaveBeenCalledWith(BRIGADE_ID, '2026-10-01', 1951, 15, 'user-1');
    expect(res.body.data).toEqual({ employee_id: 1951, ktu: '1.5' });
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'BRIGADE_SALARY_KTU_SET',
      expect.objectContaining({ details: expect.objectContaining({ ktu: { from: '1.0', to: '1.5' } }) }),
    );
  });

  it.each([0.55, 0.4, 2.1, 1.25])('КТУ %s — 400', async ktu => {
    const res = await putKtu({ department_id: BRIGADE_ID, month: '2026-10', employee_id: 1951, ktu });
    expect(res.statusCode).toBe(400);
    expect(svc.setBrigadeKtu).not.toHaveBeenCalled();
  });

  it('не из бригады и начальник участка — 400', async () => {
    expect((await putKtu({ department_id: BRIGADE_ID, month: '2026-10', employee_id: 777, ktu: 1 })).statusCode).toBe(400);
    svc.listBrigadeMemberIds.mockResolvedValueOnce([1951, 1438]);
    expect((await putKtu({ department_id: BRIGADE_ID, month: '2026-10', employee_id: 1438, ktu: 1 })).statusCode).toBe(400);
    expect(svc.setBrigadeKtu).not.toHaveBeenCalled();
  });

  it('нет права на строку (сам себе) — 403', async () => {
    svc.canEditPayrollEmployee.mockResolvedValue(false);
    const res = await putKtu({ department_id: BRIGADE_ID, month: '2026-10', employee_id: 1951, ktu: 1.2 });
    expect(res.statusCode).toBe(403);
    expect(svc.setBrigadeKtu).not.toHaveBeenCalled();
  });

  it('чужой отдел — 403 до проверки состава', async () => {
    svc.canReadSalaryDepartment.mockResolvedValue(false);
    const res = await putKtu({ department_id: BRIGADE_ID, month: '2026-10', employee_id: 1951, ktu: 1.2 });
    expect(res.statusCode).toBe(403);
    expect(svc.listBrigadeMemberIds).not.toHaveBeenCalled();
  });
});
