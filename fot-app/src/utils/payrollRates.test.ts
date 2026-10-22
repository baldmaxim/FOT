import { describe, expect, it } from 'vitest';

import { nextRateValue, rateFromLabel, rateMonthOptions, rateValueOn, travelAllowance } from './payrollRates';

const VALUES = [
  { effective_from: '2000-01', amount: '2730.00' },
  { effective_from: '2026-11', amount: '3000.00' },
  { effective_from: '2027-03', amount: null },
];

describe('rateValueOn', () => {
  it('значение месяца — последняя запись не позже него; до первой — null', () => {
    expect(rateValueOn(VALUES, '2026-07')).toBe('2730.00');
    expect(rateValueOn(VALUES, '2026-10')).toBe('2730.00');
    expect(rateValueOn(VALUES, '2026-11')).toBe('3000.00');
    expect(rateValueOn(VALUES, '2027-02')).toBe('3000.00');
    expect(rateValueOn(VALUES, '2027-03')).toBeNull();
    expect(rateValueOn(VALUES, '1999-12')).toBeNull();
    expect(rateValueOn([], '2026-10')).toBeNull();
  });

  it('запланированное — первое после текущего месяца', () => {
    expect(nextRateValue(VALUES, '2026-10')).toEqual({ effective_from: '2026-11', amount: '3000.00' });
    expect(nextRateValue(VALUES, '2027-03')).toBeNull();
  });
});

describe('rateMonthOptions', () => {
  it('текущий месяц и 12 следующих, через границу года', () => {
    const options = rateMonthOptions('2026-10');
    expect(options).toHaveLength(13);
    expect(options[0]).toEqual({ value: '2026-10', label: 'с октября 2026' });
    expect(options[3].value).toBe('2027-01');
    expect(options[12].value).toBe('2027-10');
  });
});

describe('rateFromLabel', () => {
  it('месяц в родительном падеже', () => {
    expect(['2026-05', '2026-11', '2027-03'].map(rateFromLabel)).toEqual(['с мая 2026', 'с ноября 2026', 'с марта 2027']);
  });
});

describe('travelAllowance', () => {
  const row = { travel_rate: '2730.00', travel_stopped: false };

  it('офис и ИТР — ставка; рабочие, «Без проезда» и ставка не задана — нет', () => {
    expect(travelAllowance('office', row)).toBe('2730.00');
    expect(travelAllowance('itr', row)).toBe('2730.00');
    expect(travelAllowance('worker', row)).toBeNull();
    expect(travelAllowance('office', { ...row, travel_stopped: true })).toBeNull();
    expect(travelAllowance('office', { travel_rate: null, travel_stopped: false })).toBeNull();
    // Старый бэкенд полей не отдаёт.
    expect(travelAllowance('office', {})).toBeNull();
  });

  it('Офис → Рабочие → Офис: проезд пропадает и возвращается', () => {
    expect(['office', 'worker', 'office'].map(category => travelAllowance(category as 'office' | 'worker', row)))
      .toEqual(['2730.00', null, '2730.00']);
  });
});
