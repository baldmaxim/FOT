import { describe, expect, it } from 'vitest';

import { buildPayrollCalc, type ICalcTermsRow, type IPayrollCalcFacts } from './payroll-calc.rules.js';
import {
  lastTermsNote,
  pickRecalcMonths,
  recalcMonthRow,
  recalcTotal,
  termsChangedFrom,
  termsForMonth,
  type IRecalcNextTerms,
  type IRecalcRecord,
} from './payroll-terms-recalc.rules.js';

const row = (over: Partial<ICalcTermsRow> = {}): ICalcTermsRow => ({
  effective_from: '2026-08-01',
  effective_to: null,
  calc_type: 'salary',
  monthly_salary: '180000.00',
  hourly_rate: null,
  bonus_amount: null,
  proration_rounding: 'ruble',
  ...over,
});

const next = (over: Partial<IRecalcNextTerms> = {}): IRecalcNextTerms => ({
  calc_type: 'salary',
  monthly_salary: 180000,
  hourly_rate: null,
  bonus_amount: null,
  proration_rounding: 'ruble',
  ...over,
});

const record = (over: Partial<IRecalcRecord> = {}): IRecalcRecord => ({
  id: 1,
  effective_from: '2026-09-01',
  changed_on: '2026-11-05',
  previous_terms: [row()],
  paid_months_1c: [],
  ...over,
});

const noNotes = { from: null, to: null };

describe('termsChangedFrom — нужна ли запись пересчёта', () => {
  it('первое назначение: сравнивать не с чем', () => {
    expect(termsChangedFrom([], '2026-09-01', next({ monthly_salary: 230000 }))).toBe(false);
  });

  it('прежние условия закончились до новой даты — сравнивать не с чем', () => {
    const closed = row({ effective_from: '2026-07-01', effective_to: '2026-08-31' });
    expect(termsChangedFrom([closed], '2026-09-01', next({ monthly_salary: 230000 }))).toBe(false);
  });

  it('те же суммы (Карасени: 350 000 дважды) — записи нет, запись суммы не важна', () => {
    expect(termsChangedFrom([row({ monthly_salary: '180000' })], '2026-09-01', next())).toBe(false);
  });

  it('пустая премиальная и 0 — одно и то же', () => {
    expect(termsChangedFrom([row({ bonus_amount: '0.00' })], '2026-09-01', next())).toBe(false);
  });

  it('оклад, премиальная, вид оплаты, ставка и округление — запись нужна', () => {
    expect(termsChangedFrom([row()], '2026-09-01', next({ monthly_salary: 200000 }))).toBe(true);
    expect(termsChangedFrom([row()], '2026-09-01', next({ bonus_amount: 10000 }))).toBe(true);
    expect(termsChangedFrom([row()], '2026-09-01', next({
      calc_type: 'hourly', monthly_salary: null, hourly_rate: 500,
    }))).toBe(true);
    const hourly = row({ calc_type: 'hourly', monthly_salary: null, hourly_rate: '500.1200' });
    expect(termsChangedFrom([hourly], '2026-09-01', next({
      calc_type: 'hourly', monthly_salary: null, hourly_rate: 500.12,
    }))).toBe(false);
    expect(termsChangedFrom([hourly], '2026-09-01', next({
      calc_type: 'hourly', monthly_salary: null, hourly_rate: 500.1201,
    }))).toBe(true);
    expect(termsChangedFrom([row()], '2026-09-01', next({ proration_rounding: 'daily_kopeck' }))).toBe(true);
  });

  it('одинакова только первая из задетых строк — запись нужна', () => {
    const history = [
      row({ effective_from: '2026-08-01', effective_to: '2026-09-30' }),
      row({ effective_from: '2026-10-01', monthly_salary: '190000.00' }),
    ];
    expect(termsChangedFrom(history, '2026-09-01', next())).toBe(true);
  });
});

describe('pickRecalcMonths — какие месяцы считать', () => {
  const months = (records: IRecalcRecord[], payouts: Array<[string, string[]]> = []) => (
    pickRecalcMonths(records, new Map(payouts)).map(item => [item.month, item.record.id])
  );

  it('Агаркова: сентябрь выплачен, октябрь нет — только сентябрь', () => {
    expect(months([record()], [['2026-09', ['2026-10-20']]])).toEqual([['2026-09', 1]]);
  });

  it('ни один месяц не выплачен — блока нет', () => {
    expect(months([record()])).toEqual([]);
  });

  it('новые сверху; месяцы со статьёй 1С и с ведомостью вместе', () => {
    expect(months(
      [record({ effective_from: '2026-07-01', paid_months_1c: ['2026-07', '2026-08'] })],
      [['2026-09', ['2026-10-20']]],
    )).toEqual([['2026-09', 1], ['2026-08', 1], ['2026-07', 1]]);
  });

  it('ведомость после дня правки — месяц выплачен уже по новому окладу', () => {
    expect(months([record()], [['2026-09', ['2026-11-06']]])).toEqual([]);
  });

  it('ведомость в день правки считается', () => {
    expect(months([record()], [['2026-09', ['2026-11-05']]])).toEqual([['2026-09', 1]]);
  });

  it('месяц правки и следующие не считаются, даже если выплачены', () => {
    expect(months(
      [record({ effective_from: '2026-11-01', changed_on: '2026-11-20' })],
      [['2026-11', ['2026-11-10']]],
    )).toEqual([]);
  });

  it('месяц до новой даты оклада не считается', () => {
    expect(months([record()], [['2026-08', ['2026-09-20']], ['2026-09', ['2026-10-20']]])).toEqual([['2026-09', 1]]);
  });

  it('две правки подряд: «Было» — от первой, у которой месяц выплачен (160 → 180 → 190)', () => {
    const first = record({ id: 1 });
    const second = record({ id: 2, changed_on: '2026-11-06' });
    expect(months([first, second], [['2026-09', ['2026-10-20']]])).toEqual([['2026-09', 1]]);
  });

  it('месяц выплачен между правками: первая его не видит, считается от второй', () => {
    const first = record({ id: 1, effective_from: '2026-10-01', changed_on: '2026-11-03' });
    const second = record({ id: 2, effective_from: '2026-10-01', changed_on: '2026-11-25' });
    expect(months([first, second], [['2026-10', ['2026-11-20']]])).toEqual([['2026-10', 2]]);
  });

  it('смена года: декабрь считается при правке в январе', () => {
    expect(months(
      [record({ effective_from: '2026-12-01', changed_on: '2027-01-15' })],
      [['2026-12', ['2027-01-10']]],
    )).toEqual([['2026-12', 1]]);
  });
});

describe('recalcMonthRow и итог', () => {
  it('Агаркова: было 182 730, стало 202 730 — доплата 20 000', () => {
    expect(recalcMonthRow('2026-09', '182730.00', '202730.00', noNotes)).toMatchObject({
      was: '182730.00', became: '202730.00', difference: '20000.00',
    });
  });

  it('возврат оклада: разницы нет — строки нет', () => {
    expect(recalcMonthRow('2026-09', '182730.00', '182730.00', noNotes)).toBeNull();
  });

  it('понижение — минус; копейки без потерь', () => {
    expect(recalcMonthRow('2026-09', '100000.10', '99999.95', noNotes)?.difference).toBe('-0.15');
  });

  it('одна из сумм неизвестна — разницы нет, в итог не идёт', () => {
    const unknown = recalcMonthRow('2026-09', null, '100.00', noNotes)!;
    const known = recalcMonthRow('2026-08', '100.00', '120.10', noNotes)!;
    expect(unknown.difference).toBeNull();
    expect(recalcTotal([unknown, known])).toBe('20.10');
  });

  it('итог в копейках: 0,1 + 0,2 = 0,30', () => {
    const rows = [
      recalcMonthRow('2026-09', '0.00', '0.10', noNotes)!,
      recalcMonthRow('2026-08', '0.00', '0.20', noNotes)!,
    ];
    expect(recalcTotal(rows)).toBe('0.30');
  });

  it('итог — переплата при понижении', () => {
    expect(recalcTotal([recalcMonthRow('2026-09', '200.00', '150.00', noNotes)!])).toBe('-50.00');
  });
});

describe('termsForMonth и подпись месяца', () => {
  const history = [
    row({ effective_from: '2026-07-01', effective_to: '2026-08-31', monthly_salary: '150000.00' }),
    row({ effective_from: '2026-09-01', effective_to: '2026-09-14', monthly_salary: '180000.00' }),
    row({ effective_from: '2026-09-15', monthly_salary: '190000.00', bonus_amount: '5000.00' }),
  ];

  it('только строки, задевающие месяц', () => {
    expect(termsForMonth(history, '2026-08').map(item => item.monthly_salary)).toEqual(['150000.00']);
    expect(termsForMonth(history, '2026-09').map(item => item.monthly_salary)).toEqual(['180000.00', '190000.00']);
    expect(termsForMonth(history, '2026-06')).toEqual([]);
  });

  it('подпись — последние условия месяца; у почасовых — ставка', () => {
    expect(lastTermsNote(termsForMonth(history, '2026-09'))).toEqual({
      calc_type: 'salary', amount: '190000.00', bonus: '5000.00',
    });
    expect(lastTermsNote([row({ calc_type: 'hourly', monthly_salary: null, hourly_rate: '500.0000' })])).toEqual({
      calc_type: 'hourly', amount: '500.0000', bonus: null,
    });
    expect(lastTermsNote([])).toBeNull();
  });
});

describe('«Было» и «Стало» — один месяц с разными условиями', () => {
  const september = Array.from({ length: 22 }, (_, index) => `2026-09-${String(index + 1).padStart(2, '0')}`);
  const facts = (terms: readonly ICalcTermsRow[], over: Partial<IPayrollCalcFacts> = {}): IPayrollCalcFacts => ({
    monthStart: '2026-09-01',
    monthEnd: '2026-09-30',
    normDays: 22,
    workdayDates: september,
    dayoffDates: [],
    absenceDays: { vacation: 0, sick: 0, educational_leave: 0, unpaid: 0 },
    terms,
    plannedSupplements: [],
    oneTimeItems: [],
    rateAllowances: [],
    deductions: [],
    ...over,
  });
  const difference = (before: readonly ICalcTermsRow[], after: readonly ICalcTermsRow[], over = {}) => {
    const row2 = recalcMonthRow(
      '2026-09',
      buildPayrollCalc(facts(before, over)).net,
      buildPayrollCalc(facts(after, over)).net,
      noNotes,
    );
    return row2?.difference ?? null;
  };

  it('полный месяц: разница равна разнице окладов, проезд и разовые не влияют', () => {
    expect(difference([row()], [row({ monthly_salary: '200000.00' })], {
      oneTimeItems: [{ reason: 'Премия', amount: '5000.00' }],
      rateAllowances: [{ code: 'travel', amount: '2730.00', days: { worked: 22, norm: 22 }, rate: '2730.00' }],
    })).toBe('20000.00');
  });

  it('неполный месяц: разница по дням, с округлением как у расчёта', () => {
    // 200 000 × 21/22 = 190 909; 180 000 × 21/22 = 171 818.
    expect(difference([row()], [row({ monthly_salary: '200000.00' })], { workdayDates: september.slice(0, 21) }))
      .toBe('19091.00');
  });

  it('новый оклад с 15-го: разница только за дни после даты', () => {
    const after = [
      row({ effective_to: '2026-09-14' }),
      row({ effective_from: '2026-09-15', monthly_salary: '200000.00' }),
    ];
    const result = difference([row()], after);
    expect(Number(result)).toBeGreaterThan(0);
    expect(Number(result)).toBeLessThan(20000);
  });

  it('прежних условий на месяц нет — «Было» неизвестно', () => {
    expect(recalcMonthRow('2026-09', buildPayrollCalc(facts([])).net, '100.00', noNotes)?.difference).toBeNull();
  });

  it('доля бригады не зависит от оклада — разницы нет', () => {
    const share = {
      departmentId: 'b1', amount: '90000.00', ktu: '1.0', countedMinutes: 600, distribution: 'ok' as const,
      output: '90000.00', objects: [], whole: null, workedDates: [],
    };
    expect(difference([row()], [row({ monthly_salary: '200000.00' })], {
      normDays: null, workdayDates: [], brigadeShares: [share],
    })).toBeNull();
  });
});

describe('разовые доплаты: основание', () => {
  const facts = (oneTimeItems: IPayrollCalcFacts['oneTimeItems']): IPayrollCalcFacts => ({
    monthStart: '2026-09-01',
    monthEnd: '2026-09-30',
    normDays: 22,
    workdayDates: [],
    dayoffDates: [],
    absenceDays: { vacation: 0, sick: 0, educational_leave: 0, unpaid: 0 },
    terms: [row()],
    plannedSupplements: [],
    oneTimeItems,
    rateAllowances: [],
    deductions: [],
  });
  const supplement = (items: IPayrollCalcFacts['oneTimeItems']) => (
    buildPayrollCalc(facts(items)).lines.find(line => line.code === 'supplement')
  );

  it('одно основание — одна часть с ним (Александрович, сентябрь)', () => {
    expect(supplement([{ reason: 'Компенсация использования личного а/м', amount: '20167.00' }])).toEqual({
      code: 'supplement',
      amount: '20167.00',
      parts: [{ kind: 'one_time', amount: '20167.00', reason: 'Компенсация использования личного а/м' }],
    });
  });

  it('два основания — часть на каждое, сумма строки — их сумма', () => {
    expect(supplement([
      { reason: 'Допработы', amount: '3000.10' },
      { reason: 'Премия', amount: '5000.20' },
    ])).toEqual({
      code: 'supplement',
      amount: '8000.30',
      parts: [
        { kind: 'one_time', amount: '3000.10', reason: 'Допработы' },
        { kind: 'one_time', amount: '5000.20', reason: 'Премия' },
      ],
    });
  });

  it('разовых нет — строки нет', () => {
    expect(supplement([])).toBeUndefined();
  });
});
