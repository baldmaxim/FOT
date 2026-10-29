import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthenticatedRequest } from '../../types/index.js';

// «Расчёты»: незакрытый месяц — предварительно по живому табелю (getPreliminaryPayoutForEmployees), карточка и вкладка
// табеля (getPayoutForEmployees) — по-прежнему только закрытый табель. Живой табель, основа дней, состав бригад и
// БД подменены: их правила проверяют свои тесты (payroll-basis, brigade-salary, timesheet-department-assignments).
const pg = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../config/postgres.js', () => ({
  query: pg.query,
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
  getPool: () => ({}),
}));

const monthBasis = vi.hoisted(() => ({ loadMonthBasisSources: vi.fn() }));
vi.mock('./payroll-month-basis.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./payroll-month-basis.service.js')>()),
  loadMonthBasisSources: monthBasis.loadMonthBasisSources,
}));

const brigade = vi.hoisted(() => ({ getBrigadeShares: vi.fn(), resolvePreliminaryAsOf: vi.fn() }));
vi.mock('./brigade-salary.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./brigade-salary.service.js')>()),
  getBrigadeShares: brigade.getBrigadeShares,
  resolvePreliminaryAsOf: brigade.resolvePreliminaryAsOf,
}));

const inputs = vi.hoisted(() => ({ loadBrigadeSalaryInputs: vi.fn() }));
vi.mock('./brigade-salary-inputs.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./brigade-salary-inputs.service.js')>()),
  loadBrigadeSalaryInputs: inputs.loadBrigadeSalaryInputs,
}));

const brigadeSource = vi.hoisted(() => ({ loadLiveDays: vi.fn() }));
vi.mock('./brigade-salary-source.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./brigade-salary-source.service.js')>()),
  loadLiveDays: brigadeSource.loadLiveDays,
}));

const membership = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../timesheet-department-assignments.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../timesheet-department-assignments.service.js')>()),
  listEmployeeMembershipsForDepartmentPeriod: membership.list,
}));

vi.mock('../../controllers/timesheet-assigned-export.controller.js', () => ({
  listBrigadeSupervisorEmployeeIdsForDepartments: vi.fn(async () => new Set<number>()),
}));

const live = vi.hoisted(() => ({ fetchTimesheetDataForEmployees: vi.fn() }));
vi.mock('../timesheet-export.service.js', () => live);

const basisDrafts = vi.hoisted(() => ({ buildBasisDraftsForDays: vi.fn() }));
vi.mock('./payroll-basis.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./payroll-basis.service.js')>()),
  buildBasisDraftsForDays: basisDrafts.buildBasisDraftsForDays,
}));

const terms = vi.hoisted(() => ({ getTermsForPeriod: vi.fn() }));
vi.mock('./payroll-terms.service.js', () => terms);
vi.mock('./payroll-rate-facts.service.js', () => ({ loadRateFacts: vi.fn(async () => new Map()) }));
vi.mock('./payroll-month-attribution.service.js', () => ({
  loadMonthBreakdown: vi.fn(async () => new Map()),
  attributeMonths: vi.fn(async () => new Map()),
  monthPairKey: (employeeId: number, month: string) => `${employeeId}|${month}`,
}));
vi.mock('./payroll-staff-category.js', () => ({
  resolveMonthStaffCategories: vi.fn(async (items: unknown[]) => items.map(() => 'worker')),
}));

import { getPayoutForEmployees, getPreliminaryPayoutForEmployees } from './payroll-calc.service.js';

const req = { user: { id: 'user-1' } } as unknown as AuthenticatedRequest;
const BRIGADE = 'brigade-1';
const OFFICE = 'dept-1';

/** Будни месяца по until-е число включительно. */
const weekdays = (month: string, until = 31): string[] => {
  const [year, mon] = month.split('-').map(Number);
  const last = Math.min(until, new Date(year, mon, 0).getDate());
  return Array.from({ length: last }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)
    .filter(date => ![0, 6].includes(new Date(`${date}T12:00:00`).getDay()));
};

const fx = vi.hoisted(() => ({
  employees: [] as Array<{ id: number; hire_date: string | null; org_department_id: string }>,
  candidates: [] as string[],
  deductions: [] as Array<{ employee_id: number; kind_id: number; kind: string; amount: string }>,
}));

const salary = (amount: string) => [{
  effective_from: '2026-01-01', effective_to: null, calc_type: 'salary', monthly_salary: amount,
  bonus_amount: null, proration_rounding: 'ruble',
}];

/** Живой табель: «Я» по 8 ч в каждый будний день из списка. */
const liveData = (byEmployee: Record<number, string[]>) => ({
  dataMap: new Map(Object.entries(byEmployee).map(([id, dates]) => [
    Number(id),
    new Map(dates.map(date => [date, { status: 'work', hours: 8, corrected: false, hoursOverridden: false }])),
  ])),
});

/** Основа из дней — упрощённо: рабочие дни табеля, норма 22 (правила основы — в payroll-basis.service.test). */
const draftsFromDays = async (_exec: unknown, source: {
  start_date: string; employees: Array<{ employee_id: number; days: Record<string, { hours: number }> }>;
}) => source.employees.map(employee => ({
  employeeId: employee.employee_id,
  month: `${source.start_date.slice(0, 7)}-01`,
  normDays: 22,
  normMinutes: 10560,
  workdayDates: Object.keys(employee.days).filter(date => employee.days[date].hours > 0).sort(),
  dayoffDates: [],
  absenceDays: { vacation: 0, sick: 0, educational_leave: 0, unpaid: 0 },
  overtimeMinutes: {},
}));

const member = (employeeId: number, over: Record<string, unknown> = {}) => ({
  employee_id: employeeId, transferred_out_date: null, joined_date: null, joined_via_transfer: false, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  fx.employees = [
    { id: 7, hire_date: null, org_department_id: BRIGADE },
    { id: 8, hire_date: null, org_department_id: OFFICE },
    { id: 9, hire_date: null, org_department_id: BRIGADE },
  ];
  fx.candidates = [];
  fx.deductions = [{ employee_id: 7, kind_id: 1, kind: 'Питание', amount: '3500.00' }];
  pg.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("d.kind = 'brigade'")) return fx.candidates.map(id => ({ department_id: id }));
    if (sql.includes('FROM employees WHERE id = ANY')) {
      const ids = params[0] as number[];
      return fx.employees.filter(row => ids.includes(row.id)).map(row => ({
        ...row, employment_status: 'active', dismissal_date: null, excluded_from_timesheet_date: null,
      }));
    }
    if (sql.includes('FROM staff_deductions')) {
      const ids = params[0] as number[];
      return fx.deductions.filter(row => ids.includes(row.employee_id));
    }
    return [];
  });
  monthBasis.loadMonthBasisSources.mockResolvedValue(new Map());
  brigade.resolvePreliminaryAsOf.mockImplementation((month: string) => (month === '2026-10' ? '2026-10-27' : `${month}-30`));
  brigade.getBrigadeShares.mockResolvedValue({ state: 'open', distribution: null, rows: [] });
  inputs.loadBrigadeSalaryInputs.mockResolvedValue({ output: null, ktu: new Map() });
  membership.list.mockResolvedValue([]);
  live.fetchTimesheetDataForEmployees.mockResolvedValue(liveData({}));
  basisDrafts.buildBasisDraftsForDays.mockImplementation(draftsFromDays);
  terms.getTermsForPeriod.mockResolvedValue(new Map([[8, salary('110000.00')], [9, salary('110000.00')]]));
});

describe('отдел: незакрытый месяц', () => {
  it('«Расчёты» — предварительно по живому табелю; карточка — «не закрыт», живой табель не читается', async () => {
    const days = weekdays('2026-09').slice(0, 11);
    live.fetchTimesheetDataForEmployees.mockResolvedValue(liveData({ 8: days }));

    const calc = (await getPreliminaryPayoutForEmployees([8], '2026-09', req)).get(8);

    expect(calc).toMatchObject({ state: 'preliminary', as_of: '2026-09-30', net: '55000.00', missing: [] });
    expect(calc?.state === 'preliminary' && calc.lines).toEqual([
      { code: 'contract', amount: '55000.00', days: { worked: 11, norm: 22 } },
    ]);
    expect(live.fetchTimesheetDataForEmployees).toHaveBeenCalledWith(
      '2026-09', [8], 'Зарплата: предварительно', { startDate: '2026-09-01', endDate: '2026-09-30' }, 'actual', true,
      { rosterMode: 'snapshot' },
    );
    // Дни живого табеля → основа: те же поля, что у редакции (hoursOverridden → hours_overridden).
    const source = basisDrafts.buildBasisDraftsForDays.mock.calls[0][1];
    expect(source).toMatchObject({ start_date: '2026-09-01', end_date: '2026-09-30' });
    expect(source.employees[0].days[days[0]]).toEqual({ status: 'work', hours: 8, hours_overridden: false });

    vi.clearAllMocks();
    expect((await getPayoutForEmployees([8], '2026-09', req)).get(8)).toEqual({ state: 'not_closed', reason: 'not_covered' });
    expect(live.fetchTimesheetDataForEmployees).not.toHaveBeenCalled();
  });

  it('«Без переработки» с 15-го: выход 19-го и час 16-го сняты, 2 ч 1-го оплачены', async () => {
    live.fetchTimesheetDataForEmployees.mockResolvedValue(liveData({ 8: weekdays('2026-09') }));
    basisDrafts.buildBasisDraftsForDays.mockImplementation(async (exec: unknown, source: Parameters<typeof draftsFromDays>[1]) => (
      (await draftsFromDays(exec, source)).map(draft => ({
        ...draft, dayoffDates: ['2026-09-19'], overtimeMinutes: { '2026-09-01': 120, '2026-09-16': 60 },
      }))
    ));
    const base = pg.query.getMockImplementation()!;
    pg.query.mockImplementation(async (sql: string, params?: unknown[]) => (sql.includes('FROM payroll_overtime_stops')
      ? [{ employee_id: 8, date_from: '2026-09-15', date_to: null }]
      : base(sql, params)));

    const calc = (await getPreliminaryPayoutForEmployees([8], '2026-09', req)).get(8);

    // 110 000 × 120 / 10 560 = 1 250.
    expect(calc).toMatchObject({ state: 'preliminary', net: '111250.00', missing: [] });
    expect(calc?.state === 'preliminary' && calc.lines).toEqual([
      { code: 'contract', amount: '110000.00', days: { worked: 22, norm: 22 } },
      { code: 'overtime', amount: '1250.00', days: { worked: 0, norm: 22 }, hours: 2 },
    ]);
  });

  it('1-е число текущего месяца (asOf нет) — «не закрыт»; принят позже asOf — не работал', async () => {
    brigade.resolvePreliminaryAsOf.mockReturnValue(null);
    expect((await getPreliminaryPayoutForEmployees([8], '2026-10', req)).get(8))
      .toEqual({ state: 'not_closed', reason: 'not_covered' });

    brigade.resolvePreliminaryAsOf.mockReturnValue('2026-10-27');
    fx.employees = [{ id: 8, hire_date: '2026-10-28', org_department_id: OFFICE }];
    expect((await getPreliminaryPayoutForEmployees([8], '2026-10', req)).get(8))
      .toEqual({ state: 'not_closed', reason: 'no_period' });
    expect(live.fetchTimesheetDataForEmployees).not.toHaveBeenCalled();
  });
});

describe('бригада: незакрытый месяц', () => {
  beforeEach(() => {
    fx.candidates = [BRIGADE];
    membership.list.mockResolvedValue([member(7)]);
  });

  it('выработки нет — часы не считаются, доля без суммы (brigade_output), удержания уже в «Сумме»', async () => {
    inputs.loadBrigadeSalaryInputs.mockResolvedValue({ output: null, ktu: new Map([[7, 15]]) });

    const calc = (await getPreliminaryPayoutForEmployees([7], '2026-09', req)).get(7);

    expect(calc).toMatchObject({ state: 'preliminary', net: '-3500.00', missing: ['brigade_output'] });
    expect(calc?.state === 'preliminary' && calc.lines).toEqual([
      { code: 'brigade', amount: null, brigade: { ktu: '1.5', hours: 0 } },
    ]);
    expect(live.fetchTimesheetDataForEmployees).not.toHaveBeenCalled();
    expect(brigadeSource.loadLiveDays).not.toHaveBeenCalled();
    expect(membership.list).toHaveBeenCalledWith(BRIGADE, '2026-09-01', '2026-09-30', undefined, { firedInDismissalMonth: true });
  });

  it('выработка есть, у переоткрытой бригады сохранён stale — живой расчёт доли, общий табель рабочего не грузится', async () => {
    inputs.loadBrigadeSalaryInputs.mockResolvedValue({ output: '100000.00', ktu: new Map() });
    const schedule = {
      schedule_id: 's', schedule_type: 'office', work_start: '08:00:00', work_end: '17:00:00', work_hours: 8,
      work_days: [1, 2, 3, 4, 5], office_days: null, late_threshold_minutes: 0, day_overrides: null, lunch_minutes: 0,
      respects_holidays: true, pattern_type: 'custom', expected_saturdays_per_month: 0, expected_sundays_per_month: 0,
      full_day_threshold_minutes: null, weekend_full_day_threshold_minutes: null, cycle_length: null, cycle_days: null,
      anchor_date: null, assignment_anchor_date: null, source: 'employee',
    };
    const days = weekdays('2026-09').slice(0, 5);
    brigadeSource.loadLiveDays.mockResolvedValue({
      days: new Map([[7, new Map(days.map(date => [date, { status: 'work', hours: 8, corrected: false, hours_overridden: false }]))]]),
      schedules: new Map([[7, new Map(days.map(date => [date, schedule]))]]),
      calendar: null,
    });

    const calc = (await getPreliminaryPayoutForEmployees([7], '2026-09', req)).get(7);

    expect(calc).toMatchObject({ state: 'preliminary', net: '96500.00', missing: [] });
    expect(calc?.state === 'preliminary' && calc.lines.map(line => [line.code, line.amount])).toEqual([['brigade', '100000.00']]);
    expect(live.fetchTimesheetDataForEmployees).not.toHaveBeenCalled();
    expect(brigadeSource.loadLiveDays).toHaveBeenCalledTimes(1);
    expect(brigadeSource.loadLiveDays).toHaveBeenCalledWith(BRIGADE, [7], '2026-09', '2026-09-30', undefined, [member(7)]);
    // Сохранённый результат (stale) не читается и не пишется.
    expect(pg.query.mock.calls.some(([sql]) => String(sql).includes('brigade_salary_results'))).toBe(false);
  });

  it('перевод отдел → бригада 16-го: дни до перевода — оклад, после — доля бригады', async () => {
    membership.list.mockResolvedValue([member(9, { joined_date: '2026-09-16', joined_via_transfer: true })]);
    live.fetchTimesheetDataForEmployees.mockResolvedValue(liveData({ 9: weekdays('2026-09') }));

    const calc = (await getPreliminaryPayoutForEmployees([9], '2026-09', req)).get(9);

    // Будни 1–15 сентября — 11 дней: 110 000 × 11 / 22.
    expect(calc?.state === 'preliminary' && calc.lines).toEqual([
      { code: 'contract', amount: '55000.00', days: { worked: 11, norm: 22 } },
      { code: 'brigade', amount: null, brigade: { ktu: '1.0', hours: 0 } },
    ]);
    expect(calc).toMatchObject({ missing: ['brigade_output'] });
    expect(live.fetchTimesheetDataForEmployees.mock.calls[0][1]).toEqual([9]);
  });

  it('перевод в бригаду завтра (текущий месяц) — по вчера только оклад, без brigade_output', async () => {
    membership.list.mockImplementation(async (_dept: string, _start: string, end: string) => (
      end >= '2026-10-28' ? [member(9, { joined_date: '2026-10-28', joined_via_transfer: true })] : []
    ));
    live.fetchTimesheetDataForEmployees.mockResolvedValue(liveData({ 9: weekdays('2026-10', 27) }));

    const calc = (await getPreliminaryPayoutForEmployees([9], '2026-10', req)).get(9);

    expect(calc).toMatchObject({ state: 'preliminary', as_of: '2026-10-27', missing: [] });
    expect(calc?.state === 'preliminary' && calc.lines.map(line => line.code)).toEqual(['contract']);
    expect(membership.list).toHaveBeenCalledWith(BRIGADE, '2026-10-01', '2026-10-27', undefined, { firedInDismissalMonth: true });
  });
});

describe('лимит бригад', () => {
  it('10 открытых бригад: весь путь бригады — не больше трёх одновременно, все досчитываются', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => 101 + i);
    fx.employees = ids.map(id => ({ id, hire_date: null, org_department_id: `brigade-${id}` }));
    fx.candidates = ids.map(id => `brigade-${id}`);
    membership.list.mockImplementation(async (departmentId: string) => [member(Number(departmentId.replace('brigade-', '')))]);
    let inFlight = 0;
    let maxInFlight = 0;
    brigade.getBrigadeShares.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return { state: 'open', distribution: null, rows: [] };
    });
    inputs.loadBrigadeSalaryInputs.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 2));
      inFlight -= 1;
      return { output: null, ktu: new Map() };
    });

    const result = await getPreliminaryPayoutForEmployees(ids, '2026-09', req);

    expect(maxInFlight).toBe(3);
    expect(ids.map(id => result.get(id)?.state)).toEqual(ids.map(() => 'preliminary'));
  });
});

describe('закрытый месяц', () => {
  it('тот же расчёт, что у карточки', async () => {
    const source = {
      basisId: 1, versionId: 10, coverFrom: '2026-09-01', coverTo: '2026-09-30', normDays: 22, normMinutes: 10560,
      workdayDates: weekdays('2026-09'), dayoffDates: [], absenceDays: {}, overtimeMinutes: { '2026-09-01': 180 },
      quality: 'materialized', departmentId: OFFICE, isBrigade: false,
    };
    monthBasis.loadMonthBasisSources.mockResolvedValue(new Map([[8, [source]]]));

    const closed = await getPayoutForEmployees([8], '2026-09', req);
    const preliminary = await getPreliminaryPayoutForEmployees([8], '2026-09', req);

    expect(closed.get(8)).toMatchObject({ state: 'closed', net: '111875.00' });
    expect(preliminary).toEqual(closed);
    expect(live.fetchTimesheetDataForEmployees).not.toHaveBeenCalled();
  });
});
