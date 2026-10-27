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

const calc = vi.hoisted(() => ({ getPayoutForEmployees: vi.fn(), previewBrigadePayouts: vi.fn() }));
vi.mock('./payroll-calc.service.js', () => calc);

const brigade = vi.hoisted(() => ({ getBrigadeSalary: vi.fn() }));
vi.mock('./brigade-salary.service.js', () => brigade);

const scope = vi.hoisted(() => ({
  resolvePayrollEditPredicate: vi.fn(),
  resolvePayrollReadableDepartmentIds: vi.fn(),
}));
vi.mock('./payroll-scope.service.js', () => scope);

import { getTimesheetSalary } from './timesheet-salary.service.js';

const req = { user: { id: 'user-1' } } as unknown as AuthenticatedRequest;
const DEPARTMENT = { id: 'dept-1', name: 'Бухгалтерия', kind: 'department' };
const BRIGADE = { id: 'brigade-1', name: 'бр.Аюби', kind: 'brigade' };

const CONTRACT = { code: 'contract', amount: '250000.00', days: { worked: 22, norm: 22 } };
const OVERTIME = { code: 'overtime', amount: '2840.91', days: { worked: 0, norm: 22 }, hours: 2 };
const TRAVEL = { code: 'travel', amount: '2730.00', days: { worked: 22, norm: 22 } };

const closed = (lines: unknown[], net: string) => ({
  state: 'closed', lines, deductions: [], accrued: net, deducted: '0.00', net, missing: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  pg.query.mockResolvedValue([]);
  scope.resolvePayrollEditPredicate.mockResolvedValue(() => true);
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

  it('бригада — оклада и переработки нет, КТУ и «Сумма» прежние', async () => {
    brigade.getBrigadeSalary.mockResolvedValue({
      state: 'fixed',
      distribution: 'ok',
      as_of: null,
      open_ranges: [],
      errors: [],
      computed_at: '2026-10-27T11:16:00.000Z',
      rows: [{ employee_id: 1951, ktu: '1.5', counted_minutes: 12600, amount: '273399.53', source: 'version' }],
      inputs: { output: '1000000.00', ktu: new Map([[1951, 15]]) },
      member_ids: [1951],
    });
    calc.previewBrigadePayouts.mockResolvedValue(new Map([[1951, {
      lines: [{ code: 'brigade', amount: '273399.53' }],
      deductions: [],
      accrued: '273399.53',
      deducted: '3500.00',
      net: '269899.53',
      missing: [],
    }]]));

    const result = await getTimesheetSalary(req, BRIGADE, '2026-09');

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
    })]);
  });
});
