import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

import {
  calcVacationBalance,
  countAccrualMonths,
  hundredthsToDays,
  resolveBalanceStart,
} from './payroll-vacation.service.js';

// Остаток отпуска: месяцы начисления, 2,33 как в 1С, ст. 121, сотые без float.

const FROM_1C = { source: '1c' as const, as_of: '2026-09-30', opening_days: '7.21', start: '2026-10-01' };

describe('countAccrualMonths', () => {
  it('месяцы от остатка 1С засчитываются по окончании', () => {
    expect(countAccrualMonths('2026-10-01', '2026-10-21', false)).toBe(0);
    expect(countAccrualMonths('2026-10-01', '2026-10-30', false)).toBe(0);
    expect(countAccrualMonths('2026-10-01', '2026-10-31', false)).toBe(1);
    expect(countAccrualMonths('2026-10-01', '2027-09-30', false)).toBe(12);
  });

  it('хвост от 15 дней — целый месяц, меньше — не считается', () => {
    expect(countAccrualMonths('2026-10-01', '2026-11-20', true)).toBe(2);
    expect(countAccrualMonths('2026-10-01', '2026-11-14', true)).toBe(1);
    expect(countAccrualMonths('2026-10-01', '2026-11-15', true)).toBe(2);
  });

  it('новый сотрудник — месяцы рабочего года от даты приёма', () => {
    expect(countAccrualMonths('2026-10-15', '2026-10-21', true)).toBe(0);
    expect(countAccrualMonths('2026-10-15', '2026-10-29', true)).toBe(1);
    expect(countAccrualMonths('2026-10-15', '2026-11-14', true)).toBe(1);
    // Приём 16.02: к 30.09 — 7 полных месяцев + 15 дней = 8 (как у 1С: 18,64).
    expect(countAccrualMonths('2026-02-16', '2026-09-30', true)).toBe(8);
  });

  it('нет такого числа в месяце — последний день месяца', () => {
    // 31.01 + 1 мес. = 28.02: первый месяц — 31.01–27.02.
    expect(countAccrualMonths('2027-01-31', '2027-02-27', false)).toBe(1);
    expect(countAccrualMonths('2027-01-31', '2027-02-26', false)).toBe(0);
  });

  it('конец раньше начала — ноль', () => {
    expect(countAccrualMonths('2026-10-01', '2026-09-30', true)).toBe(0);
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

  it('строка 1С — счёт со следующего дня', () => {
    expect(resolveBalanceStart({ ...base, opening_as_of: '2026-09-30', opening_days: '7.21' }))
      .toEqual(FROM_1C);
  });

  it('принят после выгрузки 1С — ноль с даты приёма', () => {
    expect(resolveBalanceStart({ ...base, hire_date: '2026-10-15' }))
      .toEqual({ source: 'hire', as_of: '2026-10-15', opening_days: '0.00', start: '2026-10-15' });
  });

  it('принят до выгрузки без строки 1С или выгрузок нет — остатка нет', () => {
    expect(resolveBalanceStart(base)).toBeNull();
    expect(resolveBalanceStart({ ...base, hire_date: '2026-10-15', last_as_of: null })).toBeNull();
    expect(resolveBalanceStart({ ...base, hire_date: null })).toBeNull();
  });
});

describe('calcVacationBalance', () => {
  it('остаток 1С без начисления в текущем месяце', () => {
    expect(calcVacationBalance(FROM_1C, '2026-10-21', null, 0, 0)).toEqual({
      source: '1c', as_of: '2026-09-30', opening_days: '7.21', until: '2026-10-21',
      accrued_months: 0, accrued_days: '0.00', used_days: 0, unpaid_excess_days: 0, current_days: '7.21',
    });
  });

  it('отпуск после 30.09 вычитается (Анофренков: 6,95 − 9)', () => {
    const balance = calcVacationBalance({ ...FROM_1C, opening_days: '6.95' }, '2026-10-21', null, 9, 0);
    expect(balance.current_days).toBe('-2.05');
  });

  it('по 2,33 за месяц: к 30.11 — 7,21 + 4,66', () => {
    const balance = calcVacationBalance(FROM_1C, '2026-11-30', null, 0, 0);
    expect(balance.accrued_months).toBe(2);
    expect(balance.accrued_days).toBe('4.66');
    expect(balance.current_days).toBe('11.87');
  });

  it('уволенный: счёт по день увольнения, месяц увольнения от 15 дней засчитан', () => {
    const balance = calcVacationBalance(FROM_1C, '2027-01-10', '2026-11-20', 0, 0);
    expect(balance.until).toBe('2026-11-20');
    expect(balance.accrued_months).toBe(2);
  });

  it('увольнение в будущем — считаем на сегодня', () => {
    const balance = calcVacationBalance(FROM_1C, '2026-11-20', '2026-12-31', 0, 0);
    expect(balance.until).toBe('2026-11-20');
    expect(balance.accrued_months).toBe(1);
  });

  it('ст. 121: «без сохранения» сверх 14 дней сдвигает конец начисления', () => {
    // К 31.10 октябрь закончился бы, но 6 дней сверх 14 сдвигают конец на 25.10.
    const balance = calcVacationBalance(FROM_1C, '2026-10-31', null, 0, 6);
    expect(balance.accrued_months).toBe(0);
    expect(balance.unpaid_excess_days).toBe(6);
  });

  it('отрицательный остаток 1С сохраняет знак', () => {
    const balance = calcVacationBalance({ ...FROM_1C, opening_days: '-11.71' }, '2026-10-21', null, 9, 0);
    expect(balance.opening_days).toBe('-11.71');
    expect(balance.current_days).toBe('-20.71');
  });
});
