import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthenticatedRequest } from '../../types/index.js';
import type { IPayrollCalcClosed, PayrollCalc } from './payroll-calc.service.js';

/**
 * Столбец «Зарплата» (миграция 382): DTO расшифровки по белому списку, сумма — только у закрытого полного расчёта,
 * расчёт только на чтение, состав — по истории назначений за расчётный месяц.
 */

const h = vi.hoisted(() => ({
  query: vi.fn(),
  payouts: vi.fn(),
  memberships: vi.fn(),
}));

vi.mock('../../config/postgres.js', () => ({ query: h.query, queryOne: vi.fn() }));
vi.mock('./payroll-calc.service.js', () => ({ getPayoutForEmployees: h.payouts }));
vi.mock('../timesheet-department-assignments.service.js', () => ({
  listEmployeeMembershipsForDepartmentPeriod: h.memberships,
}));

const {
  calcTeamSalaryRows,
  filterSalaryMonthMembers,
  loadTeamSalaryMembers,
  toTeamSalaryCalc,
  toTeamSalaryRow,
} = await import('./team-salary.service.js');

const closedCalc = (overrides: Partial<IPayrollCalcClosed> = {}): IPayrollCalcClosed => ({
  state: 'closed',
  quality: 'materialized',
  basis_ids: [11, 12],
  version_ids: [21],
  norm_days: 23,
  period_from: '2026-10-01',
  period_to: '2026-10-31',
  worked_days: { workday: 16, dayoff: 0 },
  absences: { vacation: 0, sick: 5, educational_leave: 0, unpaid: 0 },
  rate_allowances: [{ kind: 'travel', rate: '2730.00' } as never],
  terms: [{ id: 1, salary: '200000.00', note: 'Приказ №15 от 01.04', created_by: 'u-1' } as never],
  lines: [
    {
      code: 'contract',
      amount: '138043.00',
      hours: 127,
      parts: [{
        kind: 'salary_hours', from: '2026-10-01', to: '2026-10-31', salary: '200000.00', bonus: '0.00', minutes: 7620,
        norm_minutes: 11040, rounding: 'ruble', amount: '138043.00',
      }],
    },
    {
      code: 'travel',
      amount: '1899.00',
      days: { worked: 16, norm: 23 },
      parts: [{ kind: 'travel', rate: '2730.00', days: 16, norm: 23, amount: '1899.00' }],
    },
    {
      code: 'brigade',
      amount: '50000.00',
      brigade: { ktu: '1.5', hours: 100 },
      parts: [{
        kind: 'brigade', department_id: 'b-1', object_key: 'o-1', object_name: 'ЖК Примавера К14', output: '900000.00',
        ktu_tenths: 15, counted_minutes: 6000, weight: 90000, total_weight: 1620000, amount: '50000.00',
      }],
    },
  ],
  deductions: [{ kind_id: 7, kind: 'Штрафы', amount: '1000.00' }],
  accrued: '189942.00',
  deducted: '1000.00',
  net: '188942.00',
  missing: [],
  hours_by_day: [{ date: '2026-10-01' } as never],
  norm_plan: null,
  previous_net: '1.00',
  ...overrides,
});

const req = { user: { id: 'u-head', employee_id: 815 } } as unknown as AuthenticatedRequest;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('toTeamSalaryCalc — белый список', () => {
  it('без условий оплаты, ставок, служебных id, «Часов по дням» и прежнего итога', () => {
    const dto = toTeamSalaryCalc(closedCalc());
    expect(Object.keys(dto).sort()).toEqual([
      'absences', 'accrued', 'deducted', 'deductions', 'lines', 'missing', 'net', 'norm_days', 'period_from',
      'period_to', 'state', 'worked_days',
    ]);
    const json = JSON.stringify(dto);
    for (const forbidden of ['terms', 'rate_allowances', 'basis_ids', 'version_ids', 'quality', 'hours_by_day',
      'norm_plan', 'previous_net', 'Приказ', 'created_by']) {
      expect(json, forbidden).not.toContain(forbidden);
    }
    expect(dto.state).toBe('closed');
  });

  it('строки и части — поля формулы своего вида; лишнее поле части отбрасывается', () => {
    const calc = closedCalc();
    (calc.lines[0].parts![0] as unknown as Record<string, unknown>).secret = 'x';
    (calc.lines[0] as unknown as Record<string, unknown>).internal = 'y';
    const dto = toTeamSalaryCalc(calc);
    expect(dto.lines[0]).toEqual({
      code: 'contract',
      amount: '138043.00',
      hours: 127,
      parts: [{
        kind: 'salary_hours', from: '2026-10-01', to: '2026-10-31', salary: '200000.00', bonus: '0.00', minutes: 7620,
        norm_minutes: 11040, rounding: 'ruble', amount: '138043.00',
      }],
    });
    expect(dto.lines[1].days).toEqual({ worked: 16, norm: 23 });
    expect(dto.lines[2].brigade).toEqual({ ktu: '1.5', hours: 100 });
    expect(dto.lines[2].parts![0]).toMatchObject({ kind: 'brigade', object_name: 'ЖК Примавера К14', ktu_tenths: 15 });
    expect(dto.deductions).toEqual([{ kind_id: 7, kind: 'Штрафы', amount: '1000.00' }]);
  });
});

describe('toTeamSalaryRow', () => {
  it('закрытый полный — сумма и расшифровка', () => {
    const row = toTeamSalaryRow(5, closedCalc());
    expect(row).toMatchObject({ employee_id: 5, status: 'ready', net: '188942.00' });
  });

  it('незакрытый — код причины без цифр', () => {
    for (const reason of ['not_covered', 'norm_conflict', 'no_period', 'brigade_open'] as const) {
      const calc: PayrollCalc = { state: 'not_closed', reason };
      expect(toTeamSalaryRow(5, calc)).toEqual({ employee_id: 5, status: 'not_closed', reason });
    }
  });

  it('нет расчёта — «не работал в месяце»', () => {
    expect(toTeamSalaryRow(5, undefined)).toEqual({ employee_id: 5, status: 'not_closed', reason: 'no_period' });
  });

  it('закрытый, но без больничных из 1С или с неизвестным итогом — not_ready без суммы', () => {
    expect(toTeamSalaryRow(5, closedCalc({ missing: ['sick_pay'] }))).toEqual({
      employee_id: 5, status: 'not_ready', missing: ['sick_pay'],
    });
    expect(toTeamSalaryRow(5, closedCalc({ net: null, missing: ['brigade_output'] }))).toEqual({
      employee_id: 5, status: 'not_ready', missing: ['brigade_output'],
    });
  });
});

describe('calcTeamSalaryRows', () => {
  it('только чтение: fixBrigades:false, без «Часов по дням»; строки в порядке состава', async () => {
    h.payouts.mockResolvedValue(new Map<number, PayrollCalc>([
      [2, closedCalc()],
      [1, { state: 'not_closed', reason: 'brigade_open' }],
    ]));
    const rows = await calcTeamSalaryRows([1, 2, 3], '2026-10', req);
    expect(h.payouts).toHaveBeenCalledWith([1, 2, 3], '2026-10', req, undefined, { fixBrigades: false });
    expect(rows.map(row => [row.employee_id, row.status])).toEqual([
      [1, 'not_closed'], [2, 'ready'], [3, 'not_closed'],
    ]);
  });

  it('пустой состав — без расчёта', async () => {
    expect(await calcTeamSalaryRows([], '2026-10', req)).toEqual([]);
    expect(h.payouts).not.toHaveBeenCalled();
  });
});

describe('filterSalaryMonthMembers — история назначений за месяц главнее текущего отдела', () => {
  const SUBTREE = ['dept-b', 'dept-b-child'];

  const mockHistory = (
    assignments: Array<{ employee_id: number; org_department_id: string | null }>,
    dismissals: number[] = [],
  ) => {
    h.query.mockImplementation(async (sql: string) => (
      String(sql).includes('FROM employee_dismissal_events')
        ? dismissals.map(employee_id => ({ employee_id }))
        : assignments
    ));
  };

  it('перевод внутри месяца — есть назначение в поддерево, человек остаётся', async () => {
    mockHistory([{ employee_id: 1, org_department_id: 'dept-a' }, { employee_id: 1, org_department_id: 'dept-b' }]);
    expect(await filterSalaryMonthMembers([1], SUBTREE, '2026-10')).toEqual([1]);
  });

  it('перевод после месяца или с разрывом — за месяц только чужой отдел, строки нет', async () => {
    mockHistory([{ employee_id: 2, org_department_id: 'dept-a' }]);
    expect(await filterSalaryMonthMembers([2], SUBTREE, '2026-10')).toEqual([]);
  });

  it('подотдел — тоже свой', async () => {
    mockHistory([{ employee_id: 3, org_department_id: 'dept-b-child' }]);
    expect(await filterSalaryMonthMembers([3], SUBTREE, '2026-10')).toEqual([3]);
  });

  it('нет ни одного назначения за месяц — по текущему отделу (как сетка)', async () => {
    mockHistory([]);
    expect(await filterSalaryMonthMembers([4], SUBTREE, '2026-10')).toEqual([4]);
  });

  it('уволен из поддерева в этом месяце — остаётся, даже если история указывает другой отдел', async () => {
    mockHistory([{ employee_id: 5, org_department_id: 'dept-a' }], [5]);
    expect(await filterSalaryMonthMembers([5], SUBTREE, '2026-10')).toEqual([5]);
  });

  it('границы месяца в запросе — весь месяц', async () => {
    mockHistory([]);
    await filterSalaryMonthMembers([1], SUBTREE, '2026-10');
    const [, params] = h.query.mock.calls[0] as [string, unknown[]];
    expect(params.slice(1)).toEqual(['2026-10-01', '2026-10-31']);
  });
});

describe('loadTeamSalaryMembers', () => {
  it('состав как у сетки — с уволенными в месяце увольнения, за весь месяц', async () => {
    h.memberships.mockResolvedValue([{ employee_id: 9 }, { employee_id: 3 }, { employee_id: 9 }]);
    h.query.mockImplementation(async (sql: string) => (
      String(sql).includes('get_descendant_department_ids') ? [{ id: 'dept-b' }] : []
    ));
    expect(await loadTeamSalaryMembers('dept-b', '2026-10')).toEqual([3, 9]);
    expect(h.memberships).toHaveBeenCalledWith('dept-b', '2026-10-01', '2026-10-31', undefined, {
      firedInDismissalMonth: true,
    });
  });
});
