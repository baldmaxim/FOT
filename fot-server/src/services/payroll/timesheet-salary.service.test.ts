import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthenticatedRequest } from '../../types/index.js';

// Строки вкладки «Табель → Зарплата»: «Оклад» и «Переработка» отдела — строки того же расчёта, что «Сумма»;
// у бригады их нет. Сам расчёт проверяют calc-тесты.
const pg = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock('../../config/postgres.js', () => ({
  query: pg.query,
  queryOne: pg.queryOne,
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

const memberships = vi.hoisted(() => ({ listEmployeeMembershipsForDepartmentPeriod: vi.fn() }));
vi.mock('../timesheet-department-assignments.service.js', () => memberships);

const calc = vi.hoisted(() => ({
  getPayoutForEmployees: vi.fn(),
  getPreliminaryPayoutForEmployees: vi.fn(),
  previewBrigadePayouts: vi.fn(),
}));
vi.mock('./payroll-calc.service.js', () => calc);

const brigade = vi.hoisted(() => ({ getBrigadeSalary: vi.fn() }));
vi.mock('./brigade-salary.service.js', () => brigade);

const scope = vi.hoisted(() => ({
  resolveBrigadeInputEditPredicate: vi.fn(),
  resolveBrigadeKtuEditPredicate: vi.fn(),
  resolvePayrollReadableDepartmentIds: vi.fn(),
}));
vi.mock('./payroll-scope.service.js', () => scope);

// Уровень доступа — заглушка; пределы КТУ — настоящие (370).
const level = vi.hoisted(() => ({ getRequestBrigadeSalaryLevel: vi.fn() }));
vi.mock('./brigade-output-access.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./brigade-output-access.service.js')>()),
  getRequestBrigadeSalaryLevel: level.getRequestBrigadeSalaryLevel,
}));

import { getBrigadeObjectOutputs, getTimesheetSalary } from './timesheet-salary.service.js';

const req = { user: { id: 'user-1' } } as unknown as AuthenticatedRequest;
const DEPARTMENT = { id: 'dept-1', name: 'Бухгалтерия', kind: 'department' };
const BRIGADE = { id: 'brigade-1', name: 'бр.Аюби', kind: 'brigade' };

const CONTRACT = { code: 'contract', amount: '250000.00', days: { worked: 22, norm: 22 } };
const OVERTIME = { code: 'overtime', amount: '2840.91', days: { worked: 0, norm: 22 }, hours: 2 };
const TRAVEL = { code: 'travel', amount: '2730.00', days: { worked: 22, norm: 22 } };

const closed = (lines: unknown[], net: string) => ({
  state: 'closed', lines, deductions: [], accrued: net, deducted: '0.00', net, missing: [],
});

const preliminary = (lines: unknown[], net: string, asOf: string) => ({
  state: 'preliminary', as_of: asOf, lines, deductions: [], accrued: net, deducted: '1200.00', net,
  missing: ['vacation_pay'],
});

beforeEach(() => {
  vi.clearAllMocks();
  pg.query.mockResolvedValue([]);
  scope.resolveBrigadeInputEditPredicate.mockResolvedValue(() => true);
  scope.resolveBrigadeKtuEditPredicate.mockResolvedValue(() => true);
  level.getRequestBrigadeSalaryLevel.mockResolvedValue({ kind: 'payroll' });
});

describe('getTimesheetSalary — «Оклад» и «Переработка»', () => {
  it('отдел, табель закрыт — строки оклада и переработки из расчёта «Суммы»', async () => {
    memberships.listEmployeeMembershipsForDepartmentPeriod.mockResolvedValue([
      { employee_id: 1428 }, { employee_id: 1500 },
    ]);
    calc.getPayoutForEmployees.mockResolvedValue(new Map([
      [1428, closed([CONTRACT, OVERTIME, TRAVEL], '255570.91')],
      [1500, closed([CONTRACT], '250000.00')],
    ]));

    const result = await getTimesheetSalary(req, DEPARTMENT, '2026-09');

    expect(calc.getPayoutForEmployees).toHaveBeenCalledWith([1428, 1500], '2026-09', req);
    // Без опции (старый фронт) — только закрытый табель.
    expect(calc.getPreliminaryPayoutForEmployees).not.toHaveBeenCalled();
    expect(result.as_of).toBeNull();
    expect(result.rows[0]).toMatchObject({
      employee_id: 1428, amount: '255570.91', contract: CONTRACT, overtime: OVERTIME, payout_state: 'closed',
    });
    // Переработки нет — строки нет, а не ноль.
    expect(result.rows[1]).toMatchObject({ employee_id: 1500, contract: CONTRACT, overtime: null });
  });

  it('отдел, табель не закрыт — ни оклада, ни переработки', async () => {
    memberships.listEmployeeMembershipsForDepartmentPeriod.mockResolvedValue([{ employee_id: 1428 }]);
    calc.getPayoutForEmployees.mockResolvedValue(new Map([[1428, { state: 'not_closed', reason: 'open' }]]));

    const result = await getTimesheetSalary(req, DEPARTMENT, '2026-10');

    expect(result.rows).toEqual([expect.objectContaining({
      employee_id: 1428, amount: null, contract: null, overtime: null, payout_state: 'not_closed',
    })]);
  });

  it('отдел, preliminary — незакрытый месяц по живому табелю, закрытый и не работавший — как раньше', async () => {
    memberships.listEmployeeMembershipsForDepartmentPeriod.mockResolvedValue([
      { employee_id: 1428 }, { employee_id: 1500 }, { employee_id: 1600 },
    ]);
    calc.getPreliminaryPayoutForEmployees.mockResolvedValue(new Map([
      [1428, closed([CONTRACT, OVERTIME, TRAVEL], '255570.91')],
      [1500, preliminary([CONTRACT, OVERTIME], '251640.91', '2026-09-30')],
      [1600, { state: 'not_closed', reason: 'no_period' }],
    ]));

    const result = await getTimesheetSalary(req, DEPARTMENT, '2026-09', { preliminary: true });

    expect(calc.getPreliminaryPayoutForEmployees).toHaveBeenCalledWith([1428, 1500, 1600], '2026-09', req);
    expect(calc.getPayoutForEmployees).not.toHaveBeenCalled();
    expect(result.as_of).toBe('2026-09-30');
    expect(result.rows[0]).toMatchObject({
      employee_id: 1428, amount: '255570.91', deducted: '0.00', contract: CONTRACT, overtime: OVERTIME,
      missing: [], payout_state: 'closed',
    });
    expect(result.rows[1]).toMatchObject({
      employee_id: 1500, amount: '251640.91', deducted: '1200.00', contract: CONTRACT, overtime: OVERTIME,
      missing: ['vacation_pay'], payout_state: 'preliminary',
    });
    expect(result.rows[2]).toMatchObject({
      employee_id: 1600, amount: null, deducted: null, contract: null, overtime: null, missing: [],
      payout_state: 'not_closed',
    });
  });

  it('отдел, preliminary, предварительных нет — as_of null', async () => {
    memberships.listEmployeeMembershipsForDepartmentPeriod.mockResolvedValue([{ employee_id: 1428 }]);
    calc.getPreliminaryPayoutForEmployees.mockResolvedValue(new Map([[1428, closed([CONTRACT], '250000.00')]]));

    const result = await getTimesheetSalary(req, DEPARTMENT, '2026-08', { preliminary: true });

    expect(result.as_of).toBeNull();
    expect(result.rows[0]).toMatchObject({ amount: '250000.00', payout_state: 'closed' });
  });

  it('бригада — оклада и переработки нет, КТУ и «Сумма» прежние', async () => {
    brigade.getBrigadeSalary.mockResolvedValue({
      state: 'fixed',
      distribution: 'ok',
      as_of: null,
      open_ranges: [],
      errors: [],
      computed_at: '2026-10-27T11:16:00.000Z',
      rows: [{
        employee_id: 1951, ktu: '1.5', counted_minutes: 12600, amount: '273399.53', source: 'version',
        objects: [{ object_key: 'wave', days: { '2026-09-01': 10 }, counted_minutes: 12600, weight: 189_000, amount: '273399.53' }],
      }],
      objects: [{ object_key: 'wave', object_name: 'ЖК Wave', output: '1000000.00', state: 'ok', total_weight: 691_300 }],
      inputs: { outputs: new Map([['wave', { amount: '1000000.00', object_name: 'ЖК Wave' }]]), brigadeOutput: null, ktu: new Map([[1951, 15]]) },
      share_conflicts: [],
      member_ids: [1951],
    });
    pg.query.mockResolvedValue([{ id: 1951, full_name: 'Абдуалимов Жахонгир' }]);
    calc.previewBrigadePayouts.mockResolvedValue(new Map([[1951, {
      lines: [{ code: 'brigade', amount: '273399.53' }],
      deductions: [],
      accrued: '273399.53',
      deducted: '3500.00',
      net: '269899.53',
      missing: [],
    }]]));

    // Опция только для отделов: у бригады своё «Предварительно».
    const result = await getTimesheetSalary(req, BRIGADE, '2026-09', { preliminary: true });

    expect(calc.getPreliminaryPayoutForEmployees).not.toHaveBeenCalled();
    expect(calc.getPayoutForEmployees).not.toHaveBeenCalled();
    expect(result.rows).toEqual([expect.objectContaining({
      employee_id: 1951,
      ktu: '1.5',
      counted_hours: 210,
      amount: '269899.53',
      share: '273399.53',
      deducted: '3500.00',
      contract: null,
      overtime: null,
      can_edit: true,
      full_name: 'Абдуалимов Жахонгир',
    })]);
    expect(result.output_amount).toBe('1000000.00');
    // ОТиЗ и список «Зарплаты» — всё как раньше: поля выработки и доли, КТУ 0,0…2,2.
    expect(result.access).toEqual({ can_edit_output: true, can_edit_share: true, ktu_min: '0.0', ktu_max: '2.2' });
    expect(result.objects).toEqual([{
      object_key: 'wave',
      object_name: 'ЖК Wave',
      output_amount: '1000000.00',
      state: 'ok',
      total_hours: 10,
      total_weight: 691_300,
      members: [{
        employee_id: 1951, days: { '2026-09-01': 10 }, hours: 10, counted_minutes: 12600, weight: 189_000,
        share: '273399.53', fixed_share: null, effective_ktu: null,
      }],
    }]);
    // Факт доли для «Суммы» — по объектам.
    expect(calc.previewBrigadePayouts.mock.calls[0][0].get(1951)).toMatchObject({
      amount: '273399.53',
      objects: [{ objectKey: 'wave', objectName: 'ЖК Wave', output: '1000000.00', totalWeight: 691_300 }],
    });
  });

  it('бригада: выработка без часов — группа без рабочих (её можно стереть); «Не определён» — последней', async () => {
    brigade.getBrigadeSalary.mockResolvedValue({
      state: 'preliminary',
      distribution: 'nothing_to_distribute',
      as_of: '2026-10-28',
      open_ranges: [],
      errors: [],
      computed_at: null,
      rows: [{
        employee_id: 1951, ktu: '1.0', counted_minutes: 600, amount: null, source: 'live',
        objects: [{ object_key: '__unknown_object__', days: { '2026-10-01': 10 }, counted_minutes: 600, weight: 6000, amount: null }],
      }],
      objects: [
        { object_key: 'alia', object_name: 'ЖК Alia', output: '5000.00', state: 'nothing_to_distribute', total_weight: 0 },
        { object_key: '__unknown_object__', object_name: 'Не определён', output: null, state: 'no_output', total_weight: 6000 },
      ],
      inputs: { outputs: new Map([['alia', { amount: '5000.00', object_name: 'ЖК Alia' }]]), brigadeOutput: null, ktu: new Map() },
      share_conflicts: [],
      member_ids: [1951],
    });
    calc.previewBrigadePayouts.mockResolvedValue(new Map());

    const result = await getTimesheetSalary(req, BRIGADE, '2026-10');

    expect(result.objects.map(object => [object.object_name, object.members.length, object.state])).toEqual([
      ['ЖК Alia', 0, 'nothing_to_distribute'],
      ['Не определён', 1, 'no_output'],
    ]);
    expect(result.rows[0]).toMatchObject({ amount: null, share: null });
  });
});

describe('getBrigadeObjectOutputs — стрелка во «Бригадах»', () => {
  const salary = {
    inputs: { brigadeOutput: null, outputs: new Map(), ktu: new Map() },
    objects: [
      { object_key: 'wave', object_name: 'ЖК Wave', output: '1000.00', state: 'distributed', total_weight: 10 },
      { object_key: 'old', object_name: 'ЖК Старый', output: '50.00', state: 'distributed', total_weight: 0 },
      { object_key: 'empty', object_name: 'ЖК Новый', output: null, state: 'distributed', total_weight: 0 },
    ],
    rows: [
      {
        employee_id: 1,
        amount: '600.00',
        objects: [{ object_key: 'wave', days: { '2026-11-02': 8.4, '2026-11-03': 7.6 }, counted_minutes: 960, weight: 6, amount: '600.00' }],
      },
      {
        employee_id: 2,
        amount: '400.00',
        objects: [{ object_key: 'wave', days: { '2026-11-02': 3.5 }, counted_minutes: 210, weight: 4, amount: '400.00' }],
      },
    ],
  };

  it('часы как на экране: дневные округлены, сумма по рабочим; без часов с выработкой — только стереть', async () => {
    brigade.getBrigadeSalary.mockResolvedValue(salary);
    const data = await getBrigadeObjectOutputs(req, BRIGADE, '2026-11');
    expect(data).toEqual({
      department_id: 'brigade-1',
      month: '2026-11',
      output_mode: 'objects',
      objects: [
        { object_key: 'wave', object_name: 'ЖК Wave', output_amount: '1000.00', hours: 20, clear_only: false },
        { object_key: 'old', object_name: 'ЖК Старый', output_amount: '50.00', hours: 0, clear_only: true },
        { object_key: 'empty', object_name: 'ЖК Новый', output_amount: null, hours: 0, clear_only: false },
      ],
    });
  });

  it('в ответе нет людей и их денег', async () => {
    brigade.getBrigadeSalary.mockResolvedValue(salary);
    const text = JSON.stringify(await getBrigadeObjectOutputs(req, BRIGADE, '2026-11'));
    for (const key of ['rows', 'members', 'employee_id', 'full_name', 'ktu', 'share', 'deducted', '"amount"', 'weight']) {
      expect(text).not.toContain(key);
    }
    expect(calc.previewBrigadePayouts).not.toHaveBeenCalled();
  });
});

describe('getTimesheetSalary — начальник участка (370)', () => {
  // 1951 — КТУ 1,5; 2325 — КТУ ОТиЗ 2,0; 2400 — вписанная доля на «wave»; 2500 — КТУ по умолчанию 1,0.
  const members = [1951, 2325, 2400, 2500];
  const brigadeResult = (state: string) => ({
    state,
    distribution: 'ok',
    as_of: null,
    open_ranges: [],
    errors: [],
    computed_at: null,
    mode: 'objects',
    output_amount: '1000000.00',
    rows: members.map(id => ({
      employee_id: id, counted_minutes: 600, amount: null, source: 'live',
      objects: [{ object_key: 'wave', days: { '2026-11-03': 10 }, counted_minutes: 600, weight: 6000, amount: null }],
    })),
    objects: [{ object_key: 'wave', object_name: 'ЖК Wave', output: '1000000.00', state: 'ok', total_weight: 24_000 }],
    inputs: {
      outputs: new Map([['wave', { amount: '1000000.00', object_name: 'ЖК Wave' }]]),
      brigadeOutput: null,
      ktu: new Map([[1951, 15], [2325, 20]]),
      fixedShares: new Map([['wave', new Map([[2400, '150000.00']])]]),
    },
    share_conflicts: [],
    member_ids: members,
  });

  beforeEach(() => {
    level.getRequestBrigadeSalaryLevel.mockResolvedValue({ kind: 'supervisor', brigadeIds: new Set([BRIGADE.id]) });
    // Долю начальник не правит — предикат доли закрыт (как у настоящего без «Выработки»).
    scope.resolveBrigadeInputEditPredicate.mockResolvedValue(() => false);
    calc.previewBrigadePayouts.mockResolvedValue(new Map());
  });

  const editable = (result: Awaited<ReturnType<typeof getTimesheetSalary>>) => Object.fromEntries(
    result.rows.map(row => [row.employee_id, row.can_edit]),
  );

  it('открытый месяц: КТУ в 0,8–1,6 без вписанной доли — правится; КТУ ОТиЗ 2,0 и вписанная доля — нет', async () => {
    brigade.getBrigadeSalary.mockResolvedValue(brigadeResult('preliminary'));
    const result = await getTimesheetSalary(req, BRIGADE, '2026-11');
    expect(result.access).toEqual({ can_edit_output: false, can_edit_share: false, ktu_min: '0.8', ktu_max: '1.6' });
    expect(editable(result)).toEqual({ 1951: true, 2325: false, 2400: false, 2500: true });
    expect(result.rows.every(row => row.can_clear_share === false)).toBe(true);
  });

  it('«Требует перерасчёта» (период снова открыт) — правится', async () => {
    brigade.getBrigadeSalary.mockResolvedValue(brigadeResult('stale'));
    expect(editable(await getTimesheetSalary(req, BRIGADE, '2026-11'))).toMatchObject({ 1951: true, 2500: true });
  });

  it('закрытый месяц — КТУ никому', async () => {
    brigade.getBrigadeSalary.mockResolvedValue(brigadeResult('fixed'));
    expect(editable(await getTimesheetSalary(req, BRIGADE, '2026-11'))).toEqual({ 1951: false, 2325: false, 2400: false, 2500: false });
  });
});
