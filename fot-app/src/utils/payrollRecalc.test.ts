import { describe, expect, it } from 'vitest';

import type { IPayrollRecalcTerms } from '../services/payrollService';
import { recalcTermsNotes, recalcTotalView } from './payrollRecalc';

const NBSP = ' ';

const salary = (amount: string, bonus: string | null = null): IPayrollRecalcTerms => ({
  calc_type: 'salary', amount, bonus,
});
const hourly = (amount: string): IPayrollRecalcTerms => ({ calc_type: 'hourly', amount, bonus: null });

describe('recalcTermsNotes', () => {
  it('оклад: было → стало (Агаркова)', () => {
    expect(recalcTermsNotes(salary('180000.00'), salary('200000.00')))
      .toEqual([`оклад 180${NBSP}000,00 → 200${NBSP}000,00`]);
  });

  it('ставка почасового', () => {
    expect(recalcTermsNotes(hourly('500.0000'), hourly('612.5000'))).toEqual(['ставка 500 ₽/ч → 612,5 ₽/ч']);
  });

  it('только премиальная; пустая — как ноль', () => {
    expect(recalcTermsNotes(salary('180000.00'), salary('180000.00', '10000.00')))
      .toEqual([`премиальная 0,00 → 10${NBSP}000,00`]);
    expect(recalcTermsNotes(salary('180000.00', '0.00'), salary('180000.00'))).toEqual([]);
  });

  it('оклад и премиальная — две подписи', () => {
    expect(recalcTermsNotes(salary('100000.00', '1000.00'), salary('120000.00', '2000.00'))).toEqual([
      `оклад 100${NBSP}000,00 → 120${NBSP}000,00`,
      `премиальная 1${NBSP}000,00 → 2${NBSP}000,00`,
    ]);
  });

  it('смена вида оплаты', () => {
    expect(recalcTermsNotes(salary('180000.00'), hourly('800.0000')))
      .toEqual([`оклад 180${NBSP}000,00 → ставка 800 ₽/ч`]);
  });

  it('нет условий с одной стороны — без подписи', () => {
    expect(recalcTermsNotes(null, salary('180000.00'))).toEqual([]);
    expect(recalcTermsNotes(salary('180000.00'), null)).toEqual([]);
  });

  it('разница записи суммы не считается изменением', () => {
    expect(recalcTermsNotes(salary('180000'), salary('180000.00'))).toEqual([]);
  });
});

describe('recalcTotalView', () => {
  it('плюс — к доплате', () => {
    expect(recalcTotalView('20000.00')).toMatchObject({ label: 'К доплате (с НДФЛ)', amount: 20000, action: 'Доплачено' });
  });

  it('минус — переплата, сумма без минуса', () => {
    expect(recalcTotalView('-1500.50')).toMatchObject({ label: 'Переплата (с НДФЛ)', amount: 1500.5, action: 'Учтено' });
  });
});
