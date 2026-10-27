import { describe, expect, it } from 'vitest';

import type { IPayslipTerms } from '../services/payrollService';
import { toPaidAmounts } from './payrollPaid';
import { formatPayslipTerms, payslipLines, payslipPeriodParts, payslipRateLines } from './payrollPayslip';

const plain = (value: string | null): string | null => (value === null ? null : value.replace(/\s/g, ' '));

const salary = (amount: string | null, from = '2026-01-01', to: string | null = null): IPayslipTerms => ({
  effective_from: from,
  effective_to: to,
  calc_type: 'salary',
  amount,
});

describe('расчётный листок: оклад', () => {
  it('один оклад — без границ', () => {
    expect(plain(formatPayslipTerms([salary('130000.00')]))).toBe('Оклад: 130 000,00');
  });

  it('ставка — ₽/ч', () => {
    expect(plain(formatPayslipTerms([{ ...salary('500.50'), calc_type: 'hourly' }]))).toBe('Ставка: 500,50 ₽/ч');
  });

  it('смена в месяце — каждая с границей', () => {
    const terms = [salary('120000.00', '2026-01-01', '2026-07-14'), salary('130000.00', '2026-07-15')];
    expect(plain(formatPayslipTerms(terms))).toBe('Оклад: 120 000,00 по 14.07.2026, Оклад: 130 000,00 с 15.07.2026');
  });

  it('без суммы или условий — null', () => {
    expect(formatPayslipTerms([])).toBeNull();
    expect(formatPayslipTerms([salary(null)])).toBeNull();
  });
});

describe('расчётный листок: период', () => {
  it('«с …», «по …»; без периода — null', () => {
    expect(payslipPeriodParts('2026-07-01', '2026-07-31')).toEqual(['с 01.07.2026', 'по 31.07.2026']);
    expect(payslipPeriodParts(null, null)).toBeNull();
  });
});

describe('расчётный листок: строки статей', () => {
  const amounts = toPaidAmounts([
    { month: '2026-07', item: 'contract', amount: '135200.00' },
    { month: '2026-07', item: 'travel', amount: '2730.00' },
    { month: '2026-07', item: 'bonus', amount: '5000.00' },
    { month: '2026-07', item: 'safety_fine', amount: '1000.00' },
    { month: '2026-07', item: 'premium_contract', amount: '83470.00' },
    { month: '2026-07', item: 'bank_fees', amount: '19127.00' },
    { month: '2026-08', item: 'housing', amount: '630.00' },
  ]);

  it('начисления месяца — в порядке ведомости, без основной статьи и чужих месяцев', () => {
    expect(payslipLines('2026-07', amounts, 'accrued')).toEqual([
      { code: 'bonus', label: 'Премиальная', amount: 5000 },
      { code: 'travel', label: 'Проезд', amount: 2730 },
      { code: 'premium_contract', label: 'Премия % по договору', amount: 83470 },
    ]);
  });

  it('удержания месяца', () => {
    expect(payslipLines('2026-07', amounts, 'deducted')).toEqual([
      { code: 'safety_fine', label: 'Нарушение техники безопасности', amount: 1000 },
      { code: 'bank_fees', label: 'Банковские издержки по исп. листам', amount: 19127 },
    ]);
  });

  it('статьи 326: дневной тариф и спецодежда начислением — в начислениях; алименты, ТМЦ, аренда а/м — в удержаниях', () => {
    const july = toPaidAmounts([
      { month: '2026-07', item: 'day_rate', amount: '35857.50' },
      { month: '2026-07', item: 'workwear_accrual', amount: '2450.00' },
      { month: '2026-07', item: 'workwear', amount: '2933.58' },
      { month: '2026-07', item: 'alimony', amount: '5000.00' },
      { month: '2026-07', item: 'tmc', amount: '27000.00' },
      { month: '2026-07', item: 'car_rent', amount: '2610.00' },
    ]);
    expect(payslipLines('2026-07', july, 'accrued')).toEqual([
      { code: 'day_rate', label: 'Оплата по дневному тарифу', amount: 35857.5 },
      { code: 'workwear_accrual', label: 'Спецодежда (начисление)', amount: 2450 },
    ]);
    expect(payslipLines('2026-07', july, 'deducted')).toEqual([
      { code: 'workwear', label: 'Спецодежда', amount: 2933.58 },
      { code: 'alimony', label: 'Алименты', amount: 5000 },
      { code: 'tmc', label: 'ТМЦ', amount: 27000 },
      { code: 'car_rent', label: 'Удержание по договору аренды а/м', amount: 2610 },
    ]);
  });

  it('статья 327: «Аванс» из ведомости бригады — своей строкой в начислениях, не в основной', () => {
    const may = toPaidAmounts([
      { month: '2026-05', item: 'contract', amount: '226029.72' },
      { month: '2026-05', item: 'housing', amount: '4000.00' },
      { month: '2026-05', item: 'advance_accrual', amount: '31388.64' },
    ]);
    expect(payslipLines('2026-05', may, 'accrued')).toEqual([
      { code: 'housing', label: 'Компенсация проживания', amount: 4000 },
      { code: 'advance_accrual', label: 'Аванс (начисление)', amount: 31388.64 },
    ]);
    expect(payslipLines('2026-05', may, 'deducted')).toEqual([]);
  });

  it('статьи 329: «Возврат штрафа» — своей строкой в начислениях, «Порча имущества» — в удержаниях', () => {
    const june = toPaidAmounts([
      { month: '2026-06', item: 'contract', amount: '123302.35' },
      { month: '2026-06', item: 'fine_refund', amount: '13705.62' },
      { month: '2026-06', item: 'housing', amount: '4320.00' },
      { month: '2026-06', item: 'property_damage', amount: '8000.00' },
    ]);
    expect(payslipLines('2026-06', june, 'accrued')).toEqual([
      { code: 'housing', label: 'Компенсация проживания', amount: 4320 },
      { code: 'fine_refund', label: 'Возврат штрафа', amount: 13705.62 },
    ]);
    expect(payslipLines('2026-06', june, 'deducted')).toEqual([
      { code: 'property_damage', label: 'Порча имущества', amount: 8000 },
    ]);
  });

  it('статья 334: «Погашение долгов прошлых месяцев» — в удержаниях, в том числе с минусом', () => {
    const may = toPaidAmounts([
      { month: '2026-05', item: 'contract', amount: '30379.71' },
      { month: '2026-05', item: 'prior_debts', amount: '-22559.69' },
    ]);
    expect(payslipLines('2026-05', may, 'deducted')).toEqual([
      { code: 'prior_debts', label: 'Погашение долгов прошлых месяцев', amount: -22559.69 },
    ]);
    expect(payslipLines('2026-05', may, 'accrued')).toEqual([]);
  });
});

describe('расчётный листок: «По ставкам ФОТ»', () => {
  it('подписи по коду, суммы числом; нет строк или поля (старый бэкенд) — пусто', () => {
    expect(payslipRateLines([
      { code: 'travel', amount: '2730.00' },
      { code: 'dormitory_allowance', amount: '160.00' },
    ])).toEqual([
      { code: 'travel', label: 'Проезд', amount: 2730 },
      { code: 'dormitory_allowance', label: 'Доплата за общежитие', amount: 160 },
    ]);
    expect(payslipRateLines([{ code: 'housing', amount: '630.50' }]))
      .toEqual([{ code: 'housing', label: 'Доплата за проживание', amount: 630.5 }]);
    expect(payslipRateLines([])).toEqual([]);
    expect(payslipRateLines(undefined)).toEqual([]);
  });

  it('проезд с днями — подпись «22 из 23 дн.»', () => {
    expect(payslipRateLines([{ code: 'travel', amount: '2611.00', days: { worked: 22, norm: 23 } }]))
      .toEqual([{ code: 'travel', label: 'Проезд', amount: 2611, note: '22 из 23 дн.' }]);
    expect(payslipRateLines([{ code: 'travel', amount: '2730.00' }])[0]).not.toHaveProperty('note');
  });
});
