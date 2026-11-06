import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthenticatedRequest } from '../../types/index.js';
import type { PayrollCalcWithPreliminary } from './payroll-calc.service.js';
import type { IHousingAllowanceRow } from './payroll-housing.service.js';

const housing = vi.hoisted(() => ({ listHousingAllowances: vi.fn() }));
vi.mock('./payroll-housing.service.js', () => housing);

const calc = vi.hoisted(() => ({ getPreliminaryPayoutForEmployees: vi.fn() }));
vi.mock('./payroll-calc.service.js', () => calc);

const brigade = vi.hoisted(() => ({ resolvePreliminaryAsOf: vi.fn() }));
vi.mock('./brigade-salary.service.js', () => brigade);

vi.mock('./payroll-calc-columns.service.js', () => ({ CALC_COLUMNS_MAX_MONTHS: 12 }));

import { apartmentMonthAmount, lastStaysOfMonth, listHousingMonthAmounts } from './payroll-housing-month.service.js';

const req = { user: { id: 'user-1' } } as unknown as AuthenticatedRequest;
const SCOPE = { contractorRootId: 'contractor-root', departmentIds: ['d-1'] };

const stay = (over: Partial<IHousingAllowanceRow> = {}): IHousingAllowanceRow => ({
  id: 1,
  employee_id: 42,
  full_name: 'Каримов Акмал',
  department: 'ЛИНИЯ',
  position: 'прораб',
  amount: '630.00',
  check_in: '2026-09-01',
  check_out: null,
  address: null,
  ...over,
});

const details = {
  norm_days: 22, period_from: '2026-10-01', period_to: '2026-10-31', worked_days: { workday: 22, dayoff: 0 },
  absences: {}, terms: [], lines: [], net: '0.00', missing: [],
};
const closed = (rateAllowances: Array<{ code: string; amount: string }>): PayrollCalcWithPreliminary => ({
  state: 'closed', quality: 'exact', basis_ids: [], version_ids: [], rate_allowances: rateAllowances, ...details,
} as unknown as PayrollCalcWithPreliminary);
const preliminary = (rateAllowances: Array<{ code: string; amount: string }>): PayrollCalcWithPreliminary => ({
  state: 'preliminary', as_of: '2026-11-05', rate_allowances: rateAllowances, ...details,
} as unknown as PayrollCalcWithPreliminary);

/** Расчёт: каждому id — квартира 100 × id (видно, чья сумма). */
const payoutsById = (ids: readonly number[]) => new Map(
  ids.map(id => [id, closed([{ code: 'housing', amount: `${id * 100}.00` }])]),
);

beforeEach(() => {
  vi.resetAllMocks();
  brigade.resolvePreliminaryAsOf.mockImplementation((month: string) => `${month}-28`);
  calc.getPreliminaryPayoutForEmployees.mockImplementation(async (ids: number[]) => payoutsById(ids));
});

describe('apartmentMonthAmount', () => {
  it('закрытый и предварительный расчёт — сумма квартиры, без доплаты за общежитие', () => {
    expect(apartmentMonthAmount(closed([
      { code: 'travel', amount: '2730.00' },
      { code: 'dormitory_allowance', amount: '500.00' },
      { code: 'housing', amount: '19530.00' },
    ]))).toBe('19530.00');
    expect(apartmentMonthAmount(preliminary([{ code: 'housing', amount: '3150.00' }]))).toBe('3150.00');
  });

  it('посчитано, а строки квартиры нет — 0.00; расчёта нет или месяц не закрыт — null', () => {
    expect(apartmentMonthAmount(closed([{ code: 'dormitory_allowance', amount: '500.00' }]))).toBe('0.00');
    expect(apartmentMonthAmount(preliminary([]))).toBe('0.00');
    expect(apartmentMonthAmount(undefined)).toBeNull();
    expect(apartmentMonthAmount({ state: 'not_closed', reason: 'brigade_open' })).toBeNull();
  });
});

describe('lastStaysOfMonth', () => {
  it('проживание [въезд, выезд): выезд 1-го — в месяце уже не жил, въезд в последний день — жил', () => {
    const stays = [
      stay({ id: 1, employee_id: 1, check_in: '2026-09-01', check_out: '2026-10-01' }),
      stay({ id: 2, employee_id: 2, check_in: '2026-10-31' }),
      stay({ id: 3, employee_id: 3, check_in: '2026-11-01' }),
    ];
    expect(lastStaysOfMonth(stays, '2026-10').map(row => row.id)).toEqual([2]);
  });

  it('две квартиры с разными ставками в месяце — одна строка, последнее проживание (въезд, затем id)', () => {
    const stays = [
      stay({ id: 7, check_in: '2026-10-16', amount: '700.00' }),
      stay({ id: 5, check_in: '2026-09-01', check_out: '2026-10-16', amount: '630.00' }),
      stay({ id: 9, employee_id: 43, check_in: '2026-10-01', check_out: '2026-10-02' }),
      stay({ id: 8, employee_id: 43, check_in: '2026-10-01' }),
    ];
    expect(lastStaysOfMonth(stays, '2026-10').map(row => row.id)).toEqual([7, 9]);
  });
});

describe('listHousingMonthAmounts', () => {
  it('квартиры «штата зарплаты» за месяцы; строка на сотрудника в каждом месяце со своей суммой', async () => {
    housing.listHousingAllowances.mockResolvedValue([
      stay({ id: 5, employee_id: 1, check_in: '2026-09-01', check_out: '2026-10-16', amount: '630.00' }),
      stay({ id: 7, employee_id: 1, check_in: '2026-10-16', amount: '700.00' }),
      stay({ id: 6, employee_id: 2, check_in: '2026-10-05', check_out: '2026-11-01' }),
    ]);
    const rows = await listHousingMonthAmounts(SCOPE, ['2026-10', '2026-09', '2026-10'], req);
    expect(housing.listHousingAllowances).toHaveBeenCalledWith({
      ...SCOPE, period: { monthStarts: ['2026-09-01', '2026-10-01'] },
    });
    expect(calc.getPreliminaryPayoutForEmployees).toHaveBeenCalledWith([1], '2026-09', req);
    expect(calc.getPreliminaryPayoutForEmployees).toHaveBeenCalledWith([1, 2], '2026-10', req);
    expect(rows.map(row => [row.id, row.month, row.month_amount, row.amount])).toEqual([
      [5, '2026-09', '100.00', '630.00'],
      // Сумма месяца — одна на обе квартиры (расчёт сотрудника), строка — у последней.
      [7, '2026-10', '100.00', '700.00'],
      [6, '2026-10', '200.00', '630.00'],
    ]);
  });

  it('будущий месяц и 1-е число (resolvePreliminaryAsOf — null) — без расчёта, сумма null', async () => {
    housing.listHousingAllowances.mockResolvedValue([stay({ employee_id: 1, check_in: '2026-09-01' })]);
    brigade.resolvePreliminaryAsOf.mockImplementation((month: string) => (month >= '2026-11' ? null : `${month}-31`));
    const rows = await listHousingMonthAmounts(SCOPE, ['2026-10', '2026-11', '2026-12'], req);
    expect(calc.getPreliminaryPayoutForEmployees).toHaveBeenCalledTimes(1);
    expect(calc.getPreliminaryPayoutForEmployees).toHaveBeenCalledWith([1], '2026-10', req);
    expect(rows.map(row => [row.month, row.month_amount])).toEqual([
      ['2026-10', '100.00'], ['2026-11', null], ['2026-12', null],
    ]);
  });

  it('13 и 37 месяцев — расчёт не вызывается, строки есть, суммы null; 12 — считается', async () => {
    housing.listHousingAllowances.mockResolvedValue([stay({ employee_id: 1, check_in: '2024-01-01' })]);
    const monthsFrom = (count: number) => Array.from({ length: count }, (_, index) => {
      const date = new Date(Date.UTC(2024, index, 1));
      return date.toISOString().slice(0, 7);
    });
    for (const count of [13, 37]) {
      const rows = await listHousingMonthAmounts(SCOPE, monthsFrom(count), req);
      expect(rows, String(count)).toHaveLength(count);
      expect(rows.every(row => row.month_amount === null), String(count)).toBe(true);
    }
    expect(calc.getPreliminaryPayoutForEmployees).not.toHaveBeenCalled();
    await listHousingMonthAmounts(SCOPE, monthsFrom(12), req);
    expect(calc.getPreliminaryPayoutForEmployees).toHaveBeenCalledTimes(12);
  });

  it('501 жилец — порции 500 + 1, суммы у всех', async () => {
    housing.listHousingAllowances.mockResolvedValue(
      Array.from({ length: 501 }, (_, index) => stay({ id: index + 1, employee_id: index + 1 })),
    );
    const rows = await listHousingMonthAmounts(SCOPE, ['2026-10'], req);
    const chunks = calc.getPreliminaryPayoutForEmployees.mock.calls.map(call => (call[0] as number[]).length);
    expect(chunks).toEqual([500, 1]);
    expect(rows).toHaveLength(501);
    expect(rows[500].month_amount).toBe('50100.00');
  });

  it('в месяце нет квартир — расчёт не зовётся; месяцев нет — список не читается', async () => {
    housing.listHousingAllowances.mockResolvedValue([stay({ check_in: '2026-11-03' })]);
    expect(await listHousingMonthAmounts(SCOPE, ['2026-10'], req)).toEqual([]);
    expect(calc.getPreliminaryPayoutForEmployees).not.toHaveBeenCalled();
    housing.listHousingAllowances.mockClear();
    expect(await listHousingMonthAmounts(SCOPE, [], req)).toEqual([]);
    expect(housing.listHousingAllowances).not.toHaveBeenCalled();
  });
});
