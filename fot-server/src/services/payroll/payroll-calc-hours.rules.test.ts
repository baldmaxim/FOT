import { describe, expect, it } from 'vitest';

import { splitMinutesByNorm } from './payroll-calc-hours.rules.js';
import { buildPayrollCalc, type ICalcTermsRow, type IPayrollCalcFacts } from './payroll-calc.rules.js';

const terms = (over: Partial<ICalcTermsRow> = {}): ICalcTermsRow => ({
  effective_from: '2026-07-01',
  effective_to: null,
  calc_type: 'salary',
  monthly_salary: '160000.00',
  hourly_rate: null,
  bonus_amount: null,
  proration_rounding: 'ruble',
  ...over,
});

const hourlyTerms = (rate: string, over: Partial<ICalcTermsRow> = {}): ICalcTermsRow => terms({
  calc_type: 'hourly', monthly_salary: null, hourly_rate: rate, ...over,
});

const novDate = (day: number): string => `2026-11-${String(day).padStart(2, '0')}`;
const isWeekday = (day: number): boolean => {
  const dow = new Date(Date.UTC(2026, 10, day)).getUTCDay();
  return dow >= 1 && dow <= 5;
};
/** ЛИНИЯ 10 ч, ноябрь 2026: 21 будний (праздники не учитывает) + плановые субботы 7 и 14 — 23 дня, 230 ч. */
const LINE_DAYS = [...Array.from({ length: 30 }, (_, i) => i + 1).filter(isWeekday), 7, 14].sort((a, b) => a - b).map(novDate);
const NORM = 230 * 60;

const minutesOf = (dates: readonly string[], minutes = 600): Record<string, number> => (
  Object.fromEntries(dates.map(date => [date, minutes]))
);

const facts = (over: Partial<IPayrollCalcFacts> = {}): IPayrollCalcFacts => ({
  monthStart: '2026-11-01',
  monthEnd: '2026-11-30',
  normDays: 23,
  normMinutes: NORM,
  workdayDates: LINE_DAYS,
  dayoffDates: [],
  paidMinutes: minutesOf(LINE_DAYS),
  overtimeMinutes: {},
  absenceDays: { vacation: 0, sick: 0, educational_leave: 0, unpaid: 0 },
  terms: [terms()],
  plannedSupplements: [],
  oneTimeItems: [],
  rateAllowances: [],
  deductions: [],
  ...over,
});

const line = (result: ReturnType<typeof buildPayrollCalc>, code: string) => result.lines.find(item => item.code === code);

describe('оклад по часам: распределение минут по норме', () => {
  it('рабочие дни только добирают норму, выход добирает остаток, лишнее выхода — переработка; дата делится', () => {
    const split = splitMinutesByNorm({
      workdays: { '2026-11-02': 420, '2026-11-03': 600 },
      dayoffs: { '2026-11-01': 600, '2026-11-08': 600 },
      weekdayOvertime: { '2026-11-03': 60 },
      norm: 1200,
      stopped: () => false,
    });
    expect(split.contract).toEqual({ '2026-11-02': 420, '2026-11-03': 600, '2026-11-01': 180 });
    expect(split.overtime).toEqual({ '2026-11-01': 420, '2026-11-08': 600, '2026-11-03': 60 });
  });

  it('обычные минуты сверх нормы не оплачиваются; «Без переработки» — выход добирает норму, остаток и правка снимаются', () => {
    const split = splitMinutesByNorm({
      workdays: { '2026-11-02': 700 },
      dayoffs: { '2026-11-01': 600 },
      weekdayOvertime: { '2026-11-02': 120 },
      norm: 600,
      stopped: date => date === '2026-11-02',
    });
    expect(split).toEqual({ contract: { '2026-11-02': 600 }, overtime: { '2026-11-01': 600 } });
    const stoppedDayoff = splitMinutesByNorm({
      workdays: { '2026-11-02': 300 },
      dayoffs: { '2026-11-01': 600 },
      weekdayOvertime: {},
      norm: 600,
      stopped: date => date === '2026-11-01',
    });
    expect(stoppedDayoff).toEqual({ contract: { '2026-11-02': 300, '2026-11-01': 300 }, overtime: {} });
  });
});

describe('оклад по часам: «По трудовому договору»', () => {
  it('весь месяц по графику — ровно оклад; часы вместо дней', () => {
    const result = buildPayrollCalc(facts());
    expect(line(result, 'contract')).toEqual({
      code: 'contract',
      amount: '160000.00',
      hours: 230,
      parts: [{
        kind: 'salary_hours', from: '2026-11-01', to: '2026-11-30', salary: '160000.00', bonus: '0.00',
        minutes: NORM, norm_minutes: NORM, rounding: 'whole', amount: '160000.00',
      }],
    });
    expect(result.net).toBe('160000.00');
  });

  it('правка «10 → 8 ч» в один день: до рубля −1 391, до копейки −1 391,30', () => {
    const paid = { ...minutesOf(LINE_DAYS), '2026-11-10': 480 };
    expect(line(buildPayrollCalc(facts({ paidMinutes: paid })), 'contract')?.amount).toBe('158609.00');
    const kopeck = buildPayrollCalc(facts({ paidMinutes: paid, terms: [terms({ proration_rounding: 'daily_kopeck' })] }));
    expect(line(kopeck, 'contract')?.amount).toBe('158608.70');
    expect(line(kopeck, 'contract')?.parts?.[0]).toMatchObject({ rounding: 'kopeck', minutes: NORM - 120 });
  });

  it('премиальная часть условий входит в базу', () => {
    const paid = { ...minutesOf(LINE_DAYS), '2026-11-10': 480 };
    const result = buildPayrollCalc(facts({ paidMinutes: paid, terms: [terms({ bonus_amount: '40000.00' })] }));
    // 200 000 × 13 680 / 13 800 = 198 260,87 → 198 261.
    expect(line(result, 'contract')?.amount).toBe('198261.00');
  });

  it('пятница 7 ч с правкой «8»: полный месяц — оклад без переработки; неполный — час добирает норму', () => {
    // Норма 155 ч: у четырёх пятниц по 7 ч — правка «8» (8 ч), переработки по правке нет (порог 8 ч).
    const days = LINE_DAYS.filter(date => !['2026-11-07', '2026-11-14'].includes(date)).slice(0, 20);
    const fridays = ['2026-11-06', '2026-11-13', '2026-11-20', '2026-11-27'];
    const norm = 155 * 60;
    const paid = Object.fromEntries(days.map(date => [date, fridays.includes(date) ? 480 : 465]));
    const base = facts({ normMinutes: norm, workdayDates: days, paidMinutes: paid, terms: [terms({ monthly_salary: '170000.00' })] });
    const full = buildPayrollCalc(base);
    expect(line(full, 'contract')?.amount).toBe('170000.00');
    expect(line(full, 'overtime')).toBeUndefined();
    // Минус один день (465 мин): 20 × 465 + 4 × 15 − 465 = 8 895 мин; 170 000 × 8 895 / 9 300 = 162 596,77 → 162 597.
    const short = buildPayrollCalc({ ...base, workdayDates: days.slice(1) });
    expect(line(short, 'contract')?.amount).toBe('162597.00');
  });

  it('принят 16.11: норма полная, оплачены только часы периода', () => {
    const days = LINE_DAYS.filter(date => date >= '2026-11-16');
    const result = buildPayrollCalc(facts({ workdayDates: days, paidMinutes: minutesOf(days) }));
    // 11 будних × 10 ч = 6 600 мин; 160 000 × 6 600 / 13 800 = 76 521,74 → 76 522.
    expect(line(result, 'contract')).toMatchObject({ amount: '76522.00', hours: 110 });
  });

  it('две окладные строки в месяце — по минутам каждой', () => {
    const result = buildPayrollCalc(facts({
      terms: [
        terms({ effective_to: '2026-11-15' }),
        terms({ effective_from: '2026-11-16', monthly_salary: '200000.00' }),
      ],
    }));
    // 1–15: 10 будних + 2 субботы = 12 × 600 = 7 200 → 83 478,26 → 83 478; 16–30: 11 × 600 = 6 600 → 95 652,17 → 95 652.
    expect(line(result, 'contract')?.parts).toMatchObject([
      { kind: 'salary_hours', from: '2026-11-01', to: '2026-11-15', minutes: 7200, rounding: 'ruble', amount: '83478.00' },
      { kind: 'salary_hours', from: '2026-11-16', to: '2026-11-30', minutes: 6600, rounding: 'ruble', amount: '95652.00' },
    ]);
    expect(line(result, 'contract')?.amount).toBe('179130.00');
  });
});

describe('оклад по часам: выходы и переработка', () => {
  it('согласованная суббота 10 ч сверх полного месяца — переработка 6 956,52, без «вых.»', () => {
    const result = buildPayrollCalc(facts({ dayoffDates: ['2026-11-21'], paidMinutes: { ...minutesOf(LINE_DAYS), '2026-11-21': 600 } }));
    expect(line(result, 'contract')?.amount).toBe('160000.00');
    expect(line(result, 'overtime')).toEqual({
      code: 'overtime',
      amount: '6956.52',
      hours: 10,
      parts: [{
        kind: 'overtime_hours', from: '2026-11-01', to: '2026-11-30', salary: '160000.00', minutes: 600, norm_minutes: NORM,
        amount: '6956.52',
      }],
    });
    expect(result.net).toBe('166956.52');
  });

  it('выход добирает недостающие часы, остаток — переработка (дата делится)', () => {
    const paid = { ...minutesOf(LINE_DAYS), '2026-11-10': 420, '2026-11-21': 600 };
    const result = buildPayrollCalc(facts({ dayoffDates: ['2026-11-21'], paidMinutes: paid }));
    expect(line(result, 'contract')?.amount).toBe('160000.00');
    // 420 мин × 160 000 / 13 800 = 4 869,57 (до копейки, половина вверх).
    expect(line(result, 'overtime')).toMatchObject({ amount: '4869.57', hours: 7 });
  });

  it('правка сверх смены в будни — переработка по норме графика; «Без переработки» её снимает', () => {
    const paid = { ...minutesOf(LINE_DAYS), '2026-11-10': 720 };
    const result = buildPayrollCalc(facts({ paidMinutes: paid, overtimeMinutes: { '2026-11-10': 120 } }));
    expect(line(result, 'contract')?.amount).toBe('160000.00');
    expect(line(result, 'overtime')).toMatchObject({ amount: '1391.30', hours: 2 });
    const stopped = buildPayrollCalc(facts({
      paidMinutes: paid,
      overtimeMinutes: { '2026-11-10': 120 },
      overtimeStops: [{ date_from: '2026-11-01', date_to: null }],
    }));
    expect(line(stopped, 'contract')?.amount).toBe('160000.00');
    expect(line(stopped, 'overtime')).toBeUndefined();
  });

  it('«Без переработки» на выходе, добирающем норму: в оклад идёт добор, остаток не оплачивается', () => {
    const paid = { ...minutesOf(LINE_DAYS), '2026-11-10': 300, '2026-11-21': 600 };
    const result = buildPayrollCalc(facts({
      dayoffDates: ['2026-11-21'],
      paidMinutes: paid,
      overtimeStops: [{ date_from: '2026-11-21', date_to: '2026-11-21' }],
    }));
    expect(line(result, 'contract')).toMatchObject({ amount: '160000.00', hours: 230 });
    expect(line(result, 'overtime')).toBeUndefined();
  });
});

describe('оклад по часам: смешанные условия и плановая доплата', () => {
  it('оклад → почасовая: почасовые часы ставкой, норму окладной части не добирают', () => {
    const result = buildPayrollCalc(facts({
      terms: [terms({ effective_to: '2026-11-15' }), hourlyTerms('700.0000', { effective_from: '2026-11-16' })],
    }));
    // Оклад: 7 200 / 13 800 → 83 478; почасовая: 110 ч × 700 = 77 000.
    expect(line(result, 'contract')).toMatchObject({ amount: '160478.00', hours: 230 });
    expect(line(result, 'contract')?.parts).toMatchObject([
      { kind: 'salary_hours', minutes: 7200, amount: '83478.00' },
      { kind: 'hourly', minutes: 6600, rate: '700.0000', amount: '77000.00' },
    ]);
    expect(line(result, 'overtime')).toBeUndefined();
  });

  it('почасовая → оклад: то же в обратную сторону', () => {
    const result = buildPayrollCalc(facts({
      terms: [hourlyTerms('700.0000', { effective_to: '2026-11-15' }), terms({ effective_from: '2026-11-16' })],
    }));
    // Почасовая: 120 ч × 700 = 84 000; оклад: 6 600 / 13 800 → 76 522.
    expect(line(result, 'contract')).toMatchObject({ amount: '160522.00', hours: 230 });
  });

  it('плановая доплата на границе периода — по минутам периода; весь месяц и полная норма — как есть', () => {
    const boundary = buildPayrollCalc(facts({
      plannedSupplements: [{ amount: '20000.00', date_from: '2026-11-16', date_to: null }],
    }));
    // 20 000 × 6 600 / 13 800 = 9 565,22 → 9 565.
    expect(line(boundary, 'bonus')).toEqual({
      code: 'bonus',
      amount: '9565.00',
      hours: 230,
      parts: [{
        kind: 'planned_supplement_hours', from: '2026-11-16', to: '2026-11-30', base: '20000.00', minutes: 6600,
        norm_minutes: NORM, amount: '9565.00',
      }],
    });
    const whole = buildPayrollCalc(facts({ plannedSupplements: [{ amount: '20000.00', date_from: '2026-10-01', date_to: null }] }));
    expect(line(whole, 'bonus')?.amount).toBe('20000.00');
    const mixed = buildPayrollCalc(facts({
      terms: [terms({ effective_to: '2026-11-15' }), hourlyTerms('700.0000', { effective_from: '2026-11-16' })],
      plannedSupplements: [{ amount: '20000.00', date_from: '2026-11-01', date_to: null }],
    }));
    expect(line(mixed, 'bonus')?.amount).toBe('20000.00');
  });

  it('полностью почасовой ноябрь — прежний расчёт по дням', () => {
    const result = buildPayrollCalc(facts({ terms: [hourlyTerms('700.0000')] }));
    expect(line(result, 'contract')).toEqual({
      code: 'contract',
      amount: '161000.00',
      days: { worked: 23, norm: 23 },
      hours: 230,
      parts: [{ kind: 'hourly', from: '2026-11-01', to: '2026-11-30', rate: '700.0000', minutes: NORM, amount: '161000.00' }],
    });
  });
});

describe('оклад по часам: неизвестные часы и прежние месяцы', () => {
  it('нет минут у одной окладной даты — оклад и итог неизвестны, переработки и доплаты нет', () => {
    const paid = { ...minutesOf(LINE_DAYS), '2026-11-21': 600 };
    delete paid['2026-11-10'];
    const result = buildPayrollCalc(facts({
      dayoffDates: ['2026-11-21'],
      paidMinutes: paid,
      plannedSupplements: [{ amount: '20000.00', date_from: '2026-11-01', date_to: null }],
    }));
    expect(line(result, 'contract')?.amount).toBeNull();
    expect(line(result, 'overtime')).toBeUndefined();
    expect(line(result, 'bonus')).toBeUndefined();
    expect(result.missing).toContain('hourly');
    expect(result.net).toBeNull();
  });

  it('смешанный месяц: почасовая часть известна, окладная дата без минут — строка целиком null', () => {
    const paid = minutesOf(LINE_DAYS);
    delete paid['2026-11-02'];
    const result = buildPayrollCalc(facts({
      paidMinutes: paid,
      terms: [terms({ effective_to: '2026-11-15' }), hourlyTerms('700.0000', { effective_from: '2026-11-16' })],
    }));
    expect(line(result, 'contract')?.amount).toBeNull();
    expect(line(result, 'contract')?.parts).toMatchObject([{ kind: 'hourly', amount: '77000.00' }]);
    expect(result.net).toBeNull();
  });

  it('нет нормы — итог неизвестен', () => {
    const result = buildPayrollCalc(facts({ normMinutes: null }));
    expect(line(result, 'contract')?.amount).toBeNull();
    expect(result.missing).toContain('no_norm');
    expect(result.net).toBeNull();
  });

  it('октябрь — по дням, как было', () => {
    const october = buildPayrollCalc(facts({
      monthStart: '2026-10-01',
      monthEnd: '2026-10-31',
      normDays: 24,
      normMinutes: 176 * 60,
      workdayDates: ['2026-10-01', '2026-10-02'],
      dayoffDates: [],
      paidMinutes: { '2026-10-01': 480, '2026-10-02': 300 },
    }));
    expect(line(october, 'contract')).toEqual({
      code: 'contract',
      amount: '13333.00',
      days: { worked: 2, norm: 24 },
      parts: [{
        kind: 'salary', from: '2026-10-01', to: '2026-10-31', salary: '160000.00', bonus: '0.00', days: 2, norm: 24,
        rounding: 'ruble', amount: '13333.00',
      }],
    });
  });
});
