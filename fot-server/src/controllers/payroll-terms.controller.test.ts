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
  resolveAccessibleDepartmentIds: vi.fn(async (): Promise<string[] | 'all'> => 'all'),
  resolveEditableEmployeeIds: vi.fn(async (): Promise<Set<number> | 'all'> => 'all'),
}));

vi.mock('../services/data-scope.service.js', () => scope);

const contractor = vi.hoisted(() => ({
  getContractorRootId: vi.fn(async (): Promise<string | null> => 'contractor-root'),
}));

vi.mock('../config/contractor.js', () => contractor);

const audit = vi.hoisted(() => ({
  logFromRequest: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('../services/audit.service.js', () => ({
  auditService: audit,
}));

// Категория по отделу: структура и отделы сотрудников — отдельными запросами, здесь подменяются.
const staffCategory = vi.hoisted(() => ({
  loadStaffCategoryResolver: vi.fn(async () => (departmentId: string | null) => (departmentId === 'br-1' ? 'worker' : 'office')),
  resolveEmployeeStaffCategories: vi.fn(async (ids: number[], _exec?: unknown) => new Map(ids.map(id => [id, 'office']))),
}));

vi.mock('../services/payroll/payroll-staff-category.js', () => staffCategory);

// Список доступа к «Зарплате» (миграция 310): здесь пользователь не из списка — охват решает скоуп.
vi.mock('../services/payroll/payroll-access.service.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/payroll/payroll-access.service.js')>(),
  getRequestPayrollSectionAccess: vi.fn(async () => false),
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
  scope.resolveEditableEmployeeIds.mockResolvedValue('all');
  txClient.query.mockResolvedValue({ rows: [{ id: 77 }] });
});

/**
 * Назначение в транзакции: блокировка сотрудника, прежние условия, UPDATE, DELETE, INSERT,
 * затем (если доплату передали) запись доплаты.
 */
const SINGLE_INSERT = 4;

/** Параметры INSERT условий: $14 — премиальная часть, $15 — компенсация проживания. */
const insertAmounts = (insertCallIndex: number) => {
  const params = txClient.query.mock.calls[insertCallIndex][1] as unknown[];
  return { bonus: params[13], housing: params[14] };
};

describe('условия оплаты: премиальная часть; проживание — не из окна (миграция 320)', () => {
  const baseBody = {
    staff_category: 'itr', calc_type: 'salary', monthly_salary: 150000, effective_from: '2026-09-01',
  };

  it('премиальная часть сохраняется; присланное проживание не пишется и в аудит не попадает', async () => {
    const res = makeRes();

    await payrollTermsController.assign(makeReq({
      params: { empId: '42' },
      body: { ...baseBody, bonus_amount: '50000', housing_compensation: 25000 },
    } as Partial<AuthenticatedRequest>), res);

    expect(res.statusCode).toBe(200);
    expect(insertAmounts(SINGLE_INSERT)).toEqual({ bonus: 50000, housing: null });
    const details = (audit.logFromRequest.mock.calls[0][3] as { details: Record<string, unknown> }).details;
    expect(details).toMatchObject({ bonus_amount: 50000 });
    expect(details).not.toHaveProperty('housing_compensation');
  });

  it('проживание в теле — без проверки доплаты за общежитие (её делают квартиры «Проживания»)', async () => {
    const res = makeRes();
    await payrollTermsController.assign(makeReq({
      params: { empId: '42' },
      body: { ...baseBody, housing_compensation: 630 },
    } as Partial<AuthenticatedRequest>), res);

    expect(res.statusCode).toBe(200);
    expect(txClient.query.mock.calls.some(call => /payroll_dormitory_allowances/.test(String(call[0])))).toBe(false);
  });

  it('0 премиальной части принимается как явное значение', async () => {
    const res = makeRes();

    await payrollTermsController.assign(makeReq({
      params: { empId: '42' },
      body: { ...baseBody, bonus_amount: 0, housing_compensation: 0 },
    } as Partial<AuthenticatedRequest>), res);

    expect(res.statusCode).toBe(200);
    expect(insertAmounts(SINGLE_INSERT)).toEqual({ bonus: 0, housing: null });
  });

  it('отрицательная сумма отклоняется до записи', async () => {
    const res = makeRes();

    await payrollTermsController.assign(makeReq({
      params: { empId: '42' },
      body: { ...baseBody, housing_compensation: -1 },
    } as Partial<AuthenticatedRequest>), res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/отрицательн/i);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('без сумм в теле — NULL: ранее заполненные значения очищаются новой строкой условий', async () => {
    const res = makeRes();

    await payrollTermsController.assign(makeReq({
      params: { empId: '42' }, body: baseBody,
    } as Partial<AuthenticatedRequest>), res);

    expect(res.statusCode).toBe(200);
    expect(insertAmounts(SINGLE_INSERT)).toEqual({ bonus: null, housing: null });
    const details = (audit.logFromRequest.mock.calls[0][3] as { details: Record<string, unknown> }).details;
    expect(details).toMatchObject({ bonus_amount: null });
  });
});

/** $16–$18 INSERT: проезд, связь, удержание. */
const insertCompensations = (insertCallIndex: number) => {
  const params = txClient.query.mock.calls[insertCallIndex][1] as unknown[];
  return { travel: params[15], communication: params[16], deduction: params[17] };
};

describe('условия оплаты: проезд, связь; удержание — не из условий (миграция 321)', () => {
  const baseBody = {
    staff_category: 'worker', calc_type: 'hourly', hourly_rate: 450, effective_from: '2026-09-24',
  };

  it('одиночное назначение сохраняет проезд и связь; удержание 0 от прежнего клиента — принято, не пишется', async () => {
    const res = makeRes();

    await payrollTermsController.assign(makeReq({
      params: { empId: '42' },
      body: { ...baseBody, travel_compensation: '3000', communication_compensation: 500, deduction_amount: 0 },
    } as Partial<AuthenticatedRequest>), res);

    expect(res.statusCode).toBe(200);
    expect(insertCompensations(SINGLE_INSERT)).toEqual({ travel: 3000, communication: 500, deduction: null });
    // Премия и проживание остаются на своих местах ($14/$15).
    expect(insertAmounts(SINGLE_INSERT)).toEqual({ bonus: null, housing: null });
    const details = (audit.logFromRequest.mock.calls[0][3] as { details: Record<string, unknown> }).details;
    expect(details).toMatchObject({ travel_compensation: 3000, communication_compensation: 500 });
    expect(details).not.toHaveProperty('deduction_amount');
  });

  it('удержание больше нуля от прежнего клиента — 409 «обновите страницу», ничего не пишется', async () => {
    const res = makeRes();

    await payrollTermsController.assign(makeReq({
      params: { empId: '42' },
      body: { ...baseBody, deduction_amount: 1500 },
    } as Partial<AuthenticatedRequest>), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('DEDUCTION_MOVED');
    expect(pgTx).not.toHaveBeenCalled();
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });

  it('без сумм — NULL', async () => {
    const res = makeRes();

    await payrollTermsController.assign(makeReq({
      params: { empId: '42' }, body: baseBody,
    } as Partial<AuthenticatedRequest>), res);

    expect(res.statusCode).toBe(200);
    expect(insertCompensations(SINGLE_INSERT)).toEqual({ travel: null, communication: null, deduction: null });
  });

  it('отрицательное удержание отклоняется до записи', async () => {
    const res = makeRes();

    await payrollTermsController.assign(makeReq({
      params: { empId: '42' },
      body: { ...baseBody, deduction_amount: -100 },
    } as Partial<AuthenticatedRequest>), res);

    expect(res.statusCode).toBe(400);
    expect(pgTx).not.toHaveBeenCalled();
  });
});

describe('payrollTermsController.getSalaryHistory', () => {
  it('сотрудник вне скоупа — 403, в БД не ходим', async () => {
    scope.canAccessEmployeeInScope.mockResolvedValueOnce(false);
    const res = makeRes();

    await payrollTermsController.getSalaryHistory(makeReq({ params: { empId: '42' } } as Partial<AuthenticatedRequest>), res);

    expect(res.statusCode).toBe(403);
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('отдаёт изменения оклада из SQL как есть', async () => {
    const change = {
      effective_from: '2026-06-01', effective_to: null, calc_type: 'salary', amount: '120000.00',
      prev_calc_type: 'salary', prev_amount: '100000.00', diff: '20000.00', diff_percent: '20.0',
      changed_by_name: 'Иванов И.И.', changed_at: '2026-05-30T10:00:00Z',
    };
    pgQuery.mockResolvedValueOnce([change]);
    const res = makeRes();

    await payrollTermsController.getSalaryHistory(makeReq({ params: { empId: '42' } } as Partial<AuthenticatedRequest>), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual([change]);
    expect(pgQuery.mock.calls[0][1]).toEqual([42]);
  });
});

describe('payrollTermsController.assign', () => {
  it('переводит сотрудника с оклада на часы: закрывает прежние условия и вставляет новые', async () => {

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
    // Порядок важен: блокировка сотрудника, прежние условия, затем закрыть действующие,
    // снять более поздние и вставить новые.
    expect(statements[0]).toMatch(/pg_advisory_xact_lock/i);
    expect(statements[1]).toMatch(/FROM payroll_compensation_terms/i);
    expect(statements[2]).toMatch(/UPDATE payroll_compensation_terms/i);
    expect(statements[2]).toMatch(/effective_to/i);
    expect(statements[3]).toMatch(/DELETE FROM payroll_compensation_terms/i);
    expect(statements[4]).toMatch(/INSERT INTO payroll_compensation_terms/i);
    // Доплату не передали — её не трогаем.
    expect(statements.some(sql => /payroll_planned_supplements/.test(sql))).toBe(false);

    // Часовая ставка легла в hourly_rate, оклад остался пустым — иначе сработал бы XOR в БД.
    const insertParams = txClient.query.mock.calls[SINGLE_INSERT][1] as unknown[];
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

    const insertParams = txClient.query.mock.calls[SINGLE_INSERT][1] as unknown[];
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

describe('payrollTermsController.assign: плановая доплата', () => {
  const baseBody = {
    staff_category: 'itr', calc_type: 'salary', monthly_salary: 150000, effective_from: '2026-10-01',
  };
  const supplementCall = () => txClient.query.mock.calls.find(call => /payroll_planned_supplements/.test(String(call[0])));

  it('доплата пишется в той же транзакции после условий и попадает в аудит', async () => {
    txClient.query.mockResolvedValue({ rows: [{ id: 77 }], rowCount: 1 });
    const res = makeRes();

    await payrollTermsController.assign(makeReq({
      params: { empId: '42' },
      body: { ...baseBody, planned_supplement: { amount: '10000', date_from: '2026-11-01', date_to: '2026-12-31' } },
    } as Partial<AuthenticatedRequest>), res);

    expect(res.statusCode).toBe(200);
    expect(pgTx).toHaveBeenCalledTimes(1);
    const statements = txClient.query.mock.calls.map(call => String(call[0]));
    expect(statements[0]).toMatch(/pg_advisory_xact_lock/i);
    expect(txClient.query.mock.calls[0][1]).toEqual([42]);
    expect(statements[SINGLE_INSERT]).toMatch(/INSERT INTO payroll_compensation_terms/i);
    expect(statements[SINGLE_INSERT + 1]).toMatch(/INSERT INTO payroll_planned_supplements/i);
    expect(supplementCall()?.[1]).toEqual([42, 10000, '2026-11-01', '2026-12-31', 'user-1']);
    const details = (audit.logFromRequest.mock.calls[0][3] as { details: Record<string, unknown> }).details;
    expect(details).toMatchObject({
      planned_supplement: { amount: 10000, date_from: '2026-11-01', date_to: '2026-12-31' },
      planned_supplement_changed: true,
    });
  });

  it('доплата без даты окончания — бессрочная версия', async () => {
    txClient.query.mockResolvedValue({ rows: [{ id: 77 }], rowCount: 1 });
    const res = makeRes();

    await payrollTermsController.assign(makeReq({
      params: { empId: '42' },
      body: { ...baseBody, planned_supplement: { amount: 10000, date_from: '2026-11-01', date_to: null } },
    } as Partial<AuthenticatedRequest>), res);

    expect(res.statusCode).toBe(200);
    expect(supplementCall()?.[1]).toEqual([42, 10000, '2026-11-01', null, 'user-1']);
  });

  it('null снимает доплату: версия с пустыми суммой и датами', async () => {
    const res = makeRes();

    await payrollTermsController.assign(makeReq({
      params: { empId: '42' }, body: { ...baseBody, planned_supplement: null },
    } as Partial<AuthenticatedRequest>), res);

    expect(res.statusCode).toBe(200);
    expect(supplementCall()?.[1]).toEqual([42, null, null, null, 'user-1']);
    const details = (audit.logFromRequest.mock.calls[0][3] as { details: Record<string, unknown> }).details;
    expect(details).toMatchObject({ planned_supplement: null });
  });

  it('доплата не изменилась (версия не вставлена) — в аудите planned_supplement_changed: false', async () => {
    txClient.query.mockImplementation(async (sql: string) => (
      /payroll_planned_supplements/.test(String(sql)) ? { rows: [], rowCount: 0 } : { rows: [{ id: 77 }], rowCount: 1 }
    ));
    const res = makeRes();

    await payrollTermsController.assign(makeReq({
      params: { empId: '42' },
      body: { ...baseBody, planned_supplement: { amount: 10000, date_from: '2026-11-01', date_to: '2026-12-31' } },
    } as Partial<AuthenticatedRequest>), res);

    expect(res.statusCode).toBe(200);
    const details = (audit.logFromRequest.mock.calls[0][3] as { details: Record<string, unknown> }).details;
    expect(details).toMatchObject({ planned_supplement_changed: false });
  });

  it.each([
    ['несуществующая дата', { amount: 10000, date_from: '2026-02-31', date_to: '2026-03-31' }],
    ['окончание раньше начала', { amount: 10000, date_from: '2026-12-01', date_to: '2026-11-30' }],
    ['сумма больше NUMERIC(12,2)', { amount: 10_000_000_000, date_from: '2026-11-01', date_to: '2026-12-31' }],
    ['нулевая сумма', { amount: 0, date_from: '2026-11-01', date_to: '2026-12-31' }],
    ['нет даты начала', { amount: 10000, date_to: '2026-12-31' }],
  ])('%s — 400 до похода в БД', async (_name, plannedSupplement) => {
    const res = makeRes();

    await payrollTermsController.assign(makeReq({
      params: { empId: '42' }, body: { ...baseBody, planned_supplement: plannedSupplement },
    } as Partial<AuthenticatedRequest>), res);

    expect(res.statusCode).toBe(400);
    expect(pgTx).not.toHaveBeenCalled();
  });
});

describe('payrollTermsController.assign: точность сумм', () => {
  const assign = async (body: Record<string, unknown>) => {
    const res = makeRes();
    await payrollTermsController.assign(makeReq({
      params: { empId: '42' },
      body: { staff_category: 'itr', effective_from: '2026-10-01', ...body },
    } as Partial<AuthenticatedRequest>), res);
    return res;
  };

  it('оклад и премия с копейками сохраняются как есть', async () => {
    const res = await assign({ calc_type: 'salary', monthly_salary: 175000.55, bonus_amount: 0.29 });

    expect(res.statusCode).toBe(200);
    const insertParams = txClient.query.mock.calls[SINGLE_INSERT][1] as unknown[];
    expect(insertParams[4]).toBe(175000.55);
    expect(insertAmounts(SINGLE_INSERT).bonus).toBe(0.29);
  });

  it('третий знак у оклада, премии, проезда или доплаты — 400 до записи, а не молчаливое округление БД', async () => {
    for (const body of [
      { calc_type: 'salary', monthly_salary: 100.005 },
      { calc_type: 'salary', monthly_salary: 150000, bonus_amount: 0.001 },
      { calc_type: 'salary', monthly_salary: 150000, travel_compensation: '2500.555' },
      { calc_type: 'salary', monthly_salary: 150000, planned_supplement: { amount: 10000.001, date_from: '2026-11-01', date_to: null } },
    ]) {
      const res = await assign(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.body.error, JSON.stringify(body)).toBe('Не больше двух знаков после запятой');
    }
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('часовая ставка — до 4 знаков после запятой, пятый — 400', async () => {
    const ok = await assign({ calc_type: 'hourly', hourly_rate: 450.125 });
    expect(ok.statusCode).toBe(200);
    expect((txClient.query.mock.calls[SINGLE_INSERT][1] as unknown[])[5]).toBe(450.125);

    vi.clearAllMocks();
    const res = await assign({ calc_type: 'hourly', hourly_rate: 450.12345 });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Не больше четырёх знаков после запятой');
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('сверх верха столбца или бесконечность — 400, а не переполнение NUMERIC и 500', async () => {
    for (const body of [
      { calc_type: 'salary', monthly_salary: 1e11 },
      { calc_type: 'salary', monthly_salary: '1e400' },
      { calc_type: 'salary', monthly_salary: 150000, bonus_amount: 1e11 },
      { calc_type: 'hourly', hourly_rate: 1e9 },
    ]) {
      const res = await assign(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(pgTx).not.toHaveBeenCalled();
  });
});

describe('payrollTermsController.getChanges', () => {
  it('сотрудник вне скоупа — 403, в БД не ходим', async () => {
    scope.canAccessEmployeeInScope.mockResolvedValueOnce(false);
    const res = makeRes();

    await payrollTermsController.getChanges(makeReq({ params: { empId: '42' } } as Partial<AuthenticatedRequest>), res);

    expect(res.statusCode).toBe(403);
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('оклад и доплата одним журналом по времени изменения, новые сверху', async () => {
    const salary = {
      effective_from: '2026-06-01', effective_to: null, calc_type: 'salary', amount: '120000.00',
      prev_calc_type: null, prev_amount: null, diff: null, diff_percent: null,
      changed_by_name: 'Иванов И.И.', changed_at: '2026-05-30T10:00:00Z',
    };
    const supplementNew = {
      id: 2, action: 'changed', amount: '12000.00', date_from: '2026-11-01', date_to: '2026-12-31',
      prev_amount: '10000.00', prev_date_from: '2026-11-01', prev_date_to: '2026-12-31',
      changed_by_name: 'Петров П.П.', changed_at: '2026-10-02T09:00:00Z',
    };
    const supplementOld = {
      id: 1, action: 'assigned', amount: '10000.00', date_from: '2026-11-01', date_to: '2026-12-31',
      prev_amount: null, prev_date_from: null, prev_date_to: null,
      changed_by_name: 'Петров П.П.', changed_at: '2026-04-01T09:00:00Z',
    };
    pgQuery.mockImplementation(async (sql: string) => (
      /payroll_planned_supplements/.test(String(sql)) ? [supplementNew, supplementOld] : [salary]
    ));
    const res = makeRes();

    await payrollTermsController.getChanges(makeReq({ params: { empId: '42' } } as Partial<AuthenticatedRequest>), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual([
      { ...supplementNew, kind: 'supplement' },
      { ...salary, kind: 'salary' },
      { ...supplementOld, kind: 'supplement' },
    ]);
    pgQuery.mockReset();
  });
});

describe('условия оплаты: категория — выбранная или по отделу', () => {
  const body = { calc_type: 'salary', monthly_salary: 150000, effective_from: '2026-10-01' };

  it('одиночное: категория, выбранная в окне, сохраняется и пишется в аудит; отдел не спрашиваем', async () => {
    const res = makeRes();

    await payrollTermsController.assign(makeReq({
      params: { empId: '42' }, body: { ...body, staff_category: 'itr' },
    } as Partial<AuthenticatedRequest>), res);

    expect(res.statusCode).toBe(200);
    expect(staffCategory.resolveEmployeeStaffCategories).not.toHaveBeenCalled();
    expect((txClient.query.mock.calls[SINGLE_INSERT][1] as unknown[])[2]).toBe('itr');
    const details = (audit.logFromRequest.mock.calls[0][3] as { details: Record<string, unknown> }).details;
    expect(details.staff_category).toBe('itr');
  });

  it('одиночное: категорию не прислали — по отделу сотрудника в транзакции', async () => {
    staffCategory.resolveEmployeeStaffCategories.mockResolvedValueOnce(new Map([[42, 'worker']]));
    const res = makeRes();

    await payrollTermsController.assign(makeReq({ params: { empId: '42' }, body } as Partial<AuthenticatedRequest>), res);

    expect(res.statusCode).toBe(200);
    expect(staffCategory.resolveEmployeeStaffCategories).toHaveBeenCalledWith([42], txClient);
    expect((txClient.query.mock.calls[SINGLE_INSERT][1] as unknown[])[2]).toBe('worker');
  });

  it('одиночное: отдел без категории — офис', async () => {
    const res = makeRes();

    await payrollTermsController.assign(makeReq({ params: { empId: '42' }, body } as Partial<AuthenticatedRequest>), res);

    expect(res.statusCode).toBe(200);
    expect((txClient.query.mock.calls[SINGLE_INSERT][1] as unknown[])[2]).toBe('office');
  });

  it('список: категория по текущему отделу строки', async () => {
    pgQueryOne.mockResolvedValueOnce({
      total: '2',
      without_terms_total: '2',
      rows: [
        { employee_id: 1, full_name: 'А', department_id: 'br-1', staff_category: null },
        { employee_id: 2, full_name: 'Б', department_id: null, staff_category: null },
      ],
    });
    const res = makeRes();

    await payrollTermsController.list(makeReq({ query: {} } as Partial<AuthenticatedRequest>), res);

    expect(res.body.data.map((row: { department_category: string }) => row.department_category)).toEqual(['worker', 'office']);
  });
});

describe('payrollTermsController.list', () => {
  /** Параметры запроса списка по позициям в LIST_SQL. */
  const listParams = () => {
    const params = pgQueryOne.mock.calls[0][1] as unknown[];
    return {
      sql: String(pgQueryOne.mock.calls[0][0]),
      date: params[0],
      department: params[1],
      contractorRoot: params[5],
      departments: params[6],
      search: params[7],
      limit: params[8],
      offset: params[9],
      afterName: params[10],
      afterId: params[11],
    };
  };

  beforeEach(() => {
    scope.resolveAccessibleDepartmentIds.mockResolvedValue('all');
    contractor.getContractorRootId.mockResolvedValue('contractor-root');
    pgQueryOne.mockResolvedValue({ total: '1710', without_terms_total: '1708', rows: [] });
  });

  it('сотрудники без условий остаются в выдаче: молча пропасть из расчёта они не должны', async () => {
    pgQueryOne.mockResolvedValueOnce({
      total: '2',
      without_terms_total: '1',
      rows: [
        { employee_id: 1, full_name: 'А', terms_id: 9, calc_type: 'salary' },
        { employee_id: 2, full_name: 'Б', terms_id: null, calc_type: null },
      ],
    });

    const res = makeRes();
    await payrollTermsController.list(makeReq({ query: { date: '2026-08-01' } } as Partial<AuthenticatedRequest>), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.date).toBe('2026-08-01');
    // LEFT JOIN, а не INNER: иначе сотрудники без условий исчезли бы с экрана.
    expect(listParams().sql).toMatch(/LEFT JOIN payroll_compensation_terms/i);
  });

  it('подрядчики исключаются поддеревом их корня, а не по названию отдела', async () => {
    const res = makeRes();
    await payrollTermsController.list(makeReq({ query: {} } as Partial<AuthenticatedRequest>), res);

    const { sql, contractorRoot } = listParams();
    expect(contractorRoot).toBe('contractor-root');
    expect(sql).toMatch(/get_descendant_department_ids\(ARRAY\[\$6::uuid\]\)/);
    // NOT EXISTS, а не NOT IN: сотрудник без отдела не должен молча пропасть.
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM contractor_depts/);
    expect(res.body.meta.contractors_excluded).toBe(true);
  });

  it('корень подрядчиков не найден — фильтра нет, и экран об этом узнаёт', async () => {
    contractor.getContractorRootId.mockResolvedValue(null);
    const res = makeRes();

    await payrollTermsController.list(makeReq({ query: {} } as Partial<AuthenticatedRequest>), res);

    expect(listParams().contractorRoot).toBeNull();
    expect(res.body.meta.contractors_excluded).toBe(false);
  });

  it('итоги берутся из запроса подсчёта по всей выборке, а не из длины страницы', async () => {
    pgQueryOne.mockResolvedValueOnce({
      total: '1710',
      without_terms_total: '1708',
      rows: [{ employee_id: 1 }, { employee_id: 2 }],
    });
    const res = makeRes();

    await payrollTermsController.list(makeReq({ query: {} } as Partial<AuthenticatedRequest>), res);

    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.total).toBe(1710);
    expect(res.body.meta.without_terms_total).toBe(1708);
  });

  it('пагинация: страница 3 по 50 строк → LIMIT 50 OFFSET 100', async () => {
    const res = makeRes();
    await payrollTermsController.list(
      makeReq({ query: { page: '3', page_size: '50' } } as Partial<AuthenticatedRequest>),
      res,
    );

    const { limit, offset } = listParams();
    expect(limit).toBe(50);
    expect(offset).toBe(100);
    expect(res.body.meta).toMatchObject({ page: 3, page_size: 50 });
  });

  it('по умолчанию 100 строк; больше 500 на страницу — отказ до похода в БД', async () => {
    const resDefault = makeRes();
    await payrollTermsController.list(makeReq({ query: {} } as Partial<AuthenticatedRequest>), resDefault);
    expect(listParams().limit).toBe(100);

    pgQueryOne.mockClear();
    const resTooBig = makeRes();
    await payrollTermsController.list(
      makeReq({ query: { page_size: '501' } } as Partial<AuthenticatedRequest>),
      resTooBig,
    );
    expect(resTooBig.statusCode).toBe(400);
    expect(pgQueryOne).not.toHaveBeenCalled();
  });

  it('поиск: табельный — прежним ILIKE в $8 (спецсимволы экранированы), ФИО — точным поиском ФИО', async () => {
    const res = makeRes();
    await payrollTermsController.list(
      makeReq({ query: { q: '  гри  ' } } as Partial<AuthenticatedRequest>),
      res,
    );
    // Меньше 5 букв — опечаток нет, проверки «есть ли точные» тоже.
    expect(pgQueryOne).toHaveBeenCalledTimes(1);
    expect(listParams().search).toBe('%гри%');
    expect(listParams().sql).toMatch(/\$8::text IS NULL OR \(e\.full_name ~\* \$\d+\) OR e\.tab_number ILIKE \$8::text/);

    pgQueryOne.mockClear();
    await payrollTermsController.list(
      makeReq({ query: { q: '50%_\\' } } as Partial<AuthenticatedRequest>),
      makeRes(),
    );
    expect(listParams().search).toBe('%50\\%\\_\\\\%');
  });

  it('поиск ФИО: точное есть в отфильтрованном наборе — только точные; нет — с одной ошибкой, итоги — тем же режимом', async () => {
    const listCall = () => pgQueryOne.mock.calls.find(([sql]) => String(sql).includes('keyed AS'));
    const existsCall = () => pgQueryOne.mock.calls.find(([sql]) => String(sql).includes('SELECT EXISTS'));
    const cf = JSON.stringify({ values: { schedule: ['5+2'] } });

    pgQueryOne.mockImplementation(async (sql: string) => (String(sql).includes('SELECT EXISTS')
      ? { found: true } : { total: '0', without_terms_total: '0', rows: [] }));
    await payrollTermsController.list(makeReq({ query: { q: 'гринев', cf, without_terms: 'true' } } as Partial<AuthenticatedRequest>), makeRes());
    // Проверка — по всему filtered: фильтры столбцов и «без условий» в ней есть, курсора и LIMIT — нет.
    const [checkSql, checkParams] = existsCall() as [string, unknown[]];
    expect(checkSql).toContain('NULLIF(btrim(schedule_name), \'\') = ANY($9::text[])');
    expect(checkSql).toContain('(e.full_name ~* $10)');
    expect(checkSql).not.toMatch(/OFFSET|LIMIT \$/);
    expect(checkParams.slice(8)).toEqual([['5+2'], 'грин[её]в']);
    expect(String(listCall()?.[0])).not.toContain('unnest(');

    pgQueryOne.mockClear();
    pgQueryOne.mockImplementation(async (sql: string) => (String(sql).includes('SELECT EXISTS')
      ? { found: false } : { total: '0', without_terms_total: '0', rows: [] }));
    await payrollTermsController.list(makeReq({ query: { q: 'гринев', cf } } as Partial<AuthenticatedRequest>), makeRes());
    const [sql, params] = listCall() as [string, unknown[]];
    expect(sql).toContain('e.id IN (SELECT fz.id FROM unnest(');
    // Режим один на порцию и итоги: условие ФИО — в scoped, итоги считаются из него же.
    expect(sql.indexOf('unnest(')).toBeLessThan(sql.indexOf('filtered AS ('));
    expectPlaceholdersMatch(sql, params);
  });

  it('скоуп: у бухгалтера подразделения список сужен до его отделов, у admin — без фильтра', async () => {
    scope.resolveAccessibleDepartmentIds.mockResolvedValue(['dept-a', 'dept-b']);
    await payrollTermsController.list(makeReq({ query: {} } as Partial<AuthenticatedRequest>), makeRes());
    expect(listParams().departments).toEqual(['dept-a', 'dept-b']);
    expect(listParams().sql).toMatch(/e\.org_department_id = ANY\(\$7::uuid\[\]\)/);

    pgQueryOne.mockClear();
    scope.resolveAccessibleDepartmentIds.mockResolvedValue('all');
    await payrollTermsController.list(makeReq({ query: {} } as Partial<AuthenticatedRequest>), makeRes());
    expect(listParams().departments).toBeNull();
  });

  it('подразделение фильтрует всё поддерево: департамент показывает все свои бригады', async () => {
    const departmentId = '11111111-1111-1111-1111-111111111111';
    await payrollTermsController.list(
      makeReq({ query: { department_id: departmentId } } as Partial<AuthenticatedRequest>),
      makeRes(),
    );

    const { sql, department } = listParams();
    expect(department).toBe(departmentId);
    expect(sql).toMatch(/filter_depts AS \(\s*SELECT id FROM public\.get_descendant_department_ids\(ARRAY\[\$2::uuid\]\)/);
    expect(sql).toMatch(/e\.org_department_id IN \(SELECT id FROM filter_depts\)/);
    // Прежнее точное совпадение отдела отсекало бы бригады внутри департамента.
    expect(sql).not.toMatch(/e\.org_department_id = \$2::uuid/);
  });

  it('meta: сколько уже с условиями и id корня подрядчиков для дерева подразделений', async () => {
    pgQueryOne.mockResolvedValueOnce({ total: '0', without_terms_total: '32', with_terms_total: '0', rows: [] });
    const res = makeRes();

    await payrollTermsController.list(
      makeReq({ query: { staff_category: 'office' } } as Partial<AuthenticatedRequest>),
      res,
    );

    expect(res.body.meta).toMatchObject({
      total: 0,
      without_terms_total: 32,
      with_terms_total: 0,
      contractor_root_id: 'contractor-root',
    });
    expect(listParams().sql).toMatch(/count\(\*\) FROM scoped WHERE terms_id IS NOT NULL\) AS with_terms_total/);
  });

  it('должность из positions, график считается в SQL на дату выборки; служебные поля ключа наружу не уходят', async () => {
    pgQueryOne.mockResolvedValueOnce({
      total: '1710',
      without_terms_total: '0',
      rows: [
        { employee_id: 1, full_name: 'А', position_name: 'Прораб', schedule_name: '5/2 8ч', sort_key: 'А', sort_key_text: 'А' },
        { employee_id: 2, full_name: 'Б', position_name: null, schedule_name: null, sort_key: 'Б', sort_key_text: 'Б' },
      ],
    });
    const res = makeRes();

    await payrollTermsController.list(makeReq({ query: { date: '2026-09-15' } } as Partial<AuthenticatedRequest>), res);

    const { sql, date } = listParams();
    expect(date).toBe('2026-09-15');
    expect(sql).toMatch(/LEFT JOIN positions p ON p\.id = e\.position_id/);
    // Как у «Текущих сотрудников»: последнее действующее назначение на дату, иначе график по умолчанию.
    expect(sql).toMatch(/FROM employee_schedule_assignments a\s+WHERE a\.employee_id = e\.id\s+AND a\.effective_from <= \$1::date/);
    expect(sql).toMatch(/ORDER BY a\.effective_from DESC, a\.id DESC/);
    expect(sql).toMatch(/WHERE w\.is_default/);
    expect(res.body.data).toEqual([
      { employee_id: 1, full_name: 'А', position_name: 'Прораб', schedule_name: '5/2 8ч', department_category: 'office', can_edit: true },
      { employee_id: 2, full_name: 'Б', position_name: null, schedule_name: null, department_category: 'office', can_edit: true },
    ]);
  });

  it('can_edit — скоуп правки конкретного сотрудника: ограниченный скоуп правит только своих', async () => {
    scope.resolveEditableEmployeeIds.mockResolvedValue(new Set([1]));
    pgQueryOne.mockResolvedValueOnce({
      total: '2',
      without_terms_total: '0',
      rows: [
        { employee_id: 1, full_name: 'А', sort_key: 'А', sort_key_text: 'А' },
        { employee_id: 2, full_name: 'Б', sort_key: 'Б', sort_key_text: 'Б' },
      ],
    });
    const res = makeRes();

    await payrollTermsController.list(makeReq({ query: {} } as Partial<AuthenticatedRequest>), res);

    expect(res.body.data.map((row: { can_edit: boolean }) => row.can_edit)).toEqual([true, false]);
  });

  it('список отдаёт компенсации проезда и связи для предзаполнения карточки; удержания условий — нет', async () => {
    const res = makeRes();
    await payrollTermsController.list(makeReq({ query: {} } as Partial<AuthenticatedRequest>), res);

    expect(listParams().sql).toMatch(/t\.travel_compensation/);
    expect(listParams().sql).toMatch(/t\.communication_compensation/);
    expect(listParams().sql).not.toMatch(/deduction_amount/);
  });

  it('список отдаёт последнюю плановую доплату — только для строк порции, после LIMIT', async () => {
    const res = makeRes();
    await payrollTermsController.list(makeReq({ query: {} } as Partial<AuthenticatedRequest>), res);

    const { sql } = listParams();
    // Сумма — NUMERIC строкой: json_agg отдал бы её числом JSON.
    expect(sql).toMatch(/ps\.amount::text AS planned_supplement_amount/);
    expect(sql).toMatch(/planned_supplement_from/);
    expect(sql).toMatch(/planned_supplement_to/);
    expect(sql.indexOf('LIMIT $9 OFFSET $10')).toBeLessThan(sql.indexOf('FROM payroll_planned_supplements'));
  });

  it('список отдаёт «Начисления» из «Оплачено»: только статьи начислений, окно до месяца даты, после LIMIT', async () => {
    const res = makeRes();
    await payrollTermsController.list(makeReq({ query: {} } as Partial<AuthenticatedRequest>), res);

    const { sql } = listParams();
    expect(sql).toMatch(/acc\.accruals/);
    // Суммы месяцев — NUMERIC строкой, копейки не проходят через число JSON.
    expect(sql).toContain("'amount', a.amount::text");
    expect(sql.indexOf('LIMIT $9 OFFSET $10')).toBeLessThan(sql.indexOf('FROM payroll_paid_amounts'));
    expect(sql).toMatch(/pa\.month <\s+date_trunc\('month', \$1::date\)::date/);
    expect(sql).toContain("pa.item_code IN ('contract', 'bonus', 'sick_leave', 'vacation', 'housing', 'travel', "
      + "'overtime', 'recalc_prev', 'severance', 'supplement', 'planned_supplement', 'loan')");
  });

  it('список: премиальная часть — из условий, проживание — квартира «Проживания» на дату выборки', async () => {
    const res = makeRes();
    await payrollTermsController.list(makeReq({ query: {} } as Partial<AuthenticatedRequest>), res);

    const { sql } = listParams();
    expect(sql).toMatch(/t\.bonus_amount/);
    expect(sql).not.toMatch(/t\.housing_compensation/);
    expect(sql).toMatch(/FROM employee_dormitory_stays s[\s\S]*s\.kind = 'apartment'[\s\S]*AS housing_compensation/);
  });

  describe('подгрузка по курсору (ФИО, id)', () => {
    it('курсор уходит в SQL, OFFSET при нём 0 — номер страницы не участвует', async () => {
      await payrollTermsController.list(
        makeReq({ query: { page: '4', page_size: '500', after_name: 'Абдуллаев Р.', after_id: '812' } } as Partial<AuthenticatedRequest>),
        makeRes(),
      );

      const { sql, limit, offset, afterName, afterId } = listParams();
      expect(afterName).toBe('Абдуллаев Р.');
      expect(afterId).toBe(812);
      expect(limit).toBe(500);
      expect(offset).toBe(0);
      // Ключ прежнего порядка — COALESCE(full_name, ''): сотрудник без ФИО не выпадает из сравнения кортежей.
      expect(sql).toMatch(/COALESCE\(full_name, ''\) AS sort_key/);
      expect(sql).toMatch(/\(k\.sort_key, k\.employee_id\) > \(\$11::text, \$12::int\)/);
      // Сортировка по тому же ключу, что и сравнение курсора, — иначе порции разъедутся.
      expect(sql).toMatch(/ORDER BY k\.sort_key, k\.employee_id/);
      // next_cursor берётся из последнего элемента массива — порядок нужен внутри агрегата.
      expect(sql).toMatch(/json_agg\(p ORDER BY p\.sort_key, p\.employee_id\)/);
    });

    it('без курсора — прежний режим страниц: курсор NULL, OFFSET по номеру страницы', async () => {
      await payrollTermsController.list(
        makeReq({ query: { page: '2', page_size: '50' } } as Partial<AuthenticatedRequest>),
        makeRes(),
      );

      const { offset, afterName, afterId } = listParams();
      expect(offset).toBe(50);
      expect(afterName).toBeNull();
      expect(afterId).toBeNull();
    });

    it('пустое ФИО в курсоре допустимо: сотрудник без ФИО не рвёт подгрузку', async () => {
      const res = makeRes();
      await payrollTermsController.list(
        makeReq({ query: { after_name: '', after_id: '5' } } as Partial<AuthenticatedRequest>),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(listParams().afterName).toBe('');
      expect(listParams().afterId).toBe(5);
    });

    it('полная порция отдаёт next_cursor последней строки, пустое ФИО — пустой строкой', async () => {
      pgQueryOne.mockResolvedValueOnce({
        total: '3',
        without_terms_total: '3',
        rows: [
          { employee_id: 1, full_name: 'Абаев' },
          { employee_id: 9, full_name: null },
        ],
      });
      const res = makeRes();

      await payrollTermsController.list(
        makeReq({ query: { page_size: '2' } } as Partial<AuthenticatedRequest>),
        res,
      );

      expect(res.body.meta.next_cursor).toEqual({ name: '', id: 9 });
    });

    it('неполная порция — последняя: next_cursor null', async () => {
      pgQueryOne.mockResolvedValueOnce({
        total: '1',
        without_terms_total: '1',
        rows: [{ employee_id: 1, full_name: 'Абаев' }],
      });
      const res = makeRes();

      await payrollTermsController.list(
        makeReq({ query: { page_size: '2' } } as Partial<AuthenticatedRequest>),
        res,
      );

      expect(res.body.meta.next_cursor).toBeNull();
    });

    it('итоги считаются без курсора: total одинаков для любой порции', async () => {
      pgQueryOne.mockResolvedValueOnce({ total: '1695', without_terms_total: '1695', rows: [] });
      const res = makeRes();

      await payrollTermsController.list(
        makeReq({ query: { after_name: 'Яковлев', after_id: '1' } } as Partial<AuthenticatedRequest>),
        res,
      );

      expect(res.body.meta.total).toBe(1695);
      expect(listParams().sql).toMatch(/\(SELECT count\(\*\) FROM filtered\)\s+AS total/);
    });

    it('половина курсора — 400 до похода в БД', async () => {
      const onlyId = makeRes();
      await payrollTermsController.list(
        makeReq({ query: { after_id: '5' } } as Partial<AuthenticatedRequest>),
        onlyId,
      );
      expect(onlyId.statusCode).toBe(400);

      const onlyName = makeRes();
      await payrollTermsController.list(
        makeReq({ query: { after_name: 'Абаев' } } as Partial<AuthenticatedRequest>),
        onlyName,
      );
      expect(onlyName.statusCode).toBe(400);

      const badId = makeRes();
      await payrollTermsController.list(
        makeReq({ query: { after_name: 'Абаев', after_id: '-1' } } as Partial<AuthenticatedRequest>),
        badId,
      );
      expect(badId.statusCode).toBe(400);
      expect(pgQueryOne).not.toHaveBeenCalled();
    });
  });

  it('некорректная дата отклоняется', async () => {
    const res = makeRes();
    await payrollTermsController.list(makeReq({ query: { date: '01.08.2026' } } as Partial<AuthenticatedRequest>), res);

    expect(res.statusCode).toBe(400);
    expect(pgQueryOne).not.toHaveBeenCalled();
  });
});

/** Каждый $n в SQL есть в params, и каждый параметр упомянут — иначе PostgreSQL отвергнет запрос. */
const expectPlaceholdersMatch = (sql: string, params: unknown[]) => {
  const used = new Set([...sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1])));
  expect(Math.max(0, ...used)).toBe(params.length);
  for (let i = 1; i <= params.length; i += 1) expect(used.has(i)).toBe(true);
};

describe('payrollTermsController.list: сортировка и фильтры столбцов', () => {
  const lastListCall = () => {
    const [sql, params] = pgQueryOne.mock.calls[0] as unknown as [string, unknown[]];
    return { sql, params };
  };

  beforeEach(() => {
    scope.resolveAccessibleDepartmentIds.mockResolvedValue('all');
    contractor.getContractorRootId.mockResolvedValue('contractor-root');
    pgQueryOne.mockResolvedValue({ total: '0', without_terms_total: '0', rows: [] });
  });

  it('сортировка по окладу: числовой ключ, NULL в конце, курсор приводится к numeric', async () => {
    await payrollTermsController.list(makeReq({
      query: { sort: 'salary', dir: 'desc', page_size: '500', after_null: '0', after_key: '175000.00', after_id: '42' },
    } as Partial<AuthenticatedRequest>), makeRes());

    const { sql, params } = lastListCall();
    expect(sql).toMatch(/COALESCE\(monthly_salary, hourly_rate\) AS sort_key/);
    expect(sql).toMatch(/k\.sort_key < \$14::numeric/);
    expect(sql).toMatch(/ORDER BY \(k\.sort_key IS NULL\) ASC, k\.sort_key DESC, k\.employee_id DESC/);
    expect(sql).toMatch(/json_agg\(p ORDER BY \(p\.sort_key IS NULL\) ASC, p\.sort_key DESC, p\.employee_id DESC\)/);
    // Курсор прежнего порядка при сортировке по столбцу всегда пуст.
    expect(params[10]).toBeNull();
    expect(params[11]).toBeNull();
    expect(params[12]).toBe(42);
    expect(params[13]).toBe('175000.00');
    expectPlaceholdersMatch(sql, params);
  });

  it('курсор на пустом ключе: дальше только строки с пустым ключом', async () => {
    await payrollTermsController.list(makeReq({
      query: { sort: 'department', dir: 'asc', after_null: '1', after_id: '7' },
    } as Partial<AuthenticatedRequest>), makeRes());

    const { sql, params } = lastListCall();
    expect(sql).toMatch(/\(k\.sort_key IS NULL AND k\.employee_id > \$13::int\)/);
    expectPlaceholdersMatch(sql, params);
  });

  it('next_cursor при сортировке — ключ текстом из SQL, пустой ключ — isNull', async () => {
    pgQueryOne.mockResolvedValueOnce({
      total: '5', without_terms_total: '5',
      rows: [
        { employee_id: 3, full_name: 'А', sort_key: 450.1, sort_key_text: '450.1000' },
        { employee_id: 9, full_name: 'Б', sort_key: 175000, sort_key_text: '175000.00' },
      ],
    });
    const full = makeRes();
    await payrollTermsController.list(makeReq({ query: { sort: 'salary', page_size: '2' } } as Partial<AuthenticatedRequest>), full);
    // Точность суммы не теряется: берём текст ключа, а не число из JSON.
    expect(full.body.meta.next_cursor).toEqual({ key: '175000.00', isNull: false, id: 9 });
    expect(full.body.data[1]).not.toHaveProperty('sort_key');
    expect(full.body.data[1]).not.toHaveProperty('sort_key_text');

    pgQueryOne.mockResolvedValueOnce({
      total: '5', without_terms_total: '5',
      rows: [{ employee_id: 4, full_name: 'В', sort_key: null, sort_key_text: null }],
    });
    const empty = makeRes();
    await payrollTermsController.list(makeReq({ query: { sort: 'bonus', page_size: '1' } } as Partial<AuthenticatedRequest>), empty);
    expect(empty.body.meta.next_cursor).toEqual({ key: null, isNull: true, id: 4 });
  });

  it('фильтры столбцов: значения, «(пусто)» и «содержит» — параметрами, итоги с фильтрами', async () => {
    const cf = JSON.stringify({
      values: { schedule: ['6+0 (10ч)', null], salary: ['мес:175000.00'], bonus: [null] },
      text: { name: '50%' },
    });
    await payrollTermsController.list(makeReq({ query: { sort: 'name', cf } } as Partial<AuthenticatedRequest>), makeRes());

    const { sql, params } = lastListCall();
    const filtered = sql.slice(sql.indexOf('filtered AS ('), sql.indexOf('keyed AS ('));
    expect(filtered).toMatch(/NULLIF\(btrim\(schedule_name\), ''\) = ANY\(\$13::text\[\]\) OR NULLIF\(btrim\(schedule_name\), ''\) IS NULL/);
    expect(filtered).toMatch(/'мес:' \|\| monthly_salary::text/);
    expect(filtered).toMatch(/\(bonus_amount::text IS NULL\)/);
    // «ФИО» — точный поиск ФИО регулярным выражением, % — буквально.
    expect(filtered).toMatch(/\(full_name ~\* \$15\)/);
    expect(params[12]).toEqual(['6+0 (10ч)']);
    expect(params[13]).toEqual(['мес:175000.00']);
    expect(params[14]).toBe('50%');
    // total считается по filtered — с фильтрами столбцов, без курсора.
    expect(sql).toMatch(/\(SELECT count\(\*\) FROM filtered\)\s+AS total/);
    expectPlaceholdersMatch(sql, params);
  });

  it('неверные sort, курсор или cf — 400 с кодом до похода в БД', async () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ sort: 'tab_number' }, 'INVALID_SORT'],
      [{ dir: 'desc' }, 'INVALID_SORT'],
      [{ sort: 'name', dir: 'up' }, 'INVALID_SORT'],
      [{ sort: 'salary', after_null: '0', after_key: '1e5; DROP', after_id: '1' }, 'INVALID_CURSOR'],
      [{ sort: 'name', after_name: 'А', after_id: '1' }, 'INVALID_CURSOR'],
      [{ sort: 'name', after_null: '1', after_key: 'А', after_id: '1' }, 'INVALID_CURSOR'],
      [{ sort: 'name', cf: '{bad json' }, 'INVALID_COLUMN_FILTERS'],
      [{ sort: 'name', cf: JSON.stringify({ values: { tab_number: ['1'] } }) }, 'INVALID_COLUMN_FILTERS'],
    ];
    for (const [query, code] of cases) {
      const res = makeRes();
      await payrollTermsController.list(makeReq({ query } as Partial<AuthenticatedRequest>), res);
      expect(res.statusCode, JSON.stringify(query)).toBe(400);
      expect(res.body.code, JSON.stringify(query)).toBe(code);
    }
    expect(pgQueryOne).not.toHaveBeenCalled();
  });

  it('без sort — прежний порядок: плейсхолдеры согласованы и с фильтрами столбцов', async () => {
    await payrollTermsController.list(makeReq({
      query: { cf: JSON.stringify({ values: { position: ['Монтажник'] } }) },
    } as Partial<AuthenticatedRequest>), makeRes());
    const { sql, params } = lastListCall();
    expectPlaceholdersMatch(sql, params);
  });
});

describe('payrollTermsController.columnValues', () => {
  beforeEach(() => {
    scope.resolveAccessibleDepartmentIds.mockResolvedValue(['dept-a']);
    contractor.getContractorRootId.mockResolvedValue('contractor-root');
    pgQuery.mockResolvedValue([]);
  });

  it('варианты считаются без фильтра самого столбца, с фильтрами остальных и в скоупе пользователя', async () => {
    const cf = JSON.stringify({ values: { schedule: ['6+0 (10ч)'], position: ['Монтажник'] } });
    await payrollTermsController.columnValues(makeReq({
      query: { column: 'schedule', cf, department_id: '11111111-1111-1111-1111-111111111111' },
    } as Partial<AuthenticatedRequest>), makeRes());

    const [sql, params] = pgQuery.mock.calls[0] as unknown as [string, unknown[]];
    const filtered = sql.slice(sql.indexOf('filtered AS ('));
    expect(filtered).not.toMatch(/schedule_name\), ''\) = ANY/);
    expect(filtered).toMatch(/NULLIF\(btrim\(position_name\), ''\) = ANY\(\$9::text\[\]\)/);
    expect(params[6]).toEqual(['dept-a']);
    expect(params[1]).toBe('11111111-1111-1111-1111-111111111111');
    expect(sql).toMatch(/GROUP BY v\.value/);
    expectPlaceholdersMatch(sql, params);
  });

  it('суммы упорядочены по числу, поиск по значениям экранируется', async () => {
    await payrollTermsController.columnValues(makeReq({
      query: { column: 'salary', value_q: '4_5' },
    } as Partial<AuthenticatedRequest>), makeRes());

    const [sql, params] = pgQuery.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/COALESCE\(monthly_salary, hourly_rate\) AS ord/);
    expect(sql).toMatch(/ORDER BY min\(v\.ord\) ASC NULLS LAST/);
    expect(params).toContain('%4\\_5%');
    expectPlaceholdersMatch(sql, params);
  });

  it('больше 300 вариантов — первые 300 и truncated', async () => {
    pgQuery.mockResolvedValueOnce(Array.from({ length: 301 }, (_, i) => ({ value: `v${i}`, count: 1 })));
    const res = makeRes();
    await payrollTermsController.columnValues(makeReq({ query: { column: 'position' } } as Partial<AuthenticatedRequest>), res);

    expect(res.body.data.values).toHaveLength(300);
    expect(res.body.data.truncated).toBe(true);
  });

  it('столбец без фильтра значений или неверный cf — 400 до похода в БД', async () => {
    for (const query of [{ column: 'name' }, { column: 'accruals' }, { column: 'position', cf: '[1]' }]) {
      const res = makeRes();
      await payrollTermsController.columnValues(makeReq({ query } as Partial<AuthenticatedRequest>), res);
      expect(res.statusCode, JSON.stringify(query)).toBe(400);
    }
    expect(pgQuery).not.toHaveBeenCalled();
  });
});

describe('payrollTermsController: фильтр «Удержания» убран', () => {
  beforeEach(() => {
    scope.resolveAccessibleDepartmentIds.mockResolvedValue('all');
    contractor.getContractorRootId.mockResolvedValue('contractor-root');
    pgQueryOne.mockResolvedValue({ total: '0', without_terms_total: '0', rows: [] });
    pgQuery.mockResolvedValue([]);
  });

  it('прежний клиент с deduction_kind_ids получает полный список — параметр не участвует в выборке', async () => {
    const res = makeRes();
    await payrollTermsController.list(makeReq({
      query: { deduction_kind_ids: '5,2' },
    } as Partial<AuthenticatedRequest>), res);

    expect(res.statusCode).toBe(200);
    const [sql, params] = pgQueryOne.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).not.toMatch(/payroll_employee_deductions/);
    expect(params).not.toContainEqual([5, 2]);
    expectPlaceholdersMatch(sql, params);
  });
});

describe('payrollTermsController.list: «К выплате» и «Удержания» (paid_months)', () => {
  const lastListCall = () => {
    const [sql, params] = pgQueryOne.mock.calls[0] as unknown as [string, unknown[]];
    return { sql, params };
  };

  beforeEach(() => {
    scope.resolveAccessibleDepartmentIds.mockResolvedValue('all');
    contractor.getContractorRootId.mockResolvedValue('contractor-root');
    pgQueryOne.mockResolvedValue({ total: '0', without_terms_total: '0', rows: [] });
  });

  it('без paid_months — прежний список: «Начисления» есть, сумм «Расчётов» нет', async () => {
    await payrollTermsController.list(makeReq({ query: {} } as Partial<AuthenticatedRequest>), makeRes());

    const { sql, params } = lastListCall();
    expect(sql).toMatch(/acc\.accruals/);
    expect(sql).not.toMatch(/paid_total|paid_deductions/);
    expect(params).toHaveLength(12);
    expectPlaceholdersMatch(sql, params);
  });

  it('список месяцев — первые числа последним параметром; «Начислений» нет, читается одна выборка «Оплачено»', async () => {
    await payrollTermsController.list(makeReq({
      query: { paid_months: '2026-08,2026-07,2026-08' },
    } as Partial<AuthenticatedRequest>), makeRes());

    const { sql, params } = lastListCall();
    expect(params).toHaveLength(13);
    expect(params[12]).toEqual(['2026-07-01', '2026-08-01']);
    expect(sql).toMatch(/pa\.month = ANY\(\$13::date\[\]\)/);
    expect(sql).not.toMatch(/accruals/);
    expect(sql.match(/FROM payroll_paid_amounts/g)).toHaveLength(1);
    // Итоги «Начислено» и «Удержано» — NUMERIC строкой; «К выплате» = начислено − удержано считает фронт в копейках.
    expect(sql).toMatch(/\(SUM\(pa\.amount\) FILTER \(WHERE pa\.item_code IN \('contract'.*'loan'\)\)\)::text AS paid_total/);
    expect(sql).toMatch(/\(SUM\(pa\.amount\) FILTER \(WHERE pa\.item_code IN \('meals'.*'writ_deduction'\)\)\)::text AS paid_deductions_total/);
    expectPlaceholdersMatch(sql, params);
  });

  it('all — весь период: параметр месяцев NULL', async () => {
    await payrollTermsController.list(makeReq({ query: { paid_months: 'all' } } as Partial<AuthenticatedRequest>), makeRes());

    const { sql, params } = lastListCall();
    expect(params[12]).toBeNull();
    expect(sql).toMatch(/\$13::date\[\] IS NULL OR/);
    expectPlaceholdersMatch(sql, params);
  });

  it('с фильтрами столбцов и курсором сортировки — параметр месяцев после них, номера сходятся', async () => {
    await payrollTermsController.list(makeReq({
      query: {
        sort: 'department',
        dir: 'asc',
        after_null: '0',
        after_key: 'Бухгалтерия',
        after_id: '7',
        cf: JSON.stringify({ values: { position: ['Монтажник'] }, text: { name: 'Абд' } }),
        paid_months: '2026-07',
      },
    } as Partial<AuthenticatedRequest>), makeRes());

    const { sql, params } = lastListCall();
    const monthsIndex = params.length;
    expect(params[monthsIndex - 1]).toEqual(['2026-07-01']);
    expect(sql).toMatch(new RegExp(`pa\\.month = ANY\\(\\$${monthsIndex}::date\\[\\]\\)`));
    // Курсор и фильтры — свои параметры перед месяцами.
    expect(params).toContain('Бухгалтерия');
    expect(params).toContainEqual(['Монтажник']);
    expectPlaceholdersMatch(sql, params);
  });

  it('неверный paid_months — 400 до похода в БД', async () => {
    for (const paidMonths of ['2026-13', '07.2026', '', 'all,2026-07']) {
      const res = makeRes();
      await payrollTermsController.list(makeReq({ query: { paid_months: paidMonths } } as Partial<AuthenticatedRequest>), res);
      expect(res.statusCode, paidMonths).toBe(400);
    }
    expect(pgQueryOne).not.toHaveBeenCalled();
  });

  it('суммы строки уходят на фронт как есть', async () => {
    pgQueryOne.mockResolvedValueOnce({
      total: '1', without_terms_total: '1',
      rows: [{
        employee_id: 5,
        full_name: 'А',
        paid_total: '141900.55',
        paid_deductions_total: '8500.10',
        paid_deductions: [{ month: '2026-07', item: 'meals', amount: '8500.10' }],
      }],
    });
    const res = makeRes();
    await payrollTermsController.list(makeReq({ query: { paid_months: '2026-07' } } as Partial<AuthenticatedRequest>), res);

    expect(res.body.data[0]).toMatchObject({
      paid_total: '141900.55',
      paid_deductions_total: '8500.10',
      paid_deductions: [{ month: '2026-07', item: 'meals', amount: '8500.10' }],
    });
  });
});
