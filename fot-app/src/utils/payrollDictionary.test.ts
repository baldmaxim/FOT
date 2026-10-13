import { describe, expect, it } from 'vitest';

import { normalizeDictionaryName, parseRateAmount, rateAmountInputValue } from './payrollDictionary';

describe('справочник «Расчётов»: название', () => {
  it('пробелы по краям срезаются, внутри — схлопываются', () => {
    expect(normalizeDictionaryName('  Штраф   за\tмусор ')).toBe('Штраф за мусор');
    expect(normalizeDictionaryName('   ')).toBe('');
  });
});

describe('справочник «Расчётов»: значение ставки', () => {
  it('пусто — «не задано», а не ноль; ноль — это ноль', () => {
    expect(parseRateAmount('')).toEqual({ amount: null, error: null });
    expect(parseRateAmount('   ')).toEqual({ amount: null, error: null });
    expect(parseRateAmount('0')).toEqual({ amount: 0, error: null });
  });

  it('запятая, точка и пробелы между разрядами', () => {
    expect(parseRateAmount('450')).toEqual({ amount: 450, error: null });
    expect(parseRateAmount('450,5')).toEqual({ amount: 450.5, error: null });
    expect(parseRateAmount('450.55')).toEqual({ amount: 450.55, error: null });
    expect(parseRateAmount(' 1 250,50 ')).toEqual({ amount: 1250.5, error: null });
    expect(parseRateAmount('1 250')).toEqual({ amount: 1250, error: null });
  });

  it('не число, отрицательное, три знака после запятой, слишком большое — ошибка', () => {
    for (const raw of ['abc', '-5', '1,234', '1.2.3', '1e3', ',5', '5,', '10000000000']) {
      const parsed = parseRateAmount(raw);
      expect(parsed.amount, raw).toBeNull();
      expect(parsed.error, raw).toBeTruthy();
    }
    expect(parseRateAmount('9999999999,99')).toEqual({ amount: 9999999999.99, error: null });
  });

  it('значение в поле правки — без хвоста нулей и с запятой; разбирается обратно в то же число', () => {
    expect(rateAmountInputValue('450.50')).toBe('450,5');
    expect(rateAmountInputValue('520.00')).toBe('520');
    expect(rateAmountInputValue('0.00')).toBe('0');
    expect(rateAmountInputValue(1250.75)).toBe('1250,75');
    expect(rateAmountInputValue(null)).toBe('');
    expect(parseRateAmount(rateAmountInputValue('450.50')).amount).toBe(450.5);
  });
});
