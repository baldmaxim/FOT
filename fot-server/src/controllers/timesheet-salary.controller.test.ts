import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

// Расчёт и SQL проверяют calc- и PG-тесты; здесь — разбор запроса, скоуп отдела, состав бригады, аудит.
const svc = vi.hoisted(() => ({
  loadSalaryDepartment: vi.fn(),
  canReadSalaryDepartment: vi.fn(),
  getTimesheetSalary: vi.fn(),
  setBrigadeObjectOutput: vi.fn(),
  loadBrigadeSalaryInputs: vi.fn(),
  loadBrigadeObjectKeys: vi.fn(),
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
  setBrigadeObjectOutput: svc.setBrigadeObjectOutput,
  loadBrigadeSalaryInputs: svc.loadBrigadeSalaryInputs,
  setBrigadeKtu: svc.setBrigadeKtu,
}));
vi.mock('../services/payroll/brigade-salary.service.js', () => ({
  loadBrigadeObjectKeys: svc.loadBrigadeObjectKeys,
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

const putObjectOutput = async (body: Record<string, unknown>) => {
  const res = makeRes();
  await timesheetSalaryController.setObjectOutput(makeReq({ body }), res);
  return res;
};

const WAVE = '2b1f7a0e-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const ALIA = '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a';
const DELETED = '0a0b0c0d-0e0f-4a1b-8c2d-3e4f5a6b7c8d';

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
  svc.loadBrigadeSalaryInputs.mockResolvedValue({ outputs: new Map(), ktu: new Map() });
  // Объекты бригады за месяц: ЖК Wave, «Не определён» и удалённый из справочника объект из снимка закрытого табеля.
  svc.loadBrigadeObjectKeys.mockResolvedValue(new Map([
    [WAVE, 'ЖК Wave'], ['__unknown_object__', 'Не определён'], [DELETED, 'ЖК Старый'],
  ]));
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

  it('preliminary=1 — предварительный режим; без параметра (старый фронт) — прежний контракт', async () => {
    svc.loadSalaryDepartment.mockResolvedValue(DEPARTMENT);
    svc.getTimesheetSalary.mockResolvedValue({ rows: [] });
    const query = { department_id: DEPARTMENT.id, month: '2026-09' };

    await timesheetSalaryController.get(makeReq({ query: { ...query, preliminary: '1' } }), makeRes());
    await timesheetSalaryController.get(makeReq({ query }), makeRes());

    expect(svc.getTimesheetSalary).toHaveBeenNthCalledWith(1, expect.anything(), DEPARTMENT, '2026-09', { preliminary: true });
    expect(svc.getTimesheetSalary).toHaveBeenNthCalledWith(2, expect.anything(), DEPARTMENT, '2026-09', { preliminary: false });
  });

  it('нет отдела — 404', async () => {
    svc.loadSalaryDepartment.mockResolvedValue(null);
    const res = makeRes();
    await timesheetSalaryController.get(makeReq({ query: { department_id: BRIGADE_ID, month: '2026-10' } }), res);
    expect(res.statusCode).toBe(404);
  });
});

describe('timesheetSalaryController.setOutput', () => {
  it('выработка одной суммой на бригаду больше не принимается — 400 «обновите страницу»', async () => {
    const res = await putOutput({ department_id: BRIGADE_ID, month: '2026-10', amount: 1000000 });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('OUTPUT_BY_OBJECT');
    expect(svc.setBrigadeObjectOutput).not.toHaveBeenCalled();
  });
});

describe('timesheetSalaryController.setObjectOutput', () => {
  it('сохраняет до копеек на объекте бригады и пишет «было → стало» в аудит', async () => {
    svc.setBrigadeObjectOutput.mockResolvedValue({ before: null, after: '1000000.00' });
    const res = await putObjectOutput({ department_id: BRIGADE_ID, month: '2026-10', object_key: WAVE, amount: 1000000 });
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ object_key: WAVE, output_amount: '1000000.00' });
    expect(svc.setBrigadeObjectOutput).toHaveBeenCalledWith(BRIGADE_ID, '2026-10-01', WAVE, 'ЖК Wave', '1000000.00', 'user-1');
    expect(audit.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'BRIGADE_SALARY_OBJECT_OUTPUT_SET',
      expect.objectContaining({
        details: expect.objectContaining({ object: 'ЖК Wave', amount: { from: null, to: '1000000.00' } }),
      }),
    );
  });

  it('«Не определён» и объект из снимка, убранный из справочника, — принимаются; 0,00 — разрешено', async () => {
    svc.setBrigadeObjectOutput.mockResolvedValue({ before: null, after: '0.00' });
    expect((await putObjectOutput({
      department_id: BRIGADE_ID, month: '2026-09', object_key: '__unknown_object__', amount: 0,
    })).statusCode).toBe(200);
    expect((await putObjectOutput({
      department_id: BRIGADE_ID, month: '2026-09', object_key: DELETED, amount: 500,
    })).statusCode).toBe(200);
    expect(svc.setBrigadeObjectOutput).toHaveBeenLastCalledWith(BRIGADE_ID, '2026-09-01', DELETED, 'ЖК Старый', '500.00', 'user-1');
  });

  it('объект, где бригада не работала (чужой существующий), — 400', async () => {
    const res = await putObjectOutput({ department_id: BRIGADE_ID, month: '2026-10', object_key: ALIA, amount: 10 });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('OBJECT_NOT_IN_BRIGADE');
    expect(svc.setBrigadeObjectOutput).not.toHaveBeenCalled();
  });

  it('сумма на объекте, откуда часы ушли, — 400 (только стереть); стереть — можно', async () => {
    svc.loadBrigadeSalaryInputs.mockResolvedValue({
      outputs: new Map([[ALIA, { amount: '7000.00', object_name: 'ЖК Alia' }]]), ktu: new Map(),
    });
    const edit = await putObjectOutput({ department_id: BRIGADE_ID, month: '2026-10', object_key: ALIA, amount: 8000 });
    expect(edit.statusCode).toBe(400);
    expect(edit.body.error).toMatch(/только стереть/);

    svc.setBrigadeObjectOutput.mockResolvedValue({ before: '7000.00', after: null });
    const clear = await putObjectOutput({ department_id: BRIGADE_ID, month: '2026-10', object_key: ALIA, amount: null });
    expect(clear.statusCode).toBe(200);
    expect(svc.setBrigadeObjectOutput).toHaveBeenCalledWith(BRIGADE_ID, '2026-10-01', ALIA, 'ЖК Alia', null, 'user-1');
    // Стирание объекты бригады не пересчитывает.
    expect(svc.loadBrigadeObjectKeys).toHaveBeenCalledTimes(1);
  });

  it('стереть не внесённую — 400', async () => {
    const res = await putObjectOutput({ department_id: BRIGADE_ID, month: '2026-10', object_key: WAVE, amount: null });
    expect(res.statusCode).toBe(400);
    expect(svc.setBrigadeObjectOutput).not.toHaveBeenCalled();
  });

  it('третий знак после запятой, минус и кривой ключ объекта — 400', async () => {
    expect((await putObjectOutput({ department_id: BRIGADE_ID, month: '2026-10', object_key: WAVE, amount: 1.005 })).statusCode).toBe(400);
    expect((await putObjectOutput({ department_id: BRIGADE_ID, month: '2026-10', object_key: WAVE, amount: -1 })).statusCode).toBe(400);
    expect((await putObjectOutput({ department_id: BRIGADE_ID, month: '2026-10', object_key: 'ЖК Wave', amount: 1 })).statusCode).toBe(400);
    expect(svc.setBrigadeObjectOutput).not.toHaveBeenCalled();
  });

  it('чужой отдел — 403, отдел (не бригада) — 400', async () => {
    svc.canReadSalaryDepartment.mockResolvedValueOnce(false);
    expect((await putObjectOutput({ department_id: BRIGADE_ID, month: '2026-10', object_key: WAVE, amount: 10 })).statusCode).toBe(403);
    svc.loadSalaryDepartment.mockResolvedValueOnce(DEPARTMENT);
    expect((await putObjectOutput({ department_id: DEPARTMENT.id, month: '2026-10', object_key: WAVE, amount: 10 })).statusCode).toBe(400);
    expect(svc.setBrigadeObjectOutput).not.toHaveBeenCalled();
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
