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
    expect(plain(formatPayslipTerms([salary('130000.00')]))).toBe('Оклад: 130 000');
  });

  it('ставка — ₽/ч', () => {
    expect(plain(formatPayslipTerms([{ ...salary('500.50'), calc_type: 'hourly' }]))).toBe('Ставка: 500,50 ₽/ч');
  });

  it('смена в месяце — каждая с границей', () => {
    const terms = [salary('120000.00', '2026-01-01', '2026-07-14'), salary('130000.00', '2026-07-15')];
    expect(plain(formatPayslipTerms(terms))).toBe('Оклад: 120 000 по 14.07.2026, Оклад: 130 000 с 15.07.2026');
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
});
