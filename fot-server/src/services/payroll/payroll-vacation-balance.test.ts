import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

import {
  calcAccrual,
  calcVacationBalance,
  hundredthsToDays,
  resolveBalanceStart,
} from './payroll-vacation.service.js';

// Остаток отпуска: начисление по дням (2,33 за месяц, как в 1С), увольнение от 15 дней, ст. 121, сотые без float.

const FROM_1C = {
  source: '1c' as const, as_of: '2026-09-30', opening_days: '7.21', start: '2026-10-01', accrual_from: '2026-10-01',
  vacations_from: '2026-09-30',
};

/** Есенов: остаток 1С на 31.10 — 13,98. */
const ESENOV = {
  source: '1c' as const, as_of: '2026-10-31', opening_days: '13.98', start: '2026-11-01', accrual_from: '2026-11-01',
  vacations_from: '2026-10-31',
};

describe('calcAccrual', () => {
  it('текущий месяц — доля по прошедшим дням, в последний день — 2,33 целиком', () => {
    expect(calcAccrual('2026-11-01', '2026-11-10', false)).toEqual({ months: 0, hundredths: 78 });
    expect(calcAccrual('2026-11-01', '2026-11-11', false)).toEqual({ months: 0, hundredths: 85 });
    expect(calcAccrual('2026-11-01', '2026-11-20', false)).toEqual({ months: 0, hundredths: 155 });
    expect(calcAccrual('2026-11-01', '2026-11-29', false)).toEqual({ months: 0, hundredths: 225 });
    expect(calcAccrual('2026-11-01', '2026-11-30', false)).toEqual({ months: 1, hundredths: 233 });
    // Половина сотой — вверх: 233 × 15 / 30 = 116,5.
    expect(calcAccrual('2026-11-01', '2026-11-15', false)).toEqual({ months: 0, hundredths: 117 });
  });

  it('прошедшие месяцы — по 2,33, текущий — долей', () => {
    expect(calcAccrual('2026-10-01', '2026-11-01', false)).toEqual({ months: 1, hundredths: 241 });
    expect(calcAccrual('2026-10-01', '2027-09-30', false)).toEqual({ months: 12, hundredths: 2796 });
  });

  it('месяц приёма — от даты приёма, к концу месяца целиком, как в 1С', () => {
    // Приём 18.11: на 25.11 — 8 из 13 дней.
    expect(calcAccrual('2026-11-18', '2026-11-25', false)).toEqual({ months: 0, hundredths: 143 });
    expect(calcAccrual('2026-11-18', '2026-11-30', false)).toEqual({ months: 1, hundredths: 233 });
    // Лис: приём 28.09, у 1С на 30.09 — 2,33. Захаров: приём 16.02, у 1С на 30.09 — 8 мес.
    expect(calcAccrual('2026-09-28', '2026-09-30', false)).toEqual({ months: 1, hundredths: 233 });
    expect(calcAccrual('2026-02-16', '2026-09-30', false)).toEqual({ months: 8, hundredths: 1864 });
  });

  it('месяц увольнения — 2,33 от 15 дней, без доли', () => {
    expect(calcAccrual('2026-10-01', '2026-11-14', true)).toEqual({ months: 1, hundredths: 233 });
    expect(calcAccrual('2026-10-01', '2026-11-15', true)).toEqual({ months: 2, hundredths: 466 });
    expect(calcAccrual('2026-10-01', '2026-11-20', true)).toEqual({ months: 2, hundredths: 466 });
    // Принят и уволен в одном месяце: дни — с даты приёма.
    expect(calcAccrual('2026-11-05', '2026-11-18', true)).toEqual({ months: 0, hundredths: 0 });
    expect(calcAccrual('2026-11-05', '2026-11-19', true)).toEqual({ months: 1, hundredths: 233 });
  });

  it('февраль: 28 или 29 дней', () => {
    expect(calcAccrual('2028-02-01', '2028-02-28', false)).toEqual({ months: 0, hundredths: 225 });
    expect(calcAccrual('2028-02-01', '2028-02-29', false)).toEqual({ months: 1, hundredths: 233 });
    expect(calcAccrual('2027-02-01', '2027-02-28', false)).toEqual({ months: 1, hundredths: 233 });
  });

  it('конец раньше начала — ноль', () => {
    expect(calcAccrual('2026-10-01', '2026-09-30', false)).toEqual({ months: 0, hundredths: 0 });
  });
});

describe('hundredthsToDays', () => {
  it('знак и сотые', () => {
    expect(hundredthsToDays(721)).toBe('7.21');
    expect(hundredthsToDays(-1171)).toBe('-11.71');
    expect(hundredthsToDays(-4)).toBe('-0.04');
    expect(hundredthsToDays(0)).toBe('0.00');
  });
});

describe('resolveBalanceStart', () => {
  const base = { hire_date: '2025-11-04', dismissal_date: null, opening_as_of: null, opening_days: null, last_as_of: '2026-09-30' };

  it('строка 1С — «без сохранения» со следующего дня, начисление со следующего месяца, отпуска после даты остатка', () => {
    expect(resolveBalanceStart({ ...base, opening_as_of: '2026-09-30', opening_days: '7.21' }))
      .toEqual(FROM_1C);
    // Выгрузка в середине месяца: её месяц 1С уже начислила.
    expect(resolveBalanceStart({ ...base, opening_as_of: '2026-11-15', opening_days: '7.21' }))
      .toMatchObject({ start: '2026-11-16', accrual_from: '2026-12-01', vacations_from: '2026-11-15' });
    expect(resolveBalanceStart({ ...base, opening_as_of: '2026-12-31', opening_days: '7.21' }))
      .toMatchObject({ start: '2027-01-01', accrual_from: '2027-01-01' });
  });

  it('граница учтённых 1С отпусков раньше даты остатка (Овакова: отпуск с 31.10 в 1С нет)', () => {
    expect(resolveBalanceStart({
      ...base, opening_as_of: '2026-10-31', opening_days: '10.28', vacations_through: '2026-10-30',
    })).toMatchObject({ as_of: '2026-10-31', vacations_from: '2026-10-30' });
  });

  it('принят после выгрузки 1С — ноль с даты приёма', () => {
    expect(resolveBalanceStart({ ...base, hire_date: '2026-10-15' })).toEqual({
      source: 'hire', as_of: '2026-10-15', opening_days: '0.00', start: '2026-10-15', accrual_from: '2026-10-15',
      vacations_from: '2026-10-14',
    });
  });

  it('принят до выгрузки без строки 1С или выгрузок нет — остатка нет', () => {
    expect(resolveBalanceStart(base)).toBeNull();
    expect(resolveBalanceStart({ ...base, hire_date: '2026-10-15', last_as_of: null })).toBeNull();
    expect(resolveBalanceStart({ ...base, hire_date: null })).toBeNull();
  });
});

describe('calcVacationBalance', () => {
  it('Есенов: остаток растёт каждый день, в последний день месяца — 2,33 целиком', () => {
    expect(calcVacationBalance(ESENOV, '2026-11-10', null, 0, 0)).toEqual({
      source: '1c', as_of: '2026-10-31', opening_days: '13.98', until: '2026-11-10',
      accrued_months: 0, accrued_days: '0.78', used_days: 0, unpaid_excess_days: 0, current_days: '14.76',
    });
    expect(calcVacationBalance(ESENOV, '2026-11-20', null, 0, 0).current_days).toBe('15.53');
    expect(calcVacationBalance(ESENOV, '2026-11-29', null, 0, 0)).toMatchObject({ accrued_months: 0, current_days: '16.23' });
    expect(calcVacationBalance(ESENOV, '2026-11-30', null, 0, 0)).toMatchObject({ accrued_months: 1, current_days: '16.31' });
  });

  it('в дату остатка 1С — ровно остаток 1С', () => {
    expect(calcVacationBalance(ESENOV, '2026-10-31', null, 0, 0)).toMatchObject({ accrued_days: '0.00', current_days: '13.98' });
  });

  it('отпуск вычитается целиком (Анофренков: 6,95 + 2,33 − 9 на 31.10)', () => {
    const balance = calcVacationBalance({ ...FROM_1C, opening_days: '6.95' }, '2026-10-31', null, 9, 0);
    expect(balance.current_days).toBe('0.28');
  });

  it('уволенный: счёт по день увольнения, месяц увольнения от 15 дней', () => {
    expect(calcVacationBalance(FROM_1C, '2027-01-10', '2026-11-20', 0, 0))
      .toMatchObject({ until: '2026-11-20', accrued_months: 2, accrued_days: '4.66' });
    expect(calcVacationBalance(FROM_1C, '2027-01-10', '2026-11-15', 0, 0).accrued_days).toBe('4.66');
    expect(calcVacationBalance(FROM_1C, '2027-01-10', '2026-11-14', 0, 0))
      .toMatchObject({ accrued_months: 1, accrued_days: '2.33' });
  });

  it('увольнение в будущем — на сегодня, текущий месяц долей', () => {
    expect(calcVacationBalance(FROM_1C, '2026-11-11', '2026-12-20', 0, 0))
      .toMatchObject({ until: '2026-11-11', accrued_months: 1, accrued_days: '3.18' });
  });

  it('ст. 121: «без сохранения» сверх 14 дней сдвигает дневную долю через границу месяца', () => {
    // 11.11 − 20 дней = 22.10: октябрь — 22 из 31 дня, ноябрь — ничего.
    expect(calcVacationBalance(FROM_1C, '2026-11-11', null, 0, 20))
      .toMatchObject({ accrued_months: 0, accrued_days: '1.65', unpaid_excess_days: 20 });
  });

  it('ст. 121: порог увольнения — от сдвинутой даты', () => {
    // Увольнение 20.11, 6 дней сверх 14 → 14.11: в ноябре 14 дней, месяц не засчитан.
    expect(calcVacationBalance(FROM_1C, '2026-12-01', '2026-11-20', 0, 6))
      .toMatchObject({ accrued_months: 1, accrued_days: '2.33' });
  });

  it('отрицательный остаток 1С сохраняет знак', () => {
    const balance = calcVacationBalance({ ...FROM_1C, opening_days: '-11.71' }, '2026-10-31', null, 9, 0);
    expect(balance.opening_days).toBe('-11.71');
    expect(balance.current_days).toBe('-18.38');
  });
});
