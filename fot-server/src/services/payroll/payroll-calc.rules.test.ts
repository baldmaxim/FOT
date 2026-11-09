import { describe, expect, it } from 'vitest';

import {
  brigadeShareFacts,
  buildPayrollCalc,
  hourlyAmountCents,
  mergeTermsSegments,
  prorateDailyKopeckCents,
  prorateMinutesCents,
  prorateToRubleCents,
  type IBrigadeShareFact,
  type ICalcTermsRow,
  type IPayrollCalcFacts,
  type IPayrollCalcLine,
} from './payroll-calc.rules.js';

const terms = (over: Partial<ICalcTermsRow> = {}): ICalcTermsRow => ({
  effective_from: '2026-07-01',
  effective_to: null,
  calc_type: 'salary',
  monthly_salary: '250000.00',
  hourly_rate: null,
  bonus_amount: null,
  proration_rounding: 'ruble',
  ...over,
});

const hourly = (rate: string, over: Partial<ICalcTermsRow> = {}): ICalcTermsRow => terms({
  calc_type: 'hourly', monthly_salary: null, hourly_rate: rate, ...over,
});

/** Минуты к оплате: у каждой даты — одно значение. */
const minutesOf = (dates: readonly string[], minutes = 600): Record<string, number> => (
  Object.fromEntries(dates.map(date => [date, minutes]))
);

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
  oneTimeItems: [],
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
    // Условия с июля — период части обрезан началом августа.
    expect(line(buildPayrollCalc(facts()), 'contract')).toEqual({
      code: 'contract',
      amount: '130952.00',
      days: { worked: 11, norm: 21 },
      parts: [{
        kind: 'salary', from: '2026-08-01', to: '2026-08-31', salary: '250000.00', bonus: '0.00', days: 11, norm: 21,
        rounding: 'ruble', amount: '130952.00',
      }],
    });
    const daily = buildPayrollCalc(facts({ terms: [terms({ proration_rounding: 'daily_kopeck' })] }));
    expect(line(daily, 'contract')?.amount).toBe('130952.36');
    expect(line(daily, 'contract')?.parts).toEqual([
      expect.objectContaining({ rounding: 'daily_kopeck', daily_rate: '11904.76', days: 11, amount: '130952.36' }),
    ]);
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
    expect(line(result, 'contract')).toMatchObject({
      code: 'contract', amount: '260000.00', days: { worked: 23, norm: 23 },
      parts: [{ kind: 'salary', rounding: 'whole', days: 23, norm: 23, amount: '260000.00' }],
    });
    expect(line(result, 'contract')?.filled_dayoffs).toBeUndefined();
    // 260 000 / 23 = 11 304,35 → 11 304.
    expect(line(result, 'overtime')).toEqual({
      code: 'overtime',
      amount: '11304.00',
      days: { worked: 1, norm: 23 },
      parts: [{
        kind: 'overtime_days', from: '2026-08-01', to: '2026-08-31', salary: '260000.00', days: 1, norm: 23,
        amount: '11304.00',
      }],
    });
  });

  it('выходы сначала добирают норму: 20 рабочих + 2 выхода при норме 21 — оклад 21/21 и один выход', () => {
    const result = buildPayrollCalc(facts({
      workdayDates: august(20),
      dayoffDates: ['2026-08-01', '2026-08-30'],
      terms: [terms({ monthly_salary: '120000.00' })],
    }));
    expect(line(result, 'contract')).toMatchObject({
      code: 'contract', amount: '120000.00', days: { worked: 21, norm: 21 }, filled_dayoffs: 1,
    });
    // Добирает норму первый выход (1-е), «Переработка» — 30-е: 120 000 / 21 = 5 714,29 → 5 714.
    expect(line(result, 'overtime')).toMatchObject({ code: 'overtime', amount: '5714.00', days: { worked: 1, norm: 21 } });
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
    expect(line(result, 'contract')?.parts).toEqual([
      expect.objectContaining({ from: '2026-08-01', to: '2026-08-10', salary: '100000.00', days: 8, amount: '38095.00' }),
      expect.objectContaining({ from: '2026-08-11', to: '2026-08-31', salary: '200000.00', days: 3, amount: '28571.00' }),
    ]);
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

describe('«К выплате (ФОТ)»: почасовая ставка', () => {
  it('Беляев, сентябрь: 250 ч × 730 = 182 500; норма дней и добор не участвуют', () => {
    const dates = august(25);
    const result = buildPayrollCalc(facts({
      normDays: 31,
      workdayDates: dates,
      paidMinutes: minutesOf(dates),
      terms: [hourly('730.0000')],
    }));
    expect(line(result, 'contract')).toEqual({
      code: 'contract',
      amount: '182500.00',
      days: { worked: 25, norm: 31 },
      hours: 250,
      parts: [{
        kind: 'hourly', from: '2026-08-01', to: '2026-08-31', rate: '730.0000', minutes: 15000, amount: '182500.00',
      }],
    });
    expect(result.missing).toEqual([]);
    expect(result.net).toBe('182500.00');
  });

  it('часы разной длины суммируются по дням: 10 ч и короткий день 6 ч', () => {
    const result = buildPayrollCalc(facts({
      workdayDates: ['2026-08-08', '2026-08-09'],
      paidMinutes: { '2026-08-08': 600, '2026-08-09': 360 },
      terms: [hourly('610.0000')],
    }));
    expect(line(result, 'contract')).toMatchObject({ amount: '9760.00', hours: 16 });
  });

  it('округление один раз на сегмент, половина вверх до копейки; ставка до 4 знаков', () => {
    expect(hourlyAmountCents(3000, 1)).toBe(1);
    expect(hourlyAmountCents(2999, 1)).toBe(0);
    // 730,1235 × 61 / 60 = 742,2922… → 742,29.
    expect(hourlyAmountCents(7_301_235, 61)).toBe(74_229);
    // Верх ставки NUMERIC(12,4) × месяц минут не теряет точность.
    expect(hourlyAmountCents(999_999_999_999, 44_640)).toBe(7_439_999_999_993);
    const result = buildPayrollCalc(facts({
      workdayDates: ['2026-08-08', '2026-08-09', '2026-08-10'],
      paidMinutes: { '2026-08-08': 20, '2026-08-09': 20, '2026-08-10': 20 },
      terms: [hourly('0.5000')],
    }));
    // По дням вышло бы 0,17 × 3 = 0,51; один раз на сегмент: 0,50 ₽/ч × 1 ч = 0,50.
    expect(line(result, 'contract')?.amount).toBe('0.50');
  });

  it('выход в выходной — те же часы, одинарно: «Переработки» нет', () => {
    const result = buildPayrollCalc(facts({
      normDays: 2,
      workdayDates: ['2026-08-10', '2026-08-11', '2026-08-12'],
      dayoffDates: ['2026-08-08'],
      paidMinutes: minutesOf(['2026-08-10', '2026-08-11', '2026-08-12'], 480),
      terms: [hourly('500.0000')],
    }));
    // Минут у выхода нет — сумма неизвестна, а не занижена.
    expect(result.missing).toEqual(['hourly']);
    const full = buildPayrollCalc(facts({
      normDays: 2,
      workdayDates: ['2026-08-10', '2026-08-11', '2026-08-12'],
      dayoffDates: ['2026-08-08'],
      paidMinutes: { ...minutesOf(['2026-08-10', '2026-08-11', '2026-08-12'], 480), '2026-08-08': 480 },
      terms: [hourly('500.0000')],
    }));
    expect(line(full, 'contract')).toMatchObject({ amount: '16000.00', days: { worked: 4, norm: 2 }, hours: 32 });
    expect(line(full, 'overtime')).toBeUndefined();
  });

  it('правка часов сверх нормы — только в сумме часов, переработкой второй раз не платится', () => {
    const result = buildPayrollCalc(facts({
      workdayDates: ['2026-08-10'],
      paidMinutes: { '2026-08-10': 660 },
      overtimeMinutes: { '2026-08-10': 60 },
      normMinutes: 10080,
      terms: [hourly('600.0000')],
    }));
    expect(line(result, 'contract')?.amount).toBe('6600.00');
    expect(line(result, 'overtime')).toBeUndefined();
    expect(result.net).toBe('6600.00');
  });

  it('две ставки в месяце — два сегмента, каждый по своим часам', () => {
    const dates = ['2026-08-10', '2026-08-11', '2026-08-20'];
    const result = buildPayrollCalc(facts({
      workdayDates: dates,
      paidMinutes: minutesOf(dates),
      terms: [hourly('600.0000', { effective_to: '2026-08-15' }), hourly('700.0000', { effective_from: '2026-08-16' })],
    }));
    expect(line(result, 'contract')?.amount).toBe('19000.00');
    expect(line(result, 'contract')?.parts).toEqual([
      expect.objectContaining({ kind: 'hourly', from: '2026-08-01', to: '2026-08-15', rate: '600.0000', minutes: 1200, amount: '12000.00' }),
      expect.objectContaining({ kind: 'hourly', from: '2026-08-16', to: '2026-08-31', rate: '700.0000', minutes: 600, amount: '7000.00' }),
    ]);
  });

  it('соседние строки с той же ставкой — один сегмент; с другой — два', () => {
    const same = [hourly('600.0000', { effective_to: '2026-08-15' }), hourly('600.0000', { effective_from: '2026-08-16' })];
    expect(mergeTermsSegments(same)).toHaveLength(1);
    const other = [hourly('600.0000', { effective_to: '2026-08-15' }), hourly('600.5000', { effective_from: '2026-08-16' })];
    expect(mergeTermsSegments(other)).toHaveLength(2);
  });

  it('оклад → часы: оклад за свои дни, часы за свои, сумма одной строкой', () => {
    const dates = august(22);
    const result = buildPayrollCalc(facts({
      normDays: 22,
      workdayDates: dates,
      paidMinutes: minutesOf(dates),
      terms: [
        terms({ effective_to: '2026-08-15', monthly_salary: '220000.00' }),
        hourly('500.0000', { effective_from: '2026-08-16' }),
      ],
    }));
    // 3–15 августа — 13 дней × 220 000 / 22 = 130 000; 16–24 — 9 дней × 10 ч × 500 = 45 000.
    expect(line(result, 'contract')).toMatchObject({ amount: '175000.00', days: { worked: 22, norm: 22 }, hours: 90 });
    expect(line(result, 'overtime')).toBeUndefined();
    expect(result.net).toBe('175000.00');
  });

  it('часы → оклад: ранние почасовые дни не вытесняют окладные в переработку', () => {
    const dates = august(28);
    const result = buildPayrollCalc(facts({
      normDays: 22,
      workdayDates: dates,
      paidMinutes: minutesOf(dates),
      terms: [
        hourly('500.0000', { effective_to: '2026-08-15' }),
        terms({ effective_from: '2026-08-16', monthly_salary: '220000.00' }),
      ],
    }));
    // 3–15 — 13 дней × 10 ч × 500 = 65 000; 16–30 — 15 окладных из нормы 22: 150 000, все в окладе.
    expect(line(result, 'contract')?.parts).toEqual([
      expect.objectContaining({ kind: 'hourly', minutes: 7800, amount: '65000.00' }),
      expect.objectContaining({ kind: 'salary', days: 15, norm: 22, amount: '150000.00' }),
    ]);
    expect(line(result, 'contract')?.amount).toBe('215000.00');
    expect(line(result, 'overtime')).toBeUndefined();
  });

  it('чистому почасовому месяцу норма дней не нужна; окладным датам — нужна', () => {
    const dates = august(5);
    const hourlyOnly = buildPayrollCalc(facts({
      normDays: null, workdayDates: dates, paidMinutes: minutesOf(dates), terms: [hourly('500.0000')],
    }));
    expect(hourlyOnly.missing).toEqual([]);
    expect(line(hourlyOnly, 'contract')).toMatchObject({ amount: '25000.00', days: { worked: 5, norm: null } });
    const mixed = buildPayrollCalc(facts({
      normDays: null,
      workdayDates: dates,
      paidMinutes: minutesOf(dates),
      terms: [terms({ effective_to: '2026-08-04' }), hourly('500.0000', { effective_from: '2026-08-05' })],
    }));
    expect(mixed.missing).toEqual(['no_norm']);
    expect(mixed.net).toBeNull();
  });

  it('нет минут у даты или у всей основы (до 344) — ⚠, итог неизвестен, частичная сумма не выдаётся', () => {
    const noBasis = buildPayrollCalc(facts({ paidMinutes: null, terms: [hourly('500.0000')] }));
    expect(line(noBasis, 'contract')?.amount).toBeNull();
    expect(noBasis.missing).toEqual(['hourly']);
    expect(noBasis.net).toBeNull();
    const noField = buildPayrollCalc(facts({ terms: [hourly('500.0000')] }));
    expect(noField.missing).toEqual(['hourly']);
    const noDate = buildPayrollCalc(facts({
      workdayDates: ['2026-08-10', '2026-08-11'],
      paidMinutes: { '2026-08-10': 600 },
      terms: [hourly('500.0000')],
    }));
    expect(noDate.missing).toEqual(['hourly']);
    expect(noDate.net).toBeNull();
    // Окладника отсутствие минут не касается.
    expect(buildPayrollCalc(facts({ paidMinutes: null })).missing).toEqual([]);
  });

  it('все почасовые даты в бригаде — ⚠ нет, дважды не платится: оплачивает доля', () => {
    const share: IBrigadeShareFact = {
      departmentId: 'brigade-1',
      amount: '90000.00',
      ktu: '1.0',
      countedMinutes: 9600,
      distribution: 'ok',
      output: '900000.00',
      objects: [],
      whole: null,
      workedDates: [],
    };
    // Дни бригады уже сняты с дат и минут в сервисе.
    const allInBrigade = buildPayrollCalc(facts({
      workdayDates: [], paidMinutes: null, brigadeShares: [share], terms: [hourly('500.0000')],
    }));
    expect(allInBrigade.missing).toEqual([]);
    expect(line(allInBrigade, 'contract')).toBeUndefined();
    expect(allInBrigade.net).toBe('90000.00');
    const partly = buildPayrollCalc(facts({
      workdayDates: ['2026-08-20'], paidMinutes: { '2026-08-20': 600 }, brigadeShares: [share], terms: [hourly('500.0000')],
    }));
    expect(partly.net).toBe('95000.00');
  });

  it('«Без переработки»: на 6-часовом дне правка 8 ч → 8 ч, 9 ч → 8 ч; выход в выходной не оплачивается', () => {
    const stop = [{ date_from: '2026-08-01', date_to: null }];
    const eight = buildPayrollCalc(facts({
      workdayDates: ['2026-08-09'], paidMinutes: { '2026-08-09': 480 }, overtimeMinutes: {}, overtimeStops: stop, terms: [hourly('600.0000')],
    }));
    expect(line(eight, 'contract')?.amount).toBe('4800.00');
    const nine = buildPayrollCalc(facts({
      workdayDates: ['2026-08-09'], paidMinutes: { '2026-08-09': 540 }, overtimeMinutes: { '2026-08-09': 60 }, overtimeStops: stop, terms: [hourly('600.0000')],
    }));
    expect(line(nine, 'contract')?.amount).toBe('4800.00');
    const dayoff = buildPayrollCalc(facts({
      workdayDates: ['2026-08-10'],
      dayoffDates: ['2026-08-08'],
      paidMinutes: { '2026-08-10': 480, '2026-08-08': 480 },
      overtimeStops: stop,
      terms: [hourly('600.0000')],
    }));
    expect(line(dayoff, 'contract')).toMatchObject({ amount: '4800.00', hours: 8 });
  });

  it('плановая доплата — × почасовые дни / норма, не больше нормы', () => {
    const dates = august(11);
    const result = buildPayrollCalc(facts({
      normDays: 22,
      workdayDates: dates,
      paidMinutes: minutesOf(dates),
      terms: [hourly('500.0000')],
      plannedSupplements: [{ amount: '20000.00', date_from: '2026-07-01', date_to: null }],
    }));
    expect(line(result, 'bonus')?.amount).toBe('10000.00');
    const over = buildPayrollCalc(facts({
      normDays: 2,
      workdayDates: dates,
      paidMinutes: minutesOf(dates),
      terms: [hourly('500.0000')],
      plannedSupplements: [{ amount: '20000.00', date_from: '2026-07-01', date_to: null }],
    }));
    expect(line(over, 'bonus')).toMatchObject({ amount: '20000.00', days: { worked: 2, norm: 2 } });
    const noNorm = buildPayrollCalc(facts({
      normDays: null,
      workdayDates: dates,
      paidMinutes: minutesOf(dates),
      terms: [hourly('500.0000')],
      plannedSupplements: [{ amount: '20000.00', date_from: '2026-07-01', date_to: null }],
    }));
    expect(noNorm.missing).toEqual(['no_norm']);
  });

  it('премиальная часть почасовых условий в сумму не идёт', () => {
    const dates = august(1);
    const result = buildPayrollCalc(facts({
      workdayDates: dates, paidMinutes: minutesOf(dates), terms: [hourly('500.0000', { bonus_amount: '10000.00' })],
    }));
    expect(line(result, 'contract')?.amount).toBe('5000.00');
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
    expect(line(result, 'overtime')).toMatchObject({ code: 'overtime', amount: '16000.00', days: { worked: 4, norm: 23 } });
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
      oneTimeItems: [{ reason: 'Премия', amount: '5000.00' }],
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

describe('«К выплате (ФОТ)»: отпускные и больничные из 1С', () => {
  const september = (n: number): string[] => Array.from({ length: n }, (_, i) => `2026-09-${String(i + 10).padStart(2, '0')}`);
  // Гринёв, сентябрь 2026: оклад 180 000 × 16 / 24 + проезд 1 820, отпуск 9 дн., ведомость «Отпуска» 59 709,13.
  const grinev = (over: Partial<IPayrollCalcFacts> = {}): IPayrollCalcFacts => facts({
    monthStart: '2026-09-01',
    monthEnd: '2026-09-30',
    normDays: 24,
    workdayDates: september(16),
    absenceDays: { vacation: 9, sick: 0, educational_leave: 0, unpaid: 0 },
    terms: [terms({ effective_from: '2026-01-01', monthly_salary: '180000.00' })],
    rateAllowances: [{ code: 'travel', amount: '1820.00', days: { worked: 16, norm: 24 } }],
    ...over,
  });
  const vacationPayout = { doc_number: '0000-002319', doc_date: '2026-09-02', amount: '59709.13' };

  it('нет сумм 1С — как раньше: дней отпуска нет в итоге', () => {
    const result = buildPayrollCalc(grinev());
    expect(line(result, 'vacation')).toBeUndefined();
    expect(result.missing).toEqual(['vacation_pay']);
    expect(result.net).toBe('121820.00');
  });

  it('ведомость «Отпуска» — строка с днями, в «Начислено» и итоге, без «отпускные» в missing', () => {
    const result = buildPayrollCalc(grinev({ absencePay1c: [{ code: 'vacation', paid: null, payouts: [vacationPayout] }] }));
    expect(line(result, 'vacation')).toEqual({
      code: 'vacation',
      amount: '59709.13',
      days: { worked: 9, norm: null },
      parts: [{ kind: 'payout_1c', doc_number: '0000-002319', doc_date: '2026-09-02', amount: '59709.13' }],
    });
    expect(result.accrued).toBe('181529.13');
    expect(result.net).toBe('181529.13');
    expect(result.missing).toEqual([]);
  });

  it('строка «Оплачено» есть — берётся она, даже 0; ведомости — нет', () => {
    const paid = buildPayrollCalc(grinev({
      absencePay1c: [{ code: 'vacation', paid: '68631.18', payouts: [vacationPayout] }],
    }));
    expect(line(paid, 'vacation')?.parts).toEqual([{ kind: 'paid_1c', amount: '68631.18' }]);
    expect(paid.net).toBe('190451.18');
    const zero = buildPayrollCalc(grinev({ absencePay1c: [{ code: 'vacation', paid: '0.00', payouts: [vacationPayout] }] }));
    expect(line(zero, 'vacation')?.amount).toBe('0.00');
    expect(zero.missing).toEqual([]);
    expect(zero.net).toBe('121820.00');
  });

  it('несколько ведомостей — часть на документ; без дней отсутствия — строка без дней', () => {
    const result = buildPayrollCalc(grinev({
      absenceDays: { vacation: 0, sick: 0, educational_leave: 0, unpaid: 0 },
      absencePay1c: [{
        code: 'vacation',
        paid: null,
        payouts: [vacationPayout, { doc_number: '0000-002319', doc_date: '2026-09-20', amount: '1000.5' }],
      }],
    }));
    const vacation = line(result, 'vacation')!;
    expect(vacation.amount).toBe('60709.63');
    expect(vacation.days).toBeUndefined();
    expect(vacation.parts?.map(part => part.amount)).toEqual(['59709.13', '1000.50']);
    expect(result.net).toBe('182529.63');
  });

  it('больничный — так же; отпуск без сумм 1С остаётся в missing', () => {
    const result = buildPayrollCalc(grinev({
      absenceDays: { vacation: 9, sick: 3, educational_leave: 2, unpaid: 0 },
      absencePay1c: [
        { code: 'sick_leave', paid: null, payouts: [{ doc_number: '0000-002400', doc_date: '2026-09-25', amount: '4500.00' }] },
        { code: 'vacation', paid: null, payouts: [] },
      ],
    }));
    expect(line(result, 'sick_leave')).toMatchObject({ amount: '4500.00', days: { worked: 3, norm: null } });
    expect(line(result, 'vacation')).toBeUndefined();
    expect(result.missing).toEqual(['vacation_pay', 'educational_pay']);
    expect(result.net).toBe('126320.00');
  });

  it('итог неизвестен (выработка бригады не внесена) — отпускные его не восстанавливают', () => {
    const result = buildPayrollCalc(grinev({
      workdayDates: [],
      terms: [],
      rateAllowances: [],
      brigadeShares: [{
        departmentId: 'b1', amount: null, ktu: '1.0', countedMinutes: 0, distribution: 'no_output', output: null, objects: [],
      }],
      absencePay1c: [{ code: 'vacation', paid: null, payouts: [vacationPayout] }],
    }));
    expect(line(result, 'vacation')?.amount).toBe('59709.13');
    expect(result.net).toBeNull();
  });
});

describe('«К выплате (ФОТ)»: бригада', () => {
  const share: IBrigadeShareFact = {
    departmentId: 'b1', amount: '141818.18', ktu: '1.5', countedMinutes: 10560, distribution: 'ok',
    output: '500000.00',
    whole: null,
    objects: [{
      objectKey: 'wave', objectName: 'ЖК Wave', output: '500000.00', countedMinutes: 10560, weight: 158_400,
      totalWeight: 558_462, amount: '141818.18',
    }],
  };

  it('рабочий без оклада: доля по КТУ − удержания, «нет условий» не ставится', () => {
    const result = buildPayrollCalc(facts({
      workdayDates: [],
      terms: [],
      brigadeShares: [share],
      deductions: [{ kind_id: 1, kind: 'Питание', amount: '3500.00' }],
    }));
    expect(result.lines).toEqual([{
      code: 'brigade',
      amount: '141818.18',
      brigade: { ktu: '1.5', hours: 176 },
      parts: [{
        kind: 'brigade', department_id: 'b1', object_key: 'wave', object_name: 'ЖК Wave', output: '500000.00',
        ktu_tenths: 15, counted_minutes: 10560, weight: 158_400, total_weight: 558_462, amount: '141818.18',
      }],
    }]);
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

  it('доля по двум объектам — часть на объект, Σ частей = строка', () => {
    const twoObjects: IBrigadeShareFact = {
      ...share,
      amount: '150000.00',
      objects: [
        { objectKey: 'stories', objectName: 'ЖК Stories', output: '50000.00', countedMinutes: 600, weight: 9_000, totalWeight: 18_000, amount: '25000.00' },
        { objectKey: 'wave', objectName: 'ЖК Wave', output: '500000.00', countedMinutes: 9960, weight: 149_400, totalWeight: 597_600, amount: '125000.00' },
      ],
    };
    const result = buildPayrollCalc(facts({ workdayDates: [], terms: [], brigadeShares: [twoObjects] }));
    const brigade = result.lines[0];
    expect(brigade.amount).toBe('150000.00');
    expect(brigade.parts?.map(part => (part.kind === 'brigade' ? [part.object_name, part.amount] : null))).toEqual([
      ['ЖК Stories', '25000.00'],
      ['ЖК Wave', '125000.00'],
    ]);
    expect(result.net).toBe('150000.00');
  });

  it('на одном из объектов выработка не внесена — строка «—», а не сумма известной части', () => {
    const partial: IBrigadeShareFact = {
      ...share,
      amount: null,
      distribution: 'no_output',
      objects: [
        { objectKey: 'stories', objectName: 'ЖК Stories', output: null, countedMinutes: 600, weight: 9_000, totalWeight: 18_000, amount: null },
        { objectKey: 'wave', objectName: 'ЖК Wave', output: '500000.00', countedMinutes: 9960, weight: 149_400, totalWeight: 597_600, amount: '125000.00' },
      ],
    };
    const result = buildPayrollCalc(facts({ workdayDates: [], terms: [], brigadeShares: [partial] }));
    expect(result.lines[0].amount).toBeNull();
    expect(result.lines[0].parts?.map(part => part.amount)).toEqual([null, '125000.00']);
    expect(result.missing).toEqual(['brigade_output']);
    expect(result.net).toBeNull();
  });

  it('без учтённых часов на объектах — одна часть бригады без объекта', () => {
    const idle: IBrigadeShareFact = { ...share, amount: '0.00', countedMinutes: 0, objects: [] };
    const result = buildPayrollCalc(facts({ workdayDates: [], terms: [], brigadeShares: [idle] }));
    expect(result.lines[0].parts).toEqual([{
      kind: 'brigade', department_id: 'b1', object_key: null, object_name: null, output: '500000.00',
      ktu_tenths: 15, counted_minutes: 0, weight: 0, total_weight: 0, amount: '0.00',
    }]);
    expect(result.net).toBe('0.00');
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

describe('«К выплате (ФОТ)»: переработка в будни по корректировкам', () => {
  it('Абраменко, август: 6 ч × 250 000 / 168 = 8 928,57, как ЗУП', () => {
    expect(prorateMinutesCents(25_000_000, 360, 10_080)).toBe(892_857);
    const result = buildPayrollCalc(facts({
      normMinutes: 10_080,
      overtimeMinutes: { '2026-08-04': 180, '2026-08-13': 180 },
    }));
    expect(line(result, 'overtime')).toEqual({
      code: 'overtime',
      amount: '8928.57',
      days: { worked: 0, norm: 21 },
      hours: 6,
      parts: [{
        kind: 'overtime_hours', from: '2026-08-01', to: '2026-08-31', salary: '250000.00', minutes: 360,
        norm_minutes: 10_080, amount: '8928.57',
      }],
    });
  });

  it('выходы днями и часы в будни — одна строка «Переработка»', () => {
    const result = buildPayrollCalc(facts({
      normDays: 21,
      normMinutes: 10_080,
      workdayDates: august(21),
      dayoffDates: ['2026-08-30'],
      terms: [terms({ monthly_salary: '168000.00' })],
      overtimeMinutes: { '2026-08-04': 120 },
    }));
    // Выход: 168 000 / 21 = 8 000; 2 ч: 168 000 × 120 / 10 080 = 2 000.
    expect(line(result, 'overtime')).toMatchObject({
      code: 'overtime', amount: '10000.00', days: { worked: 1, norm: 21 }, hours: 2,
      parts: [
        { kind: 'overtime_days', days: 1, amount: '8000.00' },
        { kind: 'overtime_hours', minutes: 120, amount: '2000.00' },
      ],
    });
  });

  it('часы — по окладу своей даты; нормы часов нет — no_norm', () => {
    const split = buildPayrollCalc(facts({
      normMinutes: 10_080,
      overtimeMinutes: { '2026-08-04': 60, '2026-08-12': 60 },
      terms: [
        terms({ effective_to: '2026-08-10', monthly_salary: '100800.00' }),
        terms({ effective_from: '2026-08-11', monthly_salary: '201600.00' }),
      ],
    }));
    // 100 800 / 168 = 600 и 201 600 / 168 = 1 200.
    expect(line(split, 'overtime')?.amount).toBe('1800.00');
    const noNorm = buildPayrollCalc(facts({ normMinutes: null, overtimeMinutes: { '2026-08-04': 60 } }));
    expect(noNorm.missing).toContain('no_norm');
    expect(line(noNorm, 'overtime')).toBeUndefined();
  });
});


describe('«К выплате (ФОТ)»: «Без переработки»', () => {
  // Август 2026: 1-е — суббота, будней 21. Не вышел 6 и 7-го: 19 будней, норму добирают выходы 1 и 8-го;
  // выходы 15, 22 и 29-го — сверх нормы. Часы корректировок: 4-го — 2 ч, 12-го — 1 ч, 24-го — 1 ч.
  const weekdays = ['03', '04', '05', '10', '11', '12', '13', '14', '17', '18', '19', '20', '21', '24', '25', '26',
    '27', '28', '31'].map(day => `2026-08-${day}`);
  const overtimeFacts = (over: Partial<IPayrollCalcFacts> = {}): IPayrollCalcFacts => facts({
    normDays: 21,
    normMinutes: 10_080,
    workdayDates: weekdays,
    dayoffDates: ['2026-08-01', '2026-08-08', '2026-08-15', '2026-08-22', '2026-08-29'],
    terms: [terms({ monthly_salary: '168000.00' })],
    overtimeMinutes: { '2026-08-04': 120, '2026-08-12': 60, '2026-08-24': 60 },
    ...over,
  });

  it('без периода — как прежде: 3 выхода × 8 000 + 4 ч × 1 000', () => {
    const result = buildPayrollCalc(overtimeFacts());
    expect(line(result, 'overtime')).toMatchObject({ code: 'overtime', amount: '28000.00', days: { worked: 3, norm: 21 }, hours: 4 });
    expect(result.net).toBe('196000.00');
  });

  it('период на весь месяц — строки «Переработка» нет, выходы-добор остаются в окладе', () => {
    const result = buildPayrollCalc(overtimeFacts({ overtimeStops: [{ date_from: '2026-08-01', date_to: null }] }));
    expect(result.lines).toMatchObject([{ code: 'contract', amount: '168000.00', days: { worked: 21, norm: 21 } }]);
    expect(result.lines).toHaveLength(1);
    expect(result.net).toBe('168000.00');
    expect(result.missing).toEqual([]);
  });

  it('часть месяца (по — включительно): снимаются выходы и часы только своих дат', () => {
    const result = buildPayrollCalc(overtimeFacts({ overtimeStops: [{ date_from: '2026-08-08', date_to: '2026-08-22' }] }));
    // Выход 8-го — добор нормы, он в окладе; 15 и 22-го сняты, 29-го — 8 000. Часы: 4-го и 24-го — 3 ч = 3 000.
    expect(line(result, 'contract')).toMatchObject({ code: 'contract', amount: '168000.00', days: { worked: 21, norm: 21 } });
    expect(line(result, 'overtime')).toMatchObject({ code: 'overtime', amount: '11000.00', days: { worked: 1, norm: 21 }, hours: 3 });
    expect(result.net).toBe('179000.00');
  });

  it('снятая переработка не даёт пометок «нет нормы часов», «нет условий», «почасовая»', () => {
    const late = { normDays: 5, workdayDates: august(5), dayoffDates: ['2026-08-30'], normMinutes: null,
      overtimeMinutes: { '2026-08-25': 60 } };
    const stop = { overtimeStops: [{ date_from: '2026-08-21', date_to: null }] };
    // Условия до 20-го: выход 30-го и часы 25-го без условий и без нормы часов.
    const noTerms = facts({ ...late, terms: [terms({ effective_to: '2026-08-20' })] });
    expect(buildPayrollCalc(noTerms).missing).toEqual(expect.arrayContaining(['no_terms', 'no_norm']));
    expect(buildPayrollCalc({ ...noTerms, ...stop }).missing).toEqual([]);
    // С 21-го почасовые условия: выход 30-го почасовой, минут нет; часы переработки 25-го — не переработка.
    const hourly = facts({ ...late, terms: [
      terms({ effective_to: '2026-08-20' }),
      terms({ effective_from: '2026-08-21', calc_type: 'hourly', monthly_salary: null, hourly_rate: '500.0000' }),
    ] });
    expect(buildPayrollCalc(hourly).missing).toEqual(['hourly']);
    const stopped = buildPayrollCalc({ ...hourly, ...stop });
    expect(stopped.missing).toEqual([]);
    expect(line(stopped, 'overtime')).toBeUndefined();
  });
});

describe('«К выплате (ФОТ)»: нет дней в табеле', () => {
  const noDays = { workdayDates: [], dayoffDates: [] };
  const absent = (over: Partial<IPayrollCalcFacts['absenceDays']>) => ({
    absenceDays: { vacation: 0, sick: 0, educational_leave: 0, unpaid: 0, ...over },
  });

  it('условия есть, дней нет — итог 0,00 и причина, а не прочерк', () => {
    expect(buildPayrollCalc(facts(noDays))).toMatchObject({ lines: [], net: '0.00', missing: ['no_days'] });
  });

  it('только разовая доплата — сумма остаётся, причина тоже', () => {
    expect(buildPayrollCalc(facts({ ...noDays, oneTimeItems: [{ reason: 'Премия', amount: '25000.00' }] }))).toMatchObject({
      net: '25000.00', missing: ['no_days'],
    });
  });

  it.each([
    ['есть рабочие дни', {}],
    ['есть выход', { workdayDates: [], dayoffDates: ['2026-08-08'] }],
    ['есть переработка', { ...noDays, overtimeMinutes: { '2026-08-03': 60 } }],
    ['отпуск', { ...noDays, ...absent({ vacation: 3 }) }],
    ['больничный', { ...noDays, ...absent({ sick: 2 }) }],
    ['учебный отпуск', { ...noDays, ...absent({ educational_leave: 1 }) }],
    ['без содержания', { ...noDays, ...absent({ unpaid: 22 }) }],
    ['нет условий', { ...noDays, terms: [] }],
    ['условия начались позже месяца', { ...noDays, terms: [terms({ effective_from: '2026-09-01' })] }],
    ['бригада', {
      ...noDays,
      brigadeShares: [{
        departmentId: 'b1', amount: null, ktu: '1.0', countedMinutes: 0, distribution: 'no_output', output: null,
        objects: [], whole: null, workedDates: [],
      } satisfies IBrigadeShareFact],
    }],
  ] satisfies Array<[string, Partial<IPayrollCalcFacts>]>)('%s — причины нет', (_name, over) => {
    expect(buildPayrollCalc(facts(over)).missing).not.toContain('no_days');
  });
});

describe('«К выплате (ФОТ)»: части строк и неизвестный итог', () => {
  const brigadeShare = (over: Partial<IBrigadeShareFact> = {}): IBrigadeShareFact => ({
    departmentId: 'b1', amount: '100000.00', ktu: '1.0', countedMinutes: 9_600, distribution: 'ok',
    output: '300000.00',
    objects: [{
      objectKey: 'wave', objectName: 'ЖК Wave', output: '300000.00', countedMinutes: 9_600, weight: 96_000,
      totalWeight: 288_000, amount: over.amount === undefined ? '100000.00' : over.amount,
    }],
    ...over,
  });

  /** Сумма известных частей строки в копейках. */
  const partsCents = (item: IPayrollCalcLine): number => (item.parts ?? [])
    .reduce((sum, part) => sum + (part.amount === null ? 0 : Math.round(Number(part.amount) * 100)), 0);

  it('сумма известных частей = сумма строки: сегменты, премиальная, переработка, проезд, проживание, разовая', () => {
    const result = buildPayrollCalc(facts({
      normDays: 21,
      normMinutes: 10_080,
      workdayDates: august(20),
      dayoffDates: ['2026-08-01', '2026-08-29', '2026-08-30'],
      terms: [
        terms({ effective_to: '2026-08-14', monthly_salary: '100000.00', bonus_amount: '15000.00' }),
        terms({ effective_from: '2026-08-15', monthly_salary: '130000.00', proration_rounding: 'daily_kopeck' }),
      ],
      overtimeMinutes: { '2026-08-04': 90, '2026-08-20': 45 },
      plannedSupplements: [{ amount: '20000.00', date_from: '2026-08-10', date_to: null }],
      oneTimeItems: [{ reason: 'Премия', amount: '5000.00' }],
      rateAllowances: [
        { code: 'travel', amount: '2600.00', days: { worked: 20, norm: 21 }, rate: '2730.00' },
        { code: 'housing', amount: '15000.00' },
      ],
    }));
    expect(result.lines.map(item => item.code)).toEqual(['contract', 'bonus', 'overtime', 'supplement', 'travel', 'housing']);
    for (const item of result.lines) {
      expect(item.parts?.length, item.code).toBeGreaterThan(0);
      expect(partsCents(item), item.code).toBe(Math.round(Number(item.amount) * 100));
    }
    // Выход 1-го добирает норму; 29 и 30-го — переработка во втором сегменте; часы 4-го и 20-го — по своим сегментам.
    expect(line(result, 'overtime')?.parts).toMatchObject([
      { kind: 'overtime_days', from: '2026-08-15', to: '2026-08-31', salary: '130000.00', days: 2 },
      { kind: 'overtime_hours', from: '2026-08-01', to: '2026-08-14', salary: '100000.00', minutes: 90 },
      { kind: 'overtime_hours', from: '2026-08-15', to: '2026-08-31', salary: '130000.00', minutes: 45 },
    ]);
    expect(line(result, 'contract')?.filled_dayoffs).toBe(1);
    expect(line(result, 'travel')?.parts).toEqual([{ kind: 'travel', rate: '2730.00', days: 20, norm: 21, amount: '2600.00' }]);
    expect(line(result, 'housing')?.parts).toEqual([{ kind: 'housing', housing: 'apartment', amount: '15000.00' }]);
    expect(line(result, 'supplement')?.parts).toEqual([{ kind: 'one_time', amount: '5000.00', reason: 'Премия' }]);
    expect(line(result, 'bonus')?.parts).toEqual([
      expect.objectContaining({ kind: 'planned_supplement', from: '2026-08-10', to: '2026-08-31', base: '20000.00' }),
    ]);
    expect(result.net).not.toBeNull();
  });

  it('доплата за общежитие — часть «общежитие»', () => {
    const result = buildPayrollCalc(facts({ rateAllowances: [{ code: 'dormitory_allowance', amount: '160.00' }] }));
    expect(line(result, 'housing')?.parts).toEqual([{ kind: 'housing', housing: 'dormitory', amount: '160.00' }]);
  });

  it.each([
    ['hourly', facts({ terms: [terms({ calc_type: 'hourly', monthly_salary: null })] })],
    ['no_terms', facts({ terms: [terms({ effective_from: '2026-08-10' })] })],
    ['no_norm', facts({ normDays: 0 })],
    ['brigade_output', facts({ workdayDates: [], terms: [], brigadeShares: [brigadeShare({ amount: null, distribution: 'no_output', output: null })] })],
    ['brigade_error', facts({ workdayDates: [], terms: [], brigadeShares: [brigadeShare({ amount: null, distribution: 'error' })] })],
  ])('%s — итог неизвестен (net null), начислено — только известная часть', (reason, input) => {
    const result = buildPayrollCalc(input);
    expect(result.missing).toContain(reason);
    expect(result.net).toBeNull();
  });

  it('отпуск — итог есть: отпускные считает 1С, это не неизвестная сумма', () => {
    const result = buildPayrollCalc(facts({ absenceDays: { vacation: 5, sick: 0, educational_leave: 0, unpaid: 0 } }));
    expect(result.missing).toEqual(['vacation_pay']);
    expect(result.net).toBe('130952.00');
  });

  it('две бригады: одна посчитана, у другой выработки нет — строка «—», итог неизвестен', () => {
    const result = buildPayrollCalc(facts({
      workdayDates: [],
      terms: [],
      brigadeShares: [
        brigadeShare(),
        brigadeShare({ departmentId: 'b2', amount: null, distribution: 'no_output', output: null }),
      ],
    }));
    const brigade = line(result, 'brigade')!;
    expect(brigade.amount).toBeNull();
    expect(brigade.parts?.map(part => part.amount)).toEqual(['100000.00', null]);
    expect(partsCents(brigade)).toBe(10_000_000);
    expect(result.missing).toEqual(['brigade_output']);
    expect(result.net).toBeNull();
    expect(result.accrued).toBe('0.00');
  });
});

describe('brigadeShareFacts — доли бригады по объектам с весами', () => {
  const objects = [
    { object_key: 'stories', object_name: 'ЖК Stories', output: '50000.00', total_weight: 18_000 },
    { object_key: 'wave', object_name: 'ЖК Wave', output: '100000.00', total_weight: 259_455 },
    { object_key: '__unknown_object__', object_name: 'Не определён', output: null, total_weight: 0 },
  ];

  it('объекты с учтёнными минутами сотрудника — с выработкой, весом и Σ весов объекта из того же расчёта', () => {
    const facts = brigadeShareFacts('b1', 'ok', [
      {
        employee_id: 1, ktu: '1.5', counted_minutes: 10_595, amount: '61234.57',
        objects: [{ object_key: 'wave', counted_minutes: 10_595, weight: 158_925, amount: '61234.57' }],
      },
      {
        employee_id: 2, ktu: '1.0', counted_minutes: 10_053, amount: '38765.43',
        objects: [
          {
            object_key: 'wave', counted_minutes: 10_053, weight: 100_530, amount: '38765.43',
            days: { '2026-08-03': 8, '2026-08-04': 0 },
          },
          // Часы только для показа (минут нет) — в расшифровку доли не идут, но день с часами — день в бригаде.
          {
            object_key: '__unknown_object__', counted_minutes: 0, weight: 0, amount: null,
            days: { '2026-08-01': 4, '2026-08-03': 2 },
          },
        ],
      },
    ], objects);
    expect(facts.get(1)).toMatchObject({ departmentId: 'b1', output: '150000.00', distribution: 'ok' });
    expect(facts.get(2)?.objects).toEqual([{
      objectKey: 'wave', objectName: 'ЖК Wave', output: '100000.00', countedMinutes: 10_053, weight: 100_530,
      totalWeight: 259_455, amount: '38765.43',
    }]);
    // Дни с часами в бригаде (доплата за общежитие, миграция 339): без нулевых, без повторов, по порядку.
    expect(facts.get(2)?.workedDates).toEqual(['2026-08-01', '2026-08-03']);
    expect(facts.get(1)?.workedDates).toEqual([]);
    const result = buildPayrollCalc({
      monthStart: '2026-08-01', monthEnd: '2026-08-31', normDays: null, workdayDates: [], dayoffDates: [],
      absenceDays: { vacation: 0, sick: 0, educational_leave: 0, unpaid: 0 }, terms: [], plannedSupplements: [],
      oneTimeItems: [], rateAllowances: [], deductions: [], brigadeShares: [facts.get(1)!],
    });
    expect(result.lines[0].parts).toEqual([expect.objectContaining({
      object_name: 'ЖК Wave', weight: 158_925, total_weight: 259_455, counted_minutes: 10_595,
    })]);
  });

  it('ничего не внесено — output null', () => {
    const rows = [{ employee_id: 1, ktu: '1.0', counted_minutes: 0, amount: null, objects: [] }];
    expect(brigadeShareFacts('b1', 'no_output', rows, []).get(1)).toMatchObject({ output: null, distribution: 'no_output' });
  });

  it('сумма бригаде (341): без объектов в расшифровке, вес — КТУ × минуты за месяц, Σ — по всем строкам', () => {
    const rows = [
      {
        employee_id: 1, ktu: '1.5', counted_minutes: 600, amount: '750000.00',
        objects: [
          { object_key: 'wave', counted_minutes: 400, weight: 6_000, amount: null, days: { '2026-10-01': 7 } },
          { object_key: 'stories', counted_minutes: 200, weight: 3_000, amount: null, days: { '2026-10-02': 4 } },
        ],
      },
      {
        employee_id: 2, ktu: '1.0', counted_minutes: 300, amount: '250000.00',
        objects: [{ object_key: 'wave', counted_minutes: 300, weight: 3_000, amount: null, days: { '2026-10-01': 5 } }],
      },
      { employee_id: 3, ktu: '1.0', counted_minutes: 0, amount: '0.00', objects: [] },
    ];
    const byBrigade = [
      { object_key: 'wave', object_name: 'ЖК Wave', output: null, total_weight: 0 },
      { object_key: 'stories', object_name: 'ЖК Stories', output: null, total_weight: 0 },
    ];
    const facts = brigadeShareFacts('b1', 'ok', rows, byBrigade, '1000000.00');
    expect(facts.get(1)).toMatchObject({
      output: '1000000.00', objects: [], whole: { weight: 9_000, totalWeight: 12_000 },
      workedDates: ['2026-10-01', '2026-10-02'],
    });
    expect(facts.get(3)?.whole).toEqual({ weight: 0, totalWeight: 12_000 });
    // По объектам — whole нет, Σ выработок объектов, как раньше.
    expect(brigadeShareFacts('b1', 'ok', rows, objects).get(1)?.whole).toBeNull();

    const result = buildPayrollCalc({
      monthStart: '2026-10-01', monthEnd: '2026-10-31', normDays: null, workdayDates: [], dayoffDates: [],
      absenceDays: { vacation: 0, sick: 0, educational_leave: 0, unpaid: 0 }, terms: [], plannedSupplements: [],
      oneTimeItems: [], rateAllowances: [], deductions: [], brigadeShares: [facts.get(1)!],
    });
    // Листок: «1 000 000 × КТУ 1,5 × 10 ч / 200 (Σ КТУ × ч бригады) = 750 000».
    expect(result.lines[0]).toMatchObject({ code: 'brigade', amount: '750000.00' });
    expect(result.lines[0].parts).toEqual([{
      kind: 'brigade', department_id: 'b1', object_key: null, object_name: null, output: '1000000.00',
      ktu_tenths: 15, counted_minutes: 600, weight: 9_000, total_weight: 12_000, amount: '750000.00',
    }]);
  });
});

describe('brigadeShareFacts и строка доли — вписанные доли (355)', () => {
  const calcOf = (share: IBrigadeShareFact) => buildPayrollCalc({
    monthStart: '2026-10-01', monthEnd: '2026-10-31', normDays: null, workdayDates: [], dayoffDates: [],
    absenceDays: { vacation: 0, sick: 0, educational_leave: 0, unpaid: 0 }, terms: [], plannedSupplements: [],
    oneTimeItems: [], rateAllowances: [], deductions: [], brigadeShares: [share],
  });

  it('сумма бригаде: у вписанного — его сумма и расчётный КТУ (как в «Итого по бригаде»), у остальных — Σ вписанных', () => {
    // 1 000 000; трое по 10 ч, КТУ 1,0; первому вписано 400 000 → остальным по 300 000, КТУ первого 1,33.
    const rows = [
      { employee_id: 1, ktu: '1.0', counted_minutes: 600, amount: '400000.00', fixed_amount: '400000.00', objects: [] },
      { employee_id: 2, ktu: '1.0', counted_minutes: 600, amount: '300000.00', objects: [] },
      { employee_id: 3, ktu: '1.0', counted_minutes: 600, amount: '300000.00', objects: [] },
    ];
    const facts = brigadeShareFacts('b1', 'ok', rows, [], '1000000.00');
    expect(facts.get(1)?.whole).toEqual({
      weight: 6_000, totalWeight: 12_000, fixed: { amount: '400000.00', total: '400000.00', ktu: '1.33' },
    });
    expect(facts.get(2)?.whole).toEqual({
      weight: 6_000, totalWeight: 12_000, fixed: { amount: null, total: '400000.00', ktu: null },
    });
    const fixed = calcOf(facts.get(1)!).lines[0];
    expect(fixed.brigade).toEqual({ ktu: '1.33', hours: 10, fixed: true });
    expect(fixed.parts?.[0]).toMatchObject({ amount: '400000.00', fixed_amount: '400000.00', effective_ktu: '1.33', fixed_total: '400000.00' });
    const free = calcOf(facts.get(2)!).lines[0];
    expect(free.brigade).toEqual({ ktu: '1.0', hours: 10 });
    expect(free.parts?.[0]).toMatchObject({ amount: '300000.00', weight: 6_000, total_weight: 12_000, fixed_total: '400000.00' });
    expect(free.parts?.[0]).not.toHaveProperty('fixed_amount');
  });

  it('по объектам: вписанная часть и Σ вписанных объекта; КТУ под суммой — месяца; конфликт — пометка части', () => {
    const objects = [{ object_key: 'wave', object_name: 'ЖК Wave', output: '1000000.00', total_weight: 54_000 }];
    const rows = [
      {
        employee_id: 1, ktu: '1.0', counted_minutes: 600, amount: '150000.00',
        objects: [{ object_key: 'wave', counted_minutes: 600, weight: 6_000, amount: '150000.00', fixed_amount: '150000.00' }],
      },
      {
        employee_id: 2, ktu: '1.0', counted_minutes: 600, amount: '94444.45',
        objects: [{ object_key: 'wave', counted_minutes: 600, weight: 6_000, amount: '94444.45' }],
      },
    ];
    const facts = brigadeShareFacts('b1', 'ok', rows, objects);
    expect(facts.get(1)?.objects[0].fixed).toEqual({ amount: '150000.00', total: '150000.00', ktu: '1.59' });
    expect(facts.get(2)?.objects[0].fixed).toEqual({ amount: null, total: '150000.00', ktu: null });
    const line1 = calcOf(facts.get(1)!).lines[0];
    expect(line1.brigade).toEqual({ ktu: '1.0', hours: 10 });
    expect(line1.parts?.[0]).toMatchObject({ fixed_amount: '150000.00', effective_ktu: '1.59', fixed_total: '150000.00' });

    const conflictRows = rows.map(row => ({ ...row, amount: null, objects: row.objects.map(part => ({ ...part, amount: null })) }));
    const conflicted = brigadeShareFacts('b1', 'nothing_to_distribute', conflictRows, objects, undefined, [{ object_key: 'wave' }]);
    const line = calcOf(conflicted.get(2)!);
    expect(line.lines[0]).toMatchObject({ amount: null });
    expect(line.lines[0].parts?.[0]).toMatchObject({ amount: null, conflict: true });
    expect(line.missing).toEqual(['brigade_output']);
  });
});
