import { describe, it, expect } from 'vitest';
import { tickBudget } from './mts-business-statement-rolling.service.js';
import { mtsPerSecondLimit } from './mts-business-base.service.js';
import { expenseSummaryFromTotals } from './mts-business-expenses.service.js';
import type { MtsExpenseCategory } from './mts-business-cdr.service.js';

// Непрерывный конвейер свежести: бюджет тика (доля лимита МТС) и секундный
// суб-лимит пакета запросов. Плюс сводка расходов из SQL-агрегата — она должна
// давать те же числа, что «Использование» и ЛК (единый источник statement_rows).

describe('mtsPerSecondLimit', () => {
  it('пакет 60 запросов/мин → не более 3 запросов/сек', () => {
    expect(mtsPerSecondLimit(60)).toBe(3);
  });

  it('пакет 300 запросов/мин → не более 10 запросов/сек', () => {
    expect(mtsPerSecondLimit(300)).toBe(10);
  });
});

describe('tickBudget', () => {
  const TICK_MS = 30_000;

  it('тратит только заданную долю лимита аккаунта', () => {
    // 60/мин × 70% = 42/мин → за полминуты 21 запрос.
    expect(tickBudget(60, 70, TICK_MS)).toBe(21);
  });

  it('доля 30% оставляет запас живым вызовам UI', () => {
    // 60 × 30% = 18/мин → 9 за тик.
    expect(tickBudget(60, 30, TICK_MS)).toBe(9);
  });

  it('не превышает секундный суб-лимит пакета (3/сек × 30с = 90)', () => {
    // 300/мин × 90% = 270/мин → 135 за тик, но пакет 60 разрешает лишь 3/сек.
    // Здесь лимит аккаунта 60 → потолок 90 не достигается, но проверим формулу
    // на пакете 300: 10/сек × 30с = 300 ≥ 135 → ограничивает минутная доля.
    expect(tickBudget(300, 90, TICK_MS)).toBe(135);
    // А узкий тик (2с) у пакета 60 упирается именно в 3/сек: 3 × 2 = 6.
    expect(tickBudget(60, 90, 2_000)).toBe(1); // 54/мин × 2с = 1.8 → floor 1
    expect(tickBudget(600, 90, 2_000)).toBe(18); // 540/мин × 2с = 18, потолок 10/сек × 2с = 20
  });

  it('всегда даёт хотя бы один номер за тик', () => {
    expect(tickBudget(60, 10, 1_000)).toBe(1);
  });
});

describe('expenseSummaryFromTotals', () => {
  it('раскладывает SQL-агрегат по категориям и считает итог без пополнений', () => {
    const totals = new Map<MtsExpenseCategory, { count: number; amount: number }>([
      ['calls', { count: 10, amount: 0 }],
      ['sms', { count: 16, amount: 12.8 }],
      ['internet', { count: 284, amount: 0 }],
      ['periodic', { count: 1, amount: 732.6 }],
    ]);
    const summary = expenseSummaryFromTotals(totals, [
      { amount: 500, dateOfPayment: '2026-07-01T00:00:00+03:00', paymentType: null, currency: null },
    ] as never);

    expect(summary.calls).toEqual({ count: 10, amount: 0 });
    expect(summary.sms).toEqual({ count: 16, amount: 12.8 });
    expect(summary.internet).toEqual({ count: 284, amount: 0 });
    // Пополнения держим отдельным бакетом и НЕ нетим против расходов.
    expect(summary.topups).toEqual({ count: 1, amount: 500 });
    expect(summary.total).toBeCloseTo(745.4, 2);
  });

  it('пустой период → нули, а не падение', () => {
    const summary = expenseSummaryFromTotals(new Map(), []);
    expect(summary.total).toBe(0);
    expect(summary.calls).toEqual({ count: 0, amount: 0 });
  });
});
