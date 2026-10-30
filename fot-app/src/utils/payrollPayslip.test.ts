import { describe, expect, it } from 'vitest';

import { toPaidAmounts } from './payrollPaid';
import { formatPayslipSchedules, payslipLines, payslipRateLines } from './payrollPayslip';

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

  it('начисления месяца — в порядке ведомости, с «По трудовому договору», без чужих месяцев', () => {
    expect(payslipLines('2026-07', amounts, 'accrued')).toEqual([
      { code: 'contract', label: 'По трудовому договору', amount: 135200 },
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

  it('статья 327: «Аванс» из ведомости бригады — своей строкой в начислениях', () => {
    const may = toPaidAmounts([
      { month: '2026-05', item: 'contract', amount: '226029.72' },
      { month: '2026-05', item: 'housing', amount: '4000.00' },
      { month: '2026-05', item: 'advance_accrual', amount: '31388.64' },
    ]);
    expect(payslipLines('2026-05', may, 'accrued')).toEqual([
      { code: 'contract', label: 'По трудовому договору', amount: 226029.72 },
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
      { code: 'contract', label: 'По трудовому договору', amount: 123302.35 },
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
    expect(payslipLines('2026-05', may, 'accrued')).toEqual([
      { code: 'contract', label: 'По трудовому договору', amount: 30379.71 },
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

  it('проживание по дням — подпись «630,00 × 9 дн.», без ставки — «30 дн.»', () => {
    expect(payslipRateLines([{ code: 'housing', amount: '5670.00', rate: '630.00', housing_days: 9 }]))
      .toEqual([{ code: 'housing', label: 'Доплата за проживание', amount: 5670, note: '630,00 × 9 дн.' }]);
    expect(payslipRateLines([{ code: 'dormitory_allowance', amount: '4160.00', rate: '160.00', housing_days: 26 }]))
      .toEqual([{ code: 'dormitory_allowance', label: 'Доплата за общежитие', amount: 4160, note: '160,00 × 26 дн.' }]);
    expect(payslipRateLines([{ code: 'housing', amount: '19950.00', housing_days: 30 }]))
      .toEqual([{ code: 'housing', label: 'Доплата за проживание', amount: 19950, note: '30 дн.' }]);
  });

  it('проезд с днями — подпись «22 из 23 дн.»', () => {
    expect(payslipRateLines([{ code: 'travel', amount: '2611.00', days: { worked: 22, norm: 23 } }]))
      .toEqual([{ code: 'travel', label: 'Проезд', amount: 2611, note: '22 из 23 дн.' }]);
    expect(payslipRateLines([{ code: 'travel', amount: '2730.00' }])[0]).not.toHaveProperty('note');
  });
});

describe('расчётный листок: графики месяца', () => {
  it('один график — без дат; несколько — с датами; нет (старый бэкенд) — null', () => {
    expect(formatPayslipSchedules([{ name: '5+2 (Линия С/О)', from: '2026-09-01', to: '2026-09-30' }]))
      .toBe('График месяца: «5+2 (Линия С/О)»');
    expect(formatPayslipSchedules([
      { name: 'Пятидневка', from: '2026-09-01', to: '2026-09-09' },
      { name: '6+0 (11 ч)', from: '2026-09-10', to: '2026-09-30' },
    ])).toBe('Графики месяца: «Пятидневка» с 01.09 по 09.09, «6+0 (11 ч)» с 10.09 по 30.09');
    expect(formatPayslipSchedules([])).toBeNull();
    expect(formatPayslipSchedules(undefined)).toBeNull();
  });
});
