import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

// Расчёт и SQL проверяют calc- и PG-тесты; здесь — разбор запроса, скоуп отдела, состав бригады, аудит.
const svc = vi.hoisted(() => ({
  loadSalaryDepartment: vi.fn(),
  canReadSalaryDepartment: vi.fn(),
  getTimesheetSalary: vi.fn(),
  setBrigadeObjectOutput: vi.fn(),
  setBrigadeOutput: vi.fn(),
  listBrigadeOutputs: vi.fn(),
  resolveBrigadeOutputDepartmentIds: vi.fn(),
  getBrigadeObjectOutputs: vi.fn(),
  getRequestPayrollSectionAccess: vi.fn(),
  resolveEffectivePageAccess: vi.fn(),
  resolveTimesheetReadableDepartmentId: vi.fn(),
  resolveTimesheetScope: vi.fn(),
  loadBrigadeSalaryInputs: vi.fn(),
  loadBrigadeObjectKeys: vi.fn(),
  setBrigadeKtu: vi.fn(),
  listBrigadeMemberIds: vi.fn(),
  listBrigadeSupervisorEmployeeIdsForDepartments: vi.fn(),
  canEditBrigadeInputEmployee: vi.fn(),
  getBrigadeSalary: vi.fn(),
  setBrigadeShare: vi.fn(),
  query: vi.fn(),
}));

vi.mock('../services/payroll/timesheet-salary.service.js', () => ({
  loadSalaryDepartment: svc.loadSalaryDepartment,
  canReadSalaryDepartment: svc.canReadSalaryDepartment,
  getTimesheetSalary: svc.getTimesheetSalary,
  getBrigadeObjectOutputs: svc.getBrigadeObjectOutputs,
}));
vi.mock('../services/payroll/payroll-access.service.js', () => ({
  getRequestPayrollSectionAccess: svc.getRequestPayrollSectionAccess,
}));
vi.mock('../services/access-control.service.js', () => ({
  resolveEffectivePageAccess: svc.resolveEffectivePageAccess,
}));
vi.mock('../services/timesheet-scope.service.js', () => ({
  resolveTimesheetReadableDepartmentId: svc.resolveTimesheetReadableDepartmentId,
  resolveTimesheetScope: svc.resolveTimesheetScope,
}));
// «Или — или» (341): отказ сервиса — свой класс, отказ триггера БД — P0001 с подсказкой OUTPUT_MODE_CONFLICT.
const conflict = vi.hoisted(() => ({
  BrigadeOutputModeConflictError: class extends Error {},
}));
// Ввод: запись — заглушки; ключ бригады, класс отказа доли и fixedSharesInCents — настоящие (проверка доли — чистая).
vi.mock('../services/payroll/brigade-salary-inputs.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/payroll/brigade-salary-inputs.service.js')>()),
  setBrigadeObjectOutput: svc.setBrigadeObjectOutput,
  setBrigadeOutput: svc.setBrigadeOutput,
  loadBrigadeSalaryInputs: svc.loadBrigadeSalaryInputs,
  setBrigadeKtu: svc.setBrigadeKtu,
  setBrigadeShare: svc.setBrigadeShare,
  BrigadeOutputModeConflictError: conflict.BrigadeOutputModeConflictError,
  isOutputModeConflictDbError: (err: unknown) => (
    (err as { code?: unknown })?.code === 'P0001' && (err as { hint?: unknown })?.hint === 'OUTPUT_MODE_CONFLICT'
  ),
}));
vi.mock('../config/postgres.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../config/postgres.js')>()),
  query: svc.query,
}));
vi.mock('../services/payroll/brigade-output-list.service.js', () => ({
  listBrigadeOutputs: svc.listBrigadeOutputs,
}));
vi.mock('../services/payroll/brigade-salary.service.js', () => ({
  loadBrigadeObjectKeys: svc.loadBrigadeObjectKeys,
  getBrigadeSalary: svc.getBrigadeSalary,
}));
vi.mock('../services/payroll/brigade-salary-source.service.js', () => ({
  listBrigadeMemberIds: svc.listBrigadeMemberIds,
}));
vi.mock('../services/payroll/payroll-scope.service.js', () => ({
  canEditBrigadeInputEmployee: svc.canEditBrigadeInputEmployee,
  resolveBrigadeOutputDepartmentIds: svc.resolveBrigadeOutputDepartmentIds,
}));
vi.mock('./timesheet-assigned-export.controller.js', () => ({
  listBrigadeSupervisorEmployeeIdsForDepartments: svc.listBrigadeSupervisorEmployeeIdsForDepartments,
}));

const audit = vi.hoisted(() => ({
  logFromRequest: vi.fn(async (..._args: unknown[]) => undefined),
  logFromRequestWithClient: vi.fn(async (..._args: unknown[]) => undefined),
}));

/** Сервис записи: смена и аудит-колбэк в «транзакции» (client — заглушка), как writeBrigadeOutput. */
const CLIENT = { tx: true };
const writes = (change: { before: string | null; after: string | null }) => async (...args: unknown[]) => {
  const auditFn = args[args.length - 1];
  if (typeof auditFn === 'function' && change.before !== change.after) await auditFn(CLIENT, change);
  return change;
};
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
  svc.canEditBrigadeInputEmployee.mockResolvedValue(true);
  svc.query.mockResolvedValue([]);
  svc.loadBrigadeSalaryInputs.mockResolvedValue({ outputs: new Map(), brigadeOutput: null, ktu: new Map() });
  svc.resolveBrigadeOutputDepartmentIds.mockResolvedValue('all');
  // По умолчанию — учётка из списка «Зарплаты»; галочка — в своём describe.
  svc.getRequestPayrollSectionAccess.mockResolvedValue(true);
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

describe('timesheetSalaryController.get — галочка «Выработка» без списка «Зарплаты» (342)', () => {
  const getSalary = async (query: Record<string, string>, user: Record<string, unknown> = {}) => {
    const res = makeRes();
    await timesheetSalaryController.get(makeReq({
      query,
      user: { id: 'user-2', timesheet_months_back: 3, timesheet_months_forward: 2, ...user },
    } as unknown as Partial<AuthenticatedRequest>), res);
    return res;
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-03T12:00:00Z') });
    svc.getRequestPayrollSectionAccess.mockResolvedValue(false);
    svc.canReadSalaryDepartment.mockResolvedValue(false);
    svc.resolveEffectivePageAccess.mockResolvedValue(true);
    svc.resolveTimesheetReadableDepartmentId.mockImplementation(async (_req: unknown, id: string) => id);
    svc.resolveTimesheetScope.mockResolvedValue('department');
    svc.getTimesheetSalary.mockResolvedValue({ rows: [] });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('бригада, читаемая в табеле, в окне месяцев — 200', async () => {
    const res = await getSalary({ department_id: BRIGADE_ID, month: '2026-11' });
    expect(res.statusCode).toBe(200);
    expect(svc.getTimesheetSalary).toHaveBeenCalledWith(expect.anything(), BRIGADE, '2026-11', { preliminary: false });
    expect(svc.canReadSalaryDepartment).not.toHaveBeenCalled();
  });

  it('обычный отдел — 403, расчёт с окладами не запускается', async () => {
    svc.loadSalaryDepartment.mockResolvedValue(DEPARTMENT);
    const res = await getSalary({ department_id: DEPARTMENT.id, month: '2026-11' });
    expect(res.statusCode).toBe(403);
    expect(svc.getTimesheetSalary).not.toHaveBeenCalled();
  });

  it('глобальный просмотр табеля, но нет страниц /timesheet и /timesheet-hr — 403', async () => {
    svc.resolveEffectivePageAccess.mockResolvedValue(false);
    const res = await getSalary({ department_id: BRIGADE_ID, month: '2026-11' });
    expect(res.statusCode).toBe(403);
    expect(svc.resolveEffectivePageAccess).toHaveBeenCalledWith(expect.anything(), '/timesheet', 'view');
    expect(svc.resolveEffectivePageAccess).toHaveBeenCalledWith(expect.anything(), '/timesheet-hr', 'view');
    expect(svc.getTimesheetSalary).not.toHaveBeenCalled();
  });

  it('достаточно одной из двух страниц', async () => {
    svc.resolveEffectivePageAccess.mockImplementation(async (_req: unknown, page: string) => page === '/timesheet-hr');
    expect((await getSalary({ department_id: BRIGADE_ID, month: '2026-11' })).statusCode).toBe(200);
  });

  it('бригада не читается в табеле этой роли — 403', async () => {
    svc.resolveTimesheetReadableDepartmentId.mockResolvedValue(null);
    const res = await getSalary({ department_id: BRIGADE_ID, month: '2026-11' });
    expect(res.statusCode).toBe(403);
    expect(svc.getTimesheetSalary).not.toHaveBeenCalled();
  });

  it('окно −3/+2 от ноября 2026: август и январь — 200, июль и февраль — 403 с текстом про окно', async () => {
    expect((await getSalary({ department_id: BRIGADE_ID, month: '2026-08' })).statusCode).toBe(200);
    expect((await getSalary({ department_id: BRIGADE_ID, month: '2027-01' })).statusCode).toBe(200);
    svc.getTimesheetSalary.mockClear();
    for (const month of ['2026-07', '2027-02']) {
      const res = await getSalary({ department_id: BRIGADE_ID, month });
      expect(res.statusCode).toBe(403);
      expect(res.body.error).toContain('вне разрешённого окна');
    }
    expect(svc.getTimesheetSalary).not.toHaveBeenCalled();
  });

  it('скоуп вне окна (администратор компании) — окно не применяется', async () => {
    svc.resolveTimesheetScope.mockResolvedValue('all');
    expect((await getSalary({ department_id: BRIGADE_ID, month: '2025-01' })).statusCode).toBe(200);
  });

  it('нет отдела — 404', async () => {
    svc.loadSalaryDepartment.mockResolvedValue(null);
    expect((await getSalary({ department_id: BRIGADE_ID, month: '2026-11' })).statusCode).toBe(404);
  });
});

describe('timesheetSalaryController.get — учётка из списка «Зарплаты»: прежний путь', () => {
  it('страница табеля, тип отдела и окно месяцев не проверяются', async () => {
    svc.loadSalaryDepartment.mockResolvedValue(DEPARTMENT);
    svc.getTimesheetSalary.mockResolvedValue({ rows: [] });
    const res = makeRes();
    await timesheetSalaryController.get(makeReq({ query: { department_id: DEPARTMENT.id, month: '2020-01' } }), res);
    expect(res.statusCode).toBe(200);
    expect(svc.canReadSalaryDepartment).toHaveBeenCalled();
    expect(svc.resolveEffectivePageAccess).not.toHaveBeenCalled();
    expect(svc.resolveTimesheetReadableDepartmentId).not.toHaveBeenCalled();
  });
});

describe('timesheetSalaryController.brigadeObjects — стрелка во «Бригадах»', () => {
  const getObjects = async (query: Record<string, string>) => {
    const res = makeRes();
    await timesheetSalaryController.brigadeObjects(makeReq({ query }), res);
    return res;
  };

  it('бригада — 200, данные сервиса без изменений', async () => {
    const data = { department_id: BRIGADE_ID, month: '2026-11', output_mode: 'objects', objects: [] };
    svc.getBrigadeObjectOutputs.mockResolvedValue(data);
    const res = await getObjects({ department_id: BRIGADE_ID, month: '2026-11' });
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual(data);
  });

  it('обычный отдел — 400 без вызова расчёта', async () => {
    svc.loadSalaryDepartment.mockResolvedValue(DEPARTMENT);
    const res = await getObjects({ department_id: DEPARTMENT.id, month: '2026-11' });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('NOT_BRIGADE');
    expect(svc.getBrigadeObjectOutputs).not.toHaveBeenCalled();
  });

  it('бригада вне охвата — 403; нет отдела — 404; неверный месяц — 400', async () => {
    svc.resolveBrigadeOutputDepartmentIds.mockResolvedValue(['other']);
    expect((await getObjects({ department_id: BRIGADE_ID, month: '2026-11' })).statusCode).toBe(403);
    svc.loadSalaryDepartment.mockResolvedValue(null);
    expect((await getObjects({ department_id: BRIGADE_ID, month: '2026-11' })).statusCode).toBe(404);
    expect((await getObjects({ department_id: BRIGADE_ID, month: '2026-13' })).statusCode).toBe(400);
    expect(svc.getBrigadeObjectOutputs).not.toHaveBeenCalled();
  });
});

describe('ввод выработки — новый охват, а не охват «Зарплаты»', () => {
  it('сумма бригаде и на объект: чужая для табеля бригада — 200, бригада вне охвата — 403', async () => {
    svc.canReadSalaryDepartment.mockResolvedValue(false);
    svc.setBrigadeOutput.mockImplementation(writes({ before: null, after: '5.00' }));
    svc.setBrigadeObjectOutput.mockImplementation(writes({ before: null, after: '5.00' }));
    const brigade = { department_id: BRIGADE_ID, month: '2026-11', amount: 5 };
    const object = { ...brigade, object_key: WAVE };
    expect((await putOutput(brigade)).statusCode).toBe(200);
    expect((await putObjectOutput(object)).statusCode).toBe(200);

    svc.resolveBrigadeOutputDepartmentIds.mockResolvedValue(['other']);
    expect((await putOutput(brigade)).statusCode).toBe(403);
    expect((await putObjectOutput(object)).statusCode).toBe(403);
  });
});

describe('timesheetSalaryController.listBrigades', () => {
  it('список бригад месяца — в пределах видимых отделов «Зарплаты»', async () => {
    svc.resolveBrigadeOutputDepartmentIds.mockResolvedValue([BRIGADE_ID]);
    svc.listBrigadeOutputs.mockResolvedValue([{ department_id: BRIGADE_ID, name: 'бр.Аюби М.С.' }]);
    const res = makeRes();
    await timesheetSalaryController.listBrigades(makeReq({ query: { month: '2026-10' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual([{ department_id: BRIGADE_ID, name: 'бр.Аюби М.С.' }]);
    expect(svc.listBrigadeOutputs).toHaveBeenCalledWith('2026-10', [BRIGADE_ID]);
  });

  it('неверный месяц — 400, список не читается', async () => {
    const res = makeRes();
    await timesheetSalaryController.listBrigades(makeReq({ query: { month: '10-2026' } }), res);
    expect(res.statusCode).toBe(400);
    expect(svc.listBrigadeOutputs).not.toHaveBeenCalled();
  });
});

describe('timesheetSalaryController.setOutput — сумма бригаде (341)', () => {
  it('сохраняет до копеек, «было → стало» — в аудит той же транзакцией', async () => {
    svc.setBrigadeOutput.mockImplementation(writes({ before: null, after: '1000000.00' }));
    const res = await putOutput({ department_id: BRIGADE_ID, month: '2026-10', amount: 1000000 });
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ output_amount: '1000000.00' });
    expect(svc.setBrigadeOutput).toHaveBeenCalledWith(BRIGADE_ID, '2026-10-01', '1000000.00', 'user-1', expect.any(Function));
    expect(audit.logFromRequestWithClient).toHaveBeenCalledWith(
      CLIENT, expect.anything(), 'user-1', 'BRIGADE_SALARY_OUTPUT_SET',
      expect.objectContaining({
        entityId: `${BRIGADE_ID}:2026-10`,
        details: expect.objectContaining({ month: '2026-10', amount: { from: null, to: '1000000.00' } }),
      }),
    );
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });

  it('та же сумма ещё раз — 200 без аудита; стереть — null, уже пустую — тоже 200 без аудита', async () => {
    svc.setBrigadeOutput.mockImplementation(writes({ before: '1000000.00', after: '1000000.00' }));
    expect((await putOutput({ department_id: BRIGADE_ID, month: '2026-10', amount: 1000000 })).statusCode).toBe(200);
    svc.setBrigadeOutput.mockImplementation(writes({ before: null, after: null }));
    const clear = await putOutput({ department_id: BRIGADE_ID, month: '2026-10', amount: null });
    expect(clear.statusCode).toBe(200);
    expect(clear.body.data).toEqual({ output_amount: null });
    expect(svc.setBrigadeOutput).toHaveBeenLastCalledWith(BRIGADE_ID, '2026-10-01', null, 'user-1', expect.any(Function));
    expect(audit.logFromRequestWithClient).not.toHaveBeenCalled();
  });

  it('выработка уже по объектам — 409 с текстом, что стереть; отказ триггера БД — тоже 409', async () => {
    svc.setBrigadeOutput.mockRejectedValueOnce(new conflict.BrigadeOutputModeConflictError(
      'Внесена выработка по объектам — сотрите её, чтобы внести на бригаду',
    ));
    const service = await putOutput({ department_id: BRIGADE_ID, month: '2026-10', amount: 5 });
    expect(service.statusCode).toBe(409);
    expect(service.body).toMatchObject({ code: 'OUTPUT_MODE_CONFLICT', error: expect.stringMatching(/сотрите её/) });

    svc.setBrigadeOutput.mockRejectedValueOnce(Object.assign(new Error('Внесена выработка по объектам'), {
      code: 'P0001', hint: 'OUTPUT_MODE_CONFLICT',
    }));
    expect((await putOutput({ department_id: BRIGADE_ID, month: '2026-10', amount: 5 })).statusCode).toBe(409);
  });

  it('отдел (не бригада) — 400, чужой — 403, нет отдела — 404; третий знак и минус — 400', async () => {
    svc.loadSalaryDepartment.mockResolvedValueOnce(DEPARTMENT);
    const notBrigade = await putOutput({ department_id: DEPARTMENT.id, month: '2026-10', amount: 10 });
    expect(notBrigade.statusCode).toBe(400);
    expect(notBrigade.body.code).toBe('NOT_BRIGADE');
    svc.resolveBrigadeOutputDepartmentIds.mockResolvedValueOnce(['other']);
    expect((await putOutput({ department_id: BRIGADE_ID, month: '2026-10', amount: 10 })).statusCode).toBe(403);
    svc.loadSalaryDepartment.mockResolvedValueOnce(null);
    expect((await putOutput({ department_id: BRIGADE_ID, month: '2026-10', amount: 10 })).statusCode).toBe(404);
    expect((await putOutput({ department_id: BRIGADE_ID, month: '2026-10', amount: 1.005 })).statusCode).toBe(400);
    expect((await putOutput({ department_id: BRIGADE_ID, month: '2026-10', amount: -1 })).statusCode).toBe(400);
    expect(svc.setBrigadeOutput).not.toHaveBeenCalled();
  });
});

describe('timesheetSalaryController.setObjectOutput', () => {
  it('сохраняет до копеек на объекте бригады и пишет «было → стало» в аудит', async () => {
    svc.setBrigadeObjectOutput.mockImplementation(writes({ before: null, after: '1000000.00' }));
    const res = await putObjectOutput({ department_id: BRIGADE_ID, month: '2026-10', object_key: WAVE, amount: 1000000 });
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ object_key: WAVE, output_amount: '1000000.00' });
    expect(svc.setBrigadeObjectOutput).toHaveBeenCalledWith(
      BRIGADE_ID, '2026-10-01', WAVE, 'ЖК Wave', '1000000.00', 'user-1', expect.any(Function),
    );
    expect(audit.logFromRequestWithClient).toHaveBeenCalledWith(
      CLIENT, expect.anything(), 'user-1', 'BRIGADE_SALARY_OBJECT_OUTPUT_SET',
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
    expect(svc.setBrigadeObjectOutput).toHaveBeenLastCalledWith(
      BRIGADE_ID, '2026-09-01', DELETED, 'ЖК Старый', '500.00', 'user-1', expect.any(Function),
    );
  });

  it('объект, где бригада не работала (чужой существующий), — 400', async () => {
    const res = await putObjectOutput({ department_id: BRIGADE_ID, month: '2026-10', object_key: ALIA, amount: 10 });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('OBJECT_NOT_IN_BRIGADE');
    expect(svc.setBrigadeObjectOutput).not.toHaveBeenCalled();
  });

  it('сумма на объекте, откуда часы ушли, — 400 (только стереть); стереть — можно', async () => {
    svc.loadBrigadeSalaryInputs.mockResolvedValue({
      outputs: new Map([[ALIA, { amount: '7000.00', object_name: 'ЖК Alia' }]]), brigadeOutput: null, ktu: new Map(),
    });
    const edit = await putObjectOutput({ department_id: BRIGADE_ID, month: '2026-10', object_key: ALIA, amount: 8000 });
    expect(edit.statusCode).toBe(400);
    expect(edit.body.error).toMatch(/только стереть/);

    svc.setBrigadeObjectOutput.mockResolvedValue({ before: '7000.00', after: null });
    const clear = await putObjectOutput({ department_id: BRIGADE_ID, month: '2026-10', object_key: ALIA, amount: null });
    expect(clear.statusCode).toBe(200);
    expect(svc.setBrigadeObjectOutput).toHaveBeenCalledWith(
      BRIGADE_ID, '2026-10-01', ALIA, 'ЖК Alia', null, 'user-1', expect.any(Function),
    );
    // Стирание объекты бригады не пересчитывает.
    expect(svc.loadBrigadeObjectKeys).toHaveBeenCalledTimes(1);
  });

  it('сумма бригаде уже внесена — 409 «сотрите её», объект не записан', async () => {
    svc.setBrigadeObjectOutput.mockRejectedValueOnce(new conflict.BrigadeOutputModeConflictError(
      'Внесена выработка бригаде — сотрите её, чтобы вносить по объектам',
    ));
    const res = await putObjectOutput({ department_id: BRIGADE_ID, month: '2026-10', object_key: WAVE, amount: 10 });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'OUTPUT_MODE_CONFLICT', error: expect.stringMatching(/сотрите её/) });
    expect(audit.logFromRequestWithClient).not.toHaveBeenCalled();
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
    svc.resolveBrigadeOutputDepartmentIds.mockResolvedValueOnce(['other']);
    expect((await putObjectOutput({ department_id: BRIGADE_ID, month: '2026-10', object_key: WAVE, amount: 10 })).statusCode).toBe(403);
    svc.loadSalaryDepartment.mockResolvedValueOnce(DEPARTMENT);
    expect((await putObjectOutput({ department_id: DEPARTMENT.id, month: '2026-10', object_key: WAVE, amount: 10 })).statusCode).toBe(400);
    expect(svc.setBrigadeObjectOutput).not.toHaveBeenCalled();
  });
});

/** setBrigadeKtu: аудит-колбэк в «транзакции», как настоящий (только при смене КТУ или снятых долях). */
const ktuWrites = (change: { before: number; after: number; cleared_shares: unknown[] }) => async (...args: unknown[]) => {
  const auditFn = args[5];
  if (typeof auditFn === 'function' && (change.before !== change.after || change.cleared_shares.length > 0)) {
    await auditFn(CLIENT, change);
  }
  return change;
};

describe('timesheetSalaryController.setKtu', () => {
  it('КТУ 1,5 — сохраняется в десятых, аудит в транзакции записи', async () => {
    svc.setBrigadeKtu.mockImplementation(ktuWrites({ before: 10, after: 15, cleared_shares: [] }));
    const res = await putKtu({ department_id: BRIGADE_ID, month: '2026-10', employee_id: 1951, ktu: 1.5 });
    expect(res.statusCode).toBe(200);
    expect(svc.setBrigadeKtu).toHaveBeenCalledWith(BRIGADE_ID, '2026-10-01', 1951, 15, 'user-1', expect.any(Function));
    expect(res.body.data).toEqual({ employee_id: 1951, ktu: '1.5' });
    expect(audit.logFromRequestWithClient).toHaveBeenCalledWith(
      CLIENT, expect.anything(), 'user-1', 'BRIGADE_SALARY_KTU_SET',
      expect.objectContaining({ details: expect.objectContaining({ ktu: { from: '1.0', to: '1.5' } }) }),
    );
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });

  it('выбор КТУ снимает вписанные доли — они в том же аудите', async () => {
    const cleared = [{ object_key: WAVE, employee_id: 1951, amount: '150000.00' }];
    svc.setBrigadeKtu.mockImplementation(ktuWrites({ before: 10, after: 10, cleared_shares: cleared }));
    const res = await putKtu({ department_id: BRIGADE_ID, month: '2026-10', employee_id: 1951, ktu: 1 });
    expect(res.statusCode).toBe(200);
    expect(audit.logFromRequestWithClient).toHaveBeenCalledWith(
      CLIENT, expect.anything(), 'user-1', 'BRIGADE_SALARY_KTU_SET',
      expect.objectContaining({ details: expect.objectContaining({ cleared_shares: cleared }) }),
    );
  });

  it('тот же КТУ без долей — без аудита', async () => {
    svc.setBrigadeKtu.mockImplementation(ktuWrites({ before: 12, after: 12, cleared_shares: [] }));
    expect((await putKtu({ department_id: BRIGADE_ID, month: '2026-10', employee_id: 1951, ktu: 1.2 })).statusCode).toBe(200);
    expect(audit.logFromRequestWithClient).not.toHaveBeenCalled();
  });

  it.each([0, 2.2, 0.1, 2])('КТУ %s — в диапазоне 0,0…2,2', async ktu => {
    svc.setBrigadeKtu.mockImplementation(ktuWrites({ before: 10, after: Math.round(ktu * 10), cleared_shares: [] }));
    const res = await putKtu({ department_id: BRIGADE_ID, month: '2026-10', employee_id: 1951, ktu });
    expect(res.statusCode).toBe(200);
    expect(svc.setBrigadeKtu).toHaveBeenCalledWith(BRIGADE_ID, '2026-10-01', 1951, Math.round(ktu * 10), 'user-1', expect.any(Function));
  });

  it.each([-0.1, 2.3, 0.05, 1.25])('КТУ %s — 400', async ktu => {
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
    svc.canEditBrigadeInputEmployee.mockResolvedValue(false);
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

// ─── «Доля», вписанная рублями (355) ─────────────────────────────────────────────────────────────────────────────
// Бригада из 10 человек, у всех 10 учтённых часов на ЖК Wave и КТУ 1,0; выработка Wave 1 000 000.
const TEN = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const NAMES = TEN.map(id => ({ id, full_name: id === 1 ? 'Амонов Абдулло Мирзоевич' : id === 2 ? 'Исмоилов Иброхим Б' : `Рабочий ${id} Р` }));
const tenOnWave = () => ({
  rows: TEN.map(id => ({ employee_id: id, counted_minutes: 600, objects: [{ object_key: WAVE, counted_minutes: 600 }] })),
});
const waveInputs = (fixed?: Array<[number, string]>) => ({
  outputs: new Map([[WAVE, { amount: '1000000.00', object_name: 'ЖК Wave' }]]),
  brigadeOutput: null,
  ktu: new Map(),
  ...(fixed ? { fixedShares: new Map([[WAVE, new Map(fixed)]]) } : {}),
});

/** setBrigadeShare: проверка по «вводу под замком» и аудит — как настоящий. */
const shareWrites = (inputs: unknown, before: string | null = null) => async (...args: unknown[]) => {
  const [, , , , amount, , check, auditFn] = args as [unknown, unknown, unknown, unknown, string | null, unknown,
    (value: unknown) => void, (client: unknown, change: unknown) => Promise<void>];
  if (amount === null && before === null) return { before, after: null };
  if (amount !== null) check(inputs);
  const change = { before, after: amount };
  await auditFn(CLIENT, change);
  return change;
};

const putShare = async (body: Record<string, unknown>, user: Record<string, unknown> = {}) => {
  const res = makeRes();
  await timesheetSalaryController.setShare(makeReq({
    body, user: { id: 'user-1', ...user },
  } as unknown as Partial<AuthenticatedRequest>), res);
  return res;
};

describe('timesheetSalaryController.setShare — «Доля» рублями (355)', () => {
  beforeEach(() => {
    svc.listBrigadeMemberIds.mockResolvedValue(TEN);
    svc.listBrigadeSupervisorEmployeeIdsForDepartments.mockResolvedValue(new Set());
    svc.getBrigadeSalary.mockResolvedValue(tenOnWave());
    svc.query.mockResolvedValue(NAMES);
  });

  const share = (employeeId: number, amount: number | null, objectKey = WAVE) => putShare({
    department_id: BRIGADE_ID, month: '2026-10', object_key: objectKey, employee_id: employeeId, amount,
  });

  it('150 000 — сохраняется строкой, аудит в транзакции записи', async () => {
    svc.setBrigadeShare.mockImplementation(shareWrites(waveInputs()));
    const res = await share(1, 150000);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ object_key: WAVE, employee_id: 1, fixed_share: '150000.00' });
    expect(svc.setBrigadeShare).toHaveBeenCalledWith(
      BRIGADE_ID, '2026-10-01', WAVE, 1, '150000.00', 'user-1', expect.any(Function), expect.any(Function),
    );
    expect(audit.logFromRequestWithClient).toHaveBeenCalledWith(
      CLIENT, expect.anything(), 'user-1', 'BRIGADE_SALARY_SHARE_SET',
      expect.objectContaining({ details: expect.objectContaining({ amount: { from: null, to: '150000.00' } }) }),
    );
  });

  it('максимум при КТУ 2,2 — в копейках вниз: 196 428,57 можно, 196 428,58 — 400 с максимумом', async () => {
    svc.setBrigadeShare.mockImplementation(shareWrites(waveInputs()));
    expect((await share(1, 196428.57)).statusCode).toBe(200);
    const res = await share(1, 196428.58);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'SHARE_REJECTED', error: 'Амонов А. М.: максимум — 196 428,57 (КТУ 2,2)' });
  });

  it('доля второго не выводит первого за 2,2: максимум по вписанному', async () => {
    svc.setBrigadeShare.mockImplementation(shareWrites(waveInputs([[1, '190000.00']])));
    expect((await share(2, 119090.90)).statusCode).toBe(200);
    const res = await share(2, 119090.91);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Максимум — 119 090,90: иначе КТУ по вписанной доле (Амонов А. М.) станет больше 2,2');
  });

  it('конфликт уже есть: уменьшать можно, увеличивать — нет', async () => {
    // Амонову вписано 300 000 — КТУ по доле выше 2,2 (часы сдвинулись после ввода).
    svc.setBrigadeShare.mockImplementation(shareWrites(waveInputs([[1, '300000.00']]), '300000.00'));
    expect((await share(1, 250000)).statusCode).toBe(200);
    expect((await share(1, 310000)).statusCode).toBe(400);
  });

  it('выработка не внесена — 400', async () => {
    svc.setBrigadeShare.mockImplementation(shareWrites({ outputs: new Map(), brigadeOutput: null, ktu: new Map() }));
    const res = await share(1, 1000);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Сначала внесите выработку объекта');
  });

  it('сумма бригаде: долю на объекте не вписать, и наоборот', async () => {
    svc.setBrigadeShare.mockImplementation(shareWrites({ outputs: new Map(), brigadeOutput: '500000.00', ktu: new Map() }));
    expect((await share(1, 1000)).body.error).toBe('Выработка внесена бригаде — долю вписывают в «Итого по бригаде»');
    svc.setBrigadeShare.mockImplementation(shareWrites(waveInputs()));
    expect((await share(1, 1000, '__brigade__')).body.error).toBe('Выработка внесена по объектам — долю вписывают в строке объекта');
  });

  it('нет учтённых часов на объекте — 400', async () => {
    svc.getBrigadeSalary.mockResolvedValue({
      rows: [...tenOnWave().rows.slice(1), { employee_id: 1, counted_minutes: 0, objects: [] }],
    });
    svc.setBrigadeShare.mockImplementation(shareWrites(waveInputs()));
    expect((await share(1, 1000)).body.error).toBe('У сотрудника нет учтённых часов на этом объекте');
  });

  it('не в бригаде или начальник участка — 400, расчёт не запускается', async () => {
    expect((await share(777, 1000)).statusCode).toBe(400);
    svc.listBrigadeSupervisorEmployeeIdsForDepartments.mockResolvedValue(new Set([1]));
    expect((await share(1, 1000)).statusCode).toBe(400);
    expect(svc.getBrigadeSalary).not.toHaveBeenCalled();
    expect(svc.setBrigadeShare).not.toHaveBeenCalled();
  });

  it('стереть — без проверок состава и расчёта (в т. ч. ушедшему из бригады)', async () => {
    svc.setBrigadeShare.mockImplementation(shareWrites(waveInputs(), '150000.00'));
    const res = await share(777, null);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.fixed_share).toBeNull();
    expect(svc.getBrigadeSalary).not.toHaveBeenCalled();
    expect(svc.setBrigadeShare).toHaveBeenCalledWith(
      BRIGADE_ID, '2026-10-01', WAVE, 777, null, 'user-1', expect.any(Function), expect.any(Function),
    );
  });

  it('свою строку — 403', async () => {
    svc.canEditBrigadeInputEmployee.mockResolvedValue(false);
    expect((await share(1, 1000)).statusCode).toBe(403);
    expect(svc.setBrigadeShare).not.toHaveBeenCalled();
  });

  it('неверная сумма и ключ — 400', async () => {
    expect((await share(1, -1)).statusCode).toBe(400);
    expect((await share(1, 1.005)).statusCode).toBe(400);
    expect((await share(1, 1000, 'не-объект')).statusCode).toBe(400);
    expect(svc.setBrigadeShare).not.toHaveBeenCalled();
  });
});

describe('КТУ и «Доля» по галочке «Выработка» без списка «Зарплаты» — там же, где открыт расчёт', () => {
  const asGrant = { id: 'user-2', timesheet_months_back: 3, timesheet_months_forward: 2 };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-03T12:00:00Z') });
    svc.getRequestPayrollSectionAccess.mockResolvedValue(false);
    svc.canReadSalaryDepartment.mockResolvedValue(false);
    svc.resolveEffectivePageAccess.mockResolvedValue(true);
    svc.resolveTimesheetReadableDepartmentId.mockImplementation(async (_req: unknown, id: string) => id);
    svc.resolveTimesheetScope.mockResolvedValue('department');
    svc.listBrigadeMemberIds.mockResolvedValue(TEN);
    svc.listBrigadeSupervisorEmployeeIdsForDepartments.mockResolvedValue(new Set());
    svc.getBrigadeSalary.mockResolvedValue(tenOnWave());
    svc.query.mockResolvedValue(NAMES);
    svc.setBrigadeKtu.mockImplementation(ktuWrites({ before: 10, after: 15, cleared_shares: [] }));
    svc.setBrigadeShare.mockImplementation(shareWrites(waveInputs()));
  });
  afterEach(() => { vi.useRealTimers(); });

  const ktuAs = async (month: string) => {
    const res = makeRes();
    await timesheetSalaryController.setKtu(makeReq({
      body: { department_id: BRIGADE_ID, month, employee_id: 1, ktu: 1.5 }, user: asGrant,
    } as unknown as Partial<AuthenticatedRequest>), res);
    return res;
  };
  const shareAs = (month: string) => putShare(
    { department_id: BRIGADE_ID, month, object_key: WAVE, employee_id: 1, amount: 150000 }, asGrant,
  );

  it('своя читаемая бригада в окне месяцев — 200, охват «Зарплаты» не спрашивается', async () => {
    expect((await ktuAs('2026-11')).statusCode).toBe(200);
    expect((await shareAs('2026-11')).statusCode).toBe(200);
    expect(svc.canReadSalaryDepartment).not.toHaveBeenCalled();
  });

  it('бригада не читается в табеле — 403, записи нет', async () => {
    svc.resolveTimesheetReadableDepartmentId.mockResolvedValue(null);
    expect((await ktuAs('2026-11')).statusCode).toBe(403);
    expect((await shareAs('2026-11')).statusCode).toBe(403);
    expect(svc.setBrigadeKtu).not.toHaveBeenCalled();
    expect(svc.setBrigadeShare).not.toHaveBeenCalled();
  });

  it('месяц вне окна роли — 403', async () => {
    expect((await ktuAs('2026-07')).statusCode).toBe(403);
    expect((await shareAs('2027-02')).statusCode).toBe(403);
    expect(svc.setBrigadeKtu).not.toHaveBeenCalled();
    expect(svc.setBrigadeShare).not.toHaveBeenCalled();
  });

  it('нет страницы табеля — 403', async () => {
    svc.resolveEffectivePageAccess.mockResolvedValue(false);
    expect((await ktuAs('2026-11')).statusCode).toBe(403);
    expect((await shareAs('2026-11')).statusCode).toBe(403);
  });

  it('обычный отдел — 403', async () => {
    svc.loadSalaryDepartment.mockResolvedValue(DEPARTMENT);
    expect((await ktuAs('2026-11')).statusCode).toBe(403);
  });

  it('своя строка — 403', async () => {
    svc.canEditBrigadeInputEmployee.mockResolvedValue(false);
    expect((await ktuAs('2026-11')).statusCode).toBe(403);
    expect((await shareAs('2026-11')).statusCode).toBe(403);
  });
});
