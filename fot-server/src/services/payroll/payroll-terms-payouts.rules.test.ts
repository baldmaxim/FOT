import { describe, expect, it } from 'vitest';

import type { PayrollCalcWithPreliminary } from './payroll-calc.service.js';
import { mergeSummaryMonth } from './payroll-summary-calc.rules.js';
import {
  isTermsPayoutFrom1c,
  summaryPayoutCents,
  termsPayoutMonth,
  type ITermsPayoutFacts,
} from './payroll-terms-payouts.rules.js';

const calc = (
  lines: Array<{ code: string; amount: string | null }>,
  missing: string[] = [],
): PayrollCalcWithPreliminary => ({ state: 'closed', lines, missing, deductions: [] }) as unknown as PayrollCalcWithPreliminary;

const payout = (over: Partial<ITermsPayoutFacts>): number | null => termsPayoutMonth({
  paid: new Map(),
  calc: undefined,
  fotKnown: false,
  oneTime: [],
  deductions: [],
  ...over,
});

describe('«Выплачено»: сумма статей', () => {
  it('начислено − удержано, «Прочие удержания» «Свода» — удержание; ни одной статьи — null', () => {
    expect(summaryPayoutCents(new Map([['contract', 1000000], ['travel', 273000], ['meals', 50000], ['other_deductions', 10000]])))
      .toBe(1213000);
    expect(summaryPayoutCents(new Map([['meals', 50000]]))).toBe(-50000);
    expect(summaryPayoutCents(new Map())).toBeNull();
  });
});

describe('«Выплачено»: месяц из 1С, иначе расчёт ФОТ', () => {
  it('1. «Зарплата» 1С есть — весь месяц из 1С, расчёт и разовые не добавляются (Абдуллаев Р., сентябрь)', () => {
    expect(payout({
      paid: new Map([['contract', '106363.68'], ['extra_work', '15000.00'], ['travel', '1489.00'], ['vacation', '99140.26']]),
      calc: calc([{ code: 'contract', amount: '106363.68' }, { code: 'overtime', amount: '5000.00' }]),
      fotKnown: true,
      oneTime: [{ reason: 'Допработы', amount: '15000.00' }],
    })).toBe(22199294);
  });

  it('1. ГПХ 1С без «Зарплаты» — тоже месяц из 1С: оклад ФОТ не добавляется (Баллиев, август)', () => {
    expect(payout({
      paid: new Map([['gph', '150075.00']]),
      calc: calc([{ code: 'contract', amount: '146087.00' }]),
      fotKnown: true,
    })).toBe(15007500);
    expect(isTermsPayoutFrom1c(new Map([['gph', '1.00']]))).toBe(true);
    expect(isTermsPayoutFrom1c(new Map([['contract', '1.00']]))).toBe(true);
    expect(isTermsPayoutFrom1c(new Map([['vacation', '1.00']]))).toBe(false);
    expect(isTermsPayoutFrom1c(undefined)).toBe(false);
  });

  it('1. итог 1С ноль — 0, а не «—»', () => {
    expect(payout({ paid: new Map([['contract', '1000.00'], ['meals', '1000.00']]) })).toBe(0);
  });

  it('2. 1С нет, итог ФОТ известен — «Сумма» «Расчётов»: расчёт + разовые − удержания', () => {
    expect(payout({
      calc: calc([
        { code: 'contract', amount: '182000.00' },
        { code: 'travel', amount: '2730.00' },
        // Разовые — из оснований ниже, а не этой строкой (как в «Своде»).
        { code: 'supplement', amount: '7000.00' },
      ]),
      fotKnown: true,
      oneTime: [{ reason: 'Премия', amount: '7000.00' }],
      deductions: [{ kind: 'Питание', amount: '1470.00' }],
    })).toBe(19026000);
  });

  it('2. статья 1С без «Зарплаты» заменяет свою статью расчёта, как «Свод»', () => {
    const facts = {
      paid: new Map([['extra_work', '15000.00']]),
      calc: calc([{ code: 'contract', amount: '100000.00' }]),
      oneTime: [{ reason: 'Допработы', amount: '15000.00' }],
      deductions: [],
    };
    const summary = summaryPayoutCents(mergeSummaryMonth(facts).cents);
    expect(summary).toBe(11500000);
    expect(payout({ ...facts, fotKnown: true })).toBe(summary);
  });

  it('2. итог ФОТ известен, строк нет — 0, как «Сумма» «Расчётов»', () => {
    expect(payout({ calc: calc([], ['no_days']), fotKnown: true })).toBe(0);
  });

  it('3. итог ФОТ неизвестен — только статьи 1С: известная часть ФОТ, разовая и удержание не показываются', () => {
    const facts: Partial<ITermsPayoutFacts> = {
      calc: calc([{ code: 'brigade', amount: null }, { code: 'housing', amount: '4800.00' }], ['brigade_output']),
      fotKnown: false,
      oneTime: [{ reason: 'Допработы', amount: '15000.00' }],
      deductions: [{ kind: 'Питание', amount: '1470.00' }],
    };
    expect(payout({ ...facts, paid: new Map([['vacation', '30000.00'], ['meals', '500.00']]) })).toBe(2950000);
    expect(payout(facts)).toBeNull();
  });

  it('4. ФОТ не считался — 1С, разовые и удержания, как «Свод»; ничего нет — null, ноль — 0', () => {
    expect(payout({
      paid: new Map([['vacation', '30000.00']]),
      oneTime: [{ reason: 'Премия', amount: '5000.00' }],
      deductions: [{ kind: 'Штрафы', amount: '1000.00' }],
    })).toBe(3400000);
    expect(payout({})).toBeNull();
    expect(payout({ oneTime: [{ reason: 'Премия', amount: '1000.00' }], deductions: [{ kind: 'Штрафы', amount: '1000.00' }] }))
      .toBe(0);
  });
});
