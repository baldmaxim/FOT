import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthenticatedRequest } from '../../types/index.js';
import type { IPayrollCalcClosed, PayrollCalc } from './payroll-calc.service.js';
import type { IPayrollTerms } from './payroll-terms.service.js';

const calcService = vi.hoisted(() => ({ getPayoutForEmployees: vi.fn() }));
vi.mock('./payroll-calc.service.js', () => calcService);
const termsService = vi.hoisted(() => ({ getTermsForPeriod: vi.fn() }));
vi.mock('./payroll-terms.service.js', () => termsService);

import {
  CALC_COLUMNS_MAX_MONTHS,
  cardPayoutKind,
  classifyCardPayouts,
  getCalcColumns,
  pickRateAsOf,
  sumCalcColumns,
} from './payroll-calc-columns.service.js';

const req = { user: { id: 'user-1' } } as unknown as AuthenticatedRequest;

const closed = (over: Partial<IPayrollCalcClosed> = {}): IPayrollCalcClosed => ({
  state: 'closed',
  quality: 'materialized',
  basis_ids: [1],
  version_ids: [10],
  norm_days: 22,
  period_from: '2026-09-01',
  period_to: '2026-09-30',
  worked_days: { workday: 22, dayoff: 0 },
  absences: { vacation: 0, sick: 0, educational_leave: 0 } as IPayrollCalcClosed['absences'],
  rate_allowances: [],
  terms: [],
  lines: [],
  deductions: [],
  accrued: '0.00',
  deducted: '0.00',
  net: '0.00',
  missing: [],
  ...over,
});

const terms = (over: Partial<IPayrollTerms>): IPayrollTerms => ({
  calc_type: 'salary',
  monthly_salary: null,
  hourly_rate: null,
  effective_from: '2026-01-01',
  effective_to: null,
  ...over,
} as IPayrollTerms);

describe('sumCalcColumns', () => {
  it('два закрытых месяца — суммы по столбцам, доплаты = плановая + разовая, вид проживания', () => {
    const august = closed({
      lines: [
        { code: 'contract', amount: '130952.36' },
        { code: 'overtime', amount: '8928.57' },
        { code: 'travel', amount: '2730.00' },
        { code: 'bonus', amount: '17273.00' },
      ],
      deductions: [{ kind_id: 1, kind: 'Питание', amount: '3500.00' }],
    });
    const september = closed({
      lines: [
        { code: 'contract', amount: '250000.00' },
        { code: 'supplement', amount: '5000.00' },
        { code: 'housing', amount: '15000.00' },
      ],
      rate_allowances: [{ code: 'housing', amount: '15000.00' }],
    });

    expect(sumCalcColumns([['2026-08', august], ['2026-09', september]])).toEqual({
      timesheet: '389880.93',
      travel: '2730.00',
      housing: '15000.00',
      housing_kinds: ['apartment'],
      supplements: '22273.00',
      deductions: '3500.00',
      open_months: [],
      incomplete: [],
    });
  });

  it('закрыт + открыт — частичная сумма и open_months; «не работал» (no_period) незакрытым не считается', () => {
    const result = sumCalcColumns([
      ['2026-07', { state: 'not_closed', reason: 'no_period' }],
      ['2026-08', closed({ lines: [{ code: 'contract', amount: '100000.00' }] })],
      ['2026-09', { state: 'not_closed', reason: 'not_covered' }],
    ]);

    expect(result.timesheet).toBe('100000.00');
    expect(result.open_months).toEqual(['2026-09']);
    expect(result.incomplete).toEqual([]);
  });

  it('закрыт, но строка без суммы — в сумму не идёт, причина из missing; отпускные неполнотой не считаются', () => {
    const result = sumCalcColumns([
      ['2026-08', closed({
        lines: [{ code: 'contract', amount: null }, { code: 'travel', amount: '2730.00' }],
        missing: ['hourly', 'vacation_pay'],
      })],
      ['2026-09', closed({
        lines: [{ code: 'brigade', amount: null, brigade: { ktu: '1.0', hours: 176 } }],
        missing: ['brigade_output', 'sick_pay'],
      })],
      ['2026-10', closed({ lines: [{ code: 'contract', amount: '1000.00' }], missing: ['vacation_pay', 'educational_pay'] })],
    ]);

    expect(result.timesheet).toBe('1000.00');
    expect(result.travel).toBe('2730.00');
    expect(result.incomplete).toEqual([
      { month: '2026-08', reasons: ['hourly'] },
      { month: '2026-09', reasons: ['brigade_output'] },
    ]);
  });

  it('no_terms и no_norm — неполнота; строка без суммы без причины — unknown_amount', () => {
    const result = sumCalcColumns([
      ['2026-08', closed({ lines: [{ code: 'contract', amount: '50000.00' }], missing: ['no_terms', 'no_norm'] })],
      ['2026-09', closed({ lines: [{ code: 'overtime', amount: null }] })],
    ]);

    expect(result.incomplete).toEqual([
      { month: '2026-08', reasons: ['no_terms', 'no_norm'] },
      { month: '2026-09', reasons: ['unknown_amount'] },
    ]);
  });

  it('общежитие — по доплате за общежитие; нет сумм — null, а не 0', () => {
    const result = sumCalcColumns([
      ['2026-09', closed({ lines: [{ code: 'housing', amount: '6000.00' }], rate_allowances: [{ code: 'dormitory_allowance', amount: '6000.00' }] })],
      ['2026-10', undefined],
    ]);

    expect(result.housing_kinds).toEqual(['dormitory']);
    expect(result).toMatchObject({ timesheet: null, travel: null, supplements: null, deductions: null });
  });
});

describe('pickRateAsOf', () => {
  it('переход оклад → почасовая: ставка на конец последнего месяца, вид — почасовая', () => {
    const rate = pickRateAsOf([
      terms({ calc_type: 'salary', monthly_salary: '120000.00' as unknown as number, effective_to: '2026-09-14' }),
      terms({ calc_type: 'hourly', hourly_rate: '550.5000' as unknown as number, effective_from: '2026-09-15' }),
    ], '2026-09-30');

    expect(rate).toEqual({ amount: '550.5000', calc_type: 'hourly', as_of: '2026-09-30' });
  });

  it('на конец месяца условий нет (уволен) — самая поздняя из задевающих; сумма не задана — null', () => {
    expect(pickRateAsOf([
      terms({ monthly_salary: '90000.00' as unknown as number, effective_to: '2026-09-10' }),
    ], '2026-09-30')).toEqual({ amount: '90000.00', calc_type: 'salary', as_of: '2026-09-30' });
    expect(pickRateAsOf([terms({ calc_type: 'hourly' })], '2026-09-30')).toBeNull();
    expect(pickRateAsOf([], '2026-09-30')).toBeNull();
  });
});

describe('getCalcColumns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    termsService.getTermsForPeriod.mockResolvedValue(new Map([[7, [terms({ monthly_salary: '250000.00' as unknown as number })]]]));
  });

  it('месяцы по возрастанию, ставка на последний день последнего месяца', async () => {
    calcService.getPayoutForEmployees.mockImplementation(async (_ids: number[], month: string) => (
      new Map<number, PayrollCalc>([[7, closed({ lines: [{ code: 'contract', amount: month === '2026-08' ? '100.00' : '200.00' }] })]])
    ));

    const result = await getCalcColumns([7], ['2026-09', '2026-08'], req);

    expect(calcService.getPayoutForEmployees.mock.calls.map(call => call[1])).toEqual(['2026-08', '2026-09']);
    expect(termsService.getTermsForPeriod).toHaveBeenCalledWith([7], '2026-08-01', '2026-09-30');
    expect(result.get(7)).toMatchObject({
      rate: { amount: '250000.00', calc_type: 'salary', as_of: '2026-09-30' },
      timesheet: '300.00',
    });
  });

  it(`больше ${CALC_COLUMNS_MAX_MONTHS} месяцев — расчёт ФОТ не идёт`, async () => {
    const months = Array.from({ length: CALC_COLUMNS_MAX_MONTHS + 1 }, (_, i) => `2025-${String((i % 12) + 1).padStart(2, '0')}`)
      .map((month, i) => (i === CALC_COLUMNS_MAX_MONTHS ? '2026-01' : month));

    expect((await getCalcColumns([7], months, req)).size).toBe(0);
    expect(calcService.getPayoutForEmployees).not.toHaveBeenCalled();
  });
});

describe('«Выплаты на карту»', () => {
  it('вид по способу выплаты: регистр и пробелы не важны, «Увольнения» и неизвестное — ЗП', () => {
    expect(cardPayoutKind('  АВАНС ')).toBe('advance');
    expect(cardPayoutKind('Премии')).toBe('premium');
    expect(cardPayoutKind('Зарплата')).toBe('salary');
    expect(cardPayoutKind('Увольнения')).toBe('salary');
    expect(cardPayoutKind('Межрасчётная выплата')).toBe('salary');
  });

  it('несколько способов одного вида складываются; ведомостей нет — null', () => {
    expect(classifyCardPayouts([
      { method: 'Аванс', amount: '80000.00' },
      { method: 'Зарплата', amount: '150000.10' },
      { method: 'Увольнения', amount: '22730.00' },
    ])).toEqual({ advance: '80000.00', salary: '172730.10', premium: null });
    expect(classifyCardPayouts(null)).toBeNull();
    expect(classifyCardPayouts([])).toBeNull();
  });
});
