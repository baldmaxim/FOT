import { describe, expect, it } from 'vitest';

import {
  buildPayrollCalc,
  mergeTermsSegments,
  prorateDailyKopeckCents,
  prorateToRubleCents,
  type ICalcTermsRow,
  type IPayrollCalcFacts,
} from './payroll-calc.rules.js';

const terms = (over: Partial<ICalcTermsRow> = {}): ICalcTermsRow => ({
  effective_from: '2026-07-01',
  effective_to: null,
  calc_type: 'salary',
  monthly_salary: '250000.00',
  bonus_amount: null,
  proration_rounding: 'ruble',
  ...over,
});

const august = (n: number): string[] => Array.from({ length: n }, (_, i) => `2026-08-${String(i + 3).padStart(2, '0')}`);

const facts = (over: Partial<IPayrollCalcFacts> = {}): IPayrollCalcFacts => ({
  monthStart: '2026-08-01',
  monthEnd: '2026-08-31',
  normDays: 21,
  workdayDates: august(11),
  dayoffDates: [],
  absenceDays: { vacation: 0, sick: 0, educational_leave: 0, unpaid: 0 },
  terms: [terms()],
  plannedSupplements: [],
  oneTimeTotal: null,
  rateAllowances: [],
  deductions: [],
  ...over,
});

const line = (result: ReturnType<typeof buildPayrollCalc>, code: string) => result.lines.find(item => item.code === code);

describe('«К выплате (ФОТ)»: пропорции как в ЗУП', () => {
  it('до рубля: 250 000 × 11/21 = 130 952,38 → 130 952', () => {
    expect(prorateToRubleCents(25_000_000, 11, 21)).toBe(13_095_200);
    expect(prorateToRubleCents(273_000, 18, 23)).toBe(213_700);
    expect(prorateToRubleCents(2_000_000, 19, 22)).toBe(1_727_300);
  });

  it('дневная ставка до копейки: 250 000 / 21 = 11 904,76 × 11 = 130 952,36', () => {
    expect(prorateDailyKopeckCents(25_000_000, 11, 21)).toBe(13_095_236);
  });
});

describe('«К выплате (ФОТ)»: оклад', () => {
  it('Абраменко, август: 11 из 21 дн. — до рубля или дневной ставкой по признаку условий', () => {
    expect(line(buildPayrollCalc(facts()), 'contract')).toEqual({
      code: 'contract', amount: '130952.00', days: { worked: 11, norm: 21 },
    });
    const daily = buildPayrollCalc(facts({ terms: [terms({ proration_rounding: 'daily_kopeck' })] }));
    expect(line(daily, 'contract')?.amount).toBe('130952.36');
  });

  it('полный месяц — оклад с премией как есть, с копейками', () => {
    const result = buildPayrollCalc(facts({
      normDays: 22,
      workdayDates: august(22),
      terms: [terms({ monthly_salary: '113100.50', bonus_amount: '61900.00' })],
    }));
    expect(line(result, 'contract')?.amount).toBe('175000.50');
  });

  it('рабочих сверх нормы — оклад полностью, лишний день — «Переработка»: 24 при норме 23', () => {
    const result = buildPayrollCalc(facts({ normDays: 23, workdayDates: august(24), terms: [terms({ monthly_salary: '260000.00' })] }));
    expect(line(result, 'contract')).toEqual({ code: 'contract', amount: '260000.00', days: { worked: 23, norm: 23 } });
    // 260 000 / 23 = 11 304,35 → 11 304.
    expect(line(result, 'overtime')).toEqual({ code: 'overtime', amount: '11304.00', days: { worked: 1, norm: 23 } });
  });

  it('выходы сначала добирают норму: 20 рабочих + 2 выхода при норме 21 — оклад 21/21 и один выход', () => {
    const result = buildPayrollCalc(facts({
      workdayDates: august(20),
      dayoffDates: ['2026-08-01', '2026-08-30'],
      terms: [terms({ monthly_salary: '120000.00' })],
    }));
    expect(line(result, 'contract')).toEqual({ code: 'contract', amount: '120000.00', days: { worked: 21, norm: 21 } });
    // Добирает норму первый выход (1-е), «Переработка» — 30-е: 120 000 / 21 = 5 714,29 → 5 714.
    expect(line(result, 'overtime')).toEqual({ code: 'overtime', amount: '5714.00', days: { worked: 1, norm: 21 } });
  });

  it('смена одной компенсации — один сегмент: сумма как без неё', () => {
    const split = [
      terms({ effective_to: '2026-08-10' }),
      terms({ effective_from: '2026-08-11' }),
    ];
    expect(mergeTermsSegments(split)).toHaveLength(1);
    expect(line(buildPayrollCalc(facts({ terms: split })), 'contract')?.amount).toBe('130952.00');
  });

  it('повышение с 11-го: каждый сегмент по своим дням и округляется отдельно', () => {
    const result = buildPayrollCalc(facts({
      workdayDates: august(11),
      terms: [
        terms({ effective_to: '2026-08-10', monthly_salary: '100000.00' }),
        terms({ effective_from: '2026-08-11', monthly_salary: '200000.00' }),
      ],
    }));
    // 3–10 августа — 8 дней × 100 000 / 21 = 38 095,24 → 38 095; 11–13 — 3 дня × 200 000 / 21 = 28 571,43 → 28 571.
    expect(line(result, 'contract')?.amount).toBe('66666.00');
  });

  it('почасовые условия — суммы нет, итог неполный', () => {
    const result = buildPayrollCalc(facts({ terms: [terms({ calc_type: 'hourly', monthly_salary: null })] }));
    expect(line(result, 'contract')?.amount).toBeNull();
    expect(result.missing).toContain('hourly');
  });

  it('нет условий на часть дней или вовсе — no_terms', () => {
    const gap = buildPayrollCalc(facts({ terms: [terms({ effective_from: '2026-08-10' })] }));
    expect(gap.missing).toContain('no_terms');
    const none = buildPayrollCalc(facts({ terms: [] }));
    expect(none.missing).toEqual(['no_terms']);
    expect(line(none, 'contract')).toBeUndefined();
  });

  it('нормы нет — суммы по дням не считаются, no_norm', () => {
    const result = buildPayrollCalc(facts({ normDays: 0 }));
    expect(result.missing).toEqual(['no_norm']);
    expect(result.lines).toEqual([]);
  });
});

describe('«К выплате (ФОТ)»: доплаты, выходы, удержания, итог', () => {
  it('плановая доплата — «Премиальная» пропорционально дням: 20 000 × 19/22 = 17 273', () => {
    const result = buildPayrollCalc(facts({
      normDays: 22,
      workdayDates: august(19),
      plannedSupplements: [{ amount: '20000.00', date_from: '2026-07-01', date_to: null }],
    }));
    expect(line(result, 'bonus')?.amount).toBe('17273.00');
  });

  it('выход в выходной — по окладу своей даты, одинарно: 92 000 / 23 × 4 = 16 000', () => {
    const result = buildPayrollCalc(facts({
      normDays: 23,
      workdayDates: august(23),
      dayoffDates: ['2026-08-01', '2026-08-08', '2026-08-15', '2026-08-22'],
      terms: [terms({ monthly_salary: '92000.00' })],
    }));
    expect(line(result, 'overtime')).toEqual({ code: 'overtime', amount: '16000.00', days: { worked: 4, norm: 23 } });
  });

  it('выходы в разных сегментах — каждый по своему окладу', () => {
    const result = buildPayrollCalc(facts({
      workdayDates: august(21),
      dayoffDates: ['2026-08-01', '2026-08-30'],
      terms: [
        terms({ effective_to: '2026-08-10', monthly_salary: '100000.00' }),
        terms({ effective_from: '2026-08-11', monthly_salary: '200000.00' }),
      ],
    }));
    // 100 000 / 21 = 4 761,90 → 4 762; 200 000 / 21 = 9 523,81 → 9 524.
    expect(line(result, 'overtime')?.amount).toBe('14286.00');
  });

  it('разовые доплаты, проезд, проживание и удержания по видам — в итог без НДФЛ', () => {
    const result = buildPayrollCalc(facts({
      normDays: 22,
      workdayDates: august(22),
      oneTimeTotal: '5000.00',
      rateAllowances: [
        { code: 'travel', amount: '2730.00', days: { worked: 22, norm: 22 } },
        { code: 'dormitory_allowance', amount: '160.00' },
      ],
      deductions: [
        { kind_id: 1, kind: 'Питание', amount: '3500.50' },
        { kind_id: 2, kind: 'Спецодежда', amount: '1200.00' },
      ],
    }));
    expect(result.lines.map(item => [item.code, item.amount])).toEqual([
      ['contract', '250000.00'],
      ['supplement', '5000.00'],
      ['travel', '2730.00'],
      ['housing', '160.00'],
    ]);
    expect(result.accrued).toBe('257890.00');
    expect(result.deducted).toBe('4700.50');
    expect(result.net).toBe('253189.50');
    expect(result.missing).toEqual([]);
  });

  it('отпуск и больничный — дни есть, суммы нет: итог неполный', () => {
    const result = buildPayrollCalc(facts({ absenceDays: { vacation: 14, sick: 2, educational_leave: 0, unpaid: 3 } }));
    expect(result.missing).toEqual(['vacation_pay', 'sick_pay']);
  });
});

describe('«К выплате (ФОТ)»: бригада', () => {
  const share = { amount: '141818.18', ktu: '1.5', countedMinutes: 10560, distribution: 'ok' as const };

  it('рабочий без оклада: доля по КТУ − удержания, «нет условий» не ставится', () => {
    const result = buildPayrollCalc(facts({
      workdayDates: [],
      terms: [],
      brigadeShares: [share],
      deductions: [{ kind_id: 1, kind: 'Питание', amount: '3500.00' }],
    }));
    expect(result.lines).toEqual([{ code: 'brigade', amount: '141818.18', brigade: { ktu: '1.5', hours: 176 } }]);
    expect(result.net).toBe('138318.18');
    expect(result.missing).toEqual([]);
  });

  it('выработка не введена — доли нет, итог неполный; ошибка расчёта бригады — своя пометка', () => {
    const noOutput = buildPayrollCalc(facts({ workdayDates: [], terms: [], brigadeShares: [{ ...share, amount: null, distribution: 'no_output' }] }));
    expect(noOutput.lines[0]).toMatchObject({ code: 'brigade', amount: null });
    expect(noOutput.missing).toEqual(['brigade_output']);
    const error = buildPayrollCalc(facts({ workdayDates: [], terms: [], brigadeShares: [{ ...share, amount: null, distribution: 'error' }] }));
    expect(error.missing).toEqual(['brigade_error']);
  });

  it('месяц из дней отдела и бригады: оклад за дни отдела + доля', () => {
    const result = buildPayrollCalc(facts({ workdayDates: august(11), brigadeShares: [share] }));
    expect(result.lines.map(item => [item.code, item.amount])).toEqual([
      ['contract', '130952.00'],
      ['brigade', '141818.18'],
    ]);
    expect(result.accrued).toBe('272770.18');
  });
});
