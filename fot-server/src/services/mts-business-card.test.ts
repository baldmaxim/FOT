import { describe, it, expect } from 'vitest';
import { mtsBusinessCdrService } from './mts-business-cdr.service.js';
import { summarizeMonthExpenses } from './mts-business-expenses.service.js';
import { findSubscriberInHierarchy, type IMtsHierarchy } from './mts-business-catalog.service.js';

describe('МТС Бизнес: категоризация строк выписки (parseStatementUsages)', () => {
  it('раскладывает Usages по категориям и берёт сумму списания', () => {
    const stmt = {
      Usages: [
        { Characteristics: { networkEvent: 'call', factUnitCode: 'SECOND', factUnits: 60, cost: 5 } },
        { Characteristics: { networkEvent: 'sms', factUnitCode: 'ITEM', amount: 2 } },
        { Characteristics: { networkEvent: 'gprs', factUnitCode: 'BYTE', cost: 10 } },
        { Characteristics: { categoryId: 'subscription_fee', charge: 300 } },
        { Characteristics: { categoryId: 'one_time_service', amount: 50 } },
        { Characteristics: { networkEvent: 'other', cost: 1 } },
      ],
    };
    expect(mtsBusinessCdrService.parseStatementUsages(stmt)).toEqual([
      { category: 'calls', amount: 5, date: null },
      { category: 'sms', amount: 2, date: null },
      { category: 'internet', amount: 10, date: null },
      { category: 'periodic', amount: 300, date: null },
      { category: 'oneTime', amount: 50, date: null },
      { category: 'other', amount: 1, date: null },
    ]);
  });

  it('пустой/некорректный вход → []', () => {
    expect(mtsBusinessCdrService.parseStatementUsages(null)).toEqual([]);
    expect(mtsBusinessCdrService.parseStatementUsages({})).toEqual([]);
    expect(mtsBusinessCdrService.parseStatementUsages({ Usages: [] })).toEqual([]);
  });

  it('сумма берётся по модулю (расход всегда ≥0)', () => {
    const stmt = { Usages: [{ Characteristics: { networkEvent: 'call', cost: -7 } }] };
    expect(mtsBusinessCdrService.parseStatementUsages(stmt)).toEqual([{ category: 'calls', amount: 7, date: null }]);
  });

  it('пополнение ЛС (income/payment) не расход: исключается из расходов и из суммы начислений', () => {
    // Реальный кейс 07.07.2026: «Регистрация платежа: Безналичный платёж…»
    // на 434 700,69 ₽ попадает в выписку каждого номера контракта.
    const stmt = {
      Usages: [
        {
          date: '2026-06-24T03:02:13+03:00',
          type: 'income',
          amount: 434700.69,
          Characteristics: { categoryId: 'payment', label: 'Регистрация платежа: Безналичный платеж (списание денежных средств с расчетного счета плательщика) (4)' },
        },
        { date: '2026-06-25T10:00:00+03:00', type: 'network', amount: 5, Characteristics: { networkEvent: 'call', factUnitCode: 'SECOND' } },
        { date: '2026-07-01T00:00:00+03:00', type: 'periodical', amount: 490, Characteristics: { categoryId: 'subscription_fee' } },
      ],
    };
    expect(mtsBusinessCdrService.parseStatementUsages(stmt)).toEqual([
      { category: 'calls', amount: 5, date: '2026-06-25' },
      { category: 'periodic', amount: 490, date: '2026-07-01' },
    ]);
    expect(mtsBusinessCdrService.sumStatementCharges(stmt)).toBe(495);
  });

  it('fromDate отсекает строки раньше 1-го числа (начисления месяц-to-date)', () => {
    const stmt = {
      Usages: [
        { date: '2026-06-25T10:00:00+03:00', type: 'network', amount: 5, Characteristics: { networkEvent: 'call' } },
        { date: '2026-07-02T10:00:00+03:00', type: 'network', amount: 3, Characteristics: { networkEvent: 'call' } },
        { type: 'periodical', amount: 490, Characteristics: { categoryId: 'subscription_fee' } }, // без даты — не отсекается
      ],
    };
    expect(mtsBusinessCdrService.sumStatementCharges(stmt, '2026-07-01')).toBe(493);
    expect(mtsBusinessCdrService.sumStatementCharges(stmt)).toBe(498);
  });

  it('sumStatementChargesByDay: группировка по дню расхода, без даты — в fallback-день, income/topups мимо', () => {
    const stmt = {
      Usages: [
        { date: '2026-07-02T10:00:00+03:00', type: 'network', amount: 3, Characteristics: { networkEvent: 'call' } },
        { date: '2026-07-02T18:30:00+03:00', type: 'network', amount: 2, Characteristics: { networkEvent: 'sms', factUnitCode: 'ITEM' } },
        { date: '2026-07-05T00:00:00+03:00', type: 'periodical', amount: 490, Characteristics: { categoryId: 'subscription_fee' } },
        { type: 'network', amount: 1.5, Characteristics: { networkEvent: 'gprs' } }, // без даты → fallback
        { date: '2026-07-03T03:02:13+03:00', type: 'income', amount: 434700.69, Characteristics: { categoryId: 'payment' } },
      ],
    };
    const perDay = mtsBusinessCdrService.sumStatementChargesByDay(stmt, '2026-07-01', '2026-07-06');
    expect([...perDay.entries()].sort()).toEqual([
      ['2026-07-02', 5],
      ['2026-07-05', 490],
      ['2026-07-06', 1.5],
    ]);
  });
});

describe('МТС Бизнес: сводка расходов за месяц (summarizeMonthExpenses)', () => {
  it('суммирует по категориям, пополнения — отдельно, total без пополнений', () => {
    const usages = [
      { category: 'calls' as const, amount: 5 },
      { category: 'calls' as const, amount: 3 },
      { category: 'sms' as const, amount: 2 },
      { category: 'internet' as const, amount: 10 },
    ];
    const payments = [{ date: '2026-07-01', amount: 500, method: 'card', currencyCode: 'RUB' }];
    const sum = summarizeMonthExpenses(usages, payments);
    expect(sum.calls).toEqual({ count: 2, amount: 8 });
    expect(sum.sms).toEqual({ count: 1, amount: 2 });
    expect(sum.internet).toEqual({ count: 1, amount: 10 });
    expect(sum.topups).toEqual({ count: 1, amount: 500 });
    expect(sum.total).toBe(20); // 8 + 2 + 10, пополнения не входят
  });

  it('пустые входы → нули', () => {
    const sum = summarizeMonthExpenses([], []);
    expect(sum.total).toBe(0);
    expect(sum.calls).toEqual({ count: 0, amount: 0 });
    expect(sum.topups).toEqual({ count: 0, amount: 0 });
  });

  it('платёж без суммы пропускается', () => {
    const sum = summarizeMonthExpenses([], [{ date: null, amount: null, method: null, currencyCode: null }]);
    expect(sum.topups).toEqual({ count: 0, amount: 0 });
  });
});

describe('МТС Бизнес: выбор номера в структуре абонента (findSubscriberInHierarchy)', () => {
  const hierarchy: IMtsHierarchy = {
    organizationName: 'ООО Ромашка',
    contractId: 'C-1',
    inn: '7700000000',
    kpp: '770001001',
    accounts: ['277308204324'],
    numbers: [
      { msisdn: '79001234567', accountNo: '277308204324', region: 'Москва', imsi: '250011234567890', sim: '8970101', iccid: '8970101' },
    ],
  };

  it('находит по нормализованному номеру (8… ⇒ 7…)', () => {
    expect(findSubscriberInHierarchy(hierarchy, '89001234567')?.msisdn).toBe('79001234567');
    expect(findSubscriberInHierarchy(hierarchy, '+7 900 123-45-67')?.imsi).toBe('250011234567890');
  });

  it('нет номера / нет структуры → null', () => {
    expect(findSubscriberInHierarchy(hierarchy, '79007654321')).toBeNull();
    expect(findSubscriberInHierarchy(null, '79001234567')).toBeNull();
    expect(findSubscriberInHierarchy(hierarchy, 'abc')).toBeNull();
  });
});
