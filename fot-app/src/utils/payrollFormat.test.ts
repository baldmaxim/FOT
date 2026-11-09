import { describe, expect, it } from 'vitest';

import { formatPayrollRubles, groupMoneyInput } from './payrollFormat';

/** toLocaleString ставит неразрывные пробелы — сравниваем с обычными. */
const plain = (value: string | null): string | null => value?.replace(/\s/g, ' ') ?? null;

describe('formatPayrollRubles', () => {
  it('целые рубли — без копеек', () => {
    expect(plain(formatPayrollRubles('250000.00'))).toBe('250 000 ₽');
    expect(plain(formatPayrollRubles(250000))).toBe('250 000 ₽');
    expect(plain(formatPayrollRubles('0'))).toBe('0 ₽');
  });

  it('копейки есть — две цифры', () => {
    expect(plain(formatPayrollRubles('147240.33'))).toBe('147 240,33 ₽');
    expect(plain(formatPayrollRubles('7240.3'))).toBe('7 240,30 ₽');
    // Сумма из float: 0,1 + 0,2 — это 30 копеек, а не «хвост».
    expect(plain(formatPayrollRubles(0.1 + 0.2))).toBe('0,30 ₽');
  });

  it('пусто и не число — null', () => {
    expect(formatPayrollRubles(null)).toBeNull();
    expect(formatPayrollRubles(undefined)).toBeNull();
    expect(formatPayrollRubles('')).toBeNull();
    expect(formatPayrollRubles('abc')).toBeNull();
  });
});

describe('groupMoneyInput', () => {
  it('целая часть — с разрядами', () => {
    expect(plain(groupMoneyInput('130000'))).toBe('130 000');
    expect(plain(groupMoneyInput('2730'))).toBe('2 730');
    expect(plain(groupMoneyInput('999'))).toBe('999');
    expect(plain(groupMoneyInput('1234567890'))).toBe('1 234 567 890');
    expect(groupMoneyInput('')).toBe('');
  });

  it('дробная часть — через запятую, как набрана', () => {
    expect(plain(groupMoneyInput('1250.5'))).toBe('1 250,5');
    expect(plain(groupMoneyInput('1250,'))).toBe('1 250,');
    expect(plain(groupMoneyInput('450.1234'))).toBe('450,1234');
    // Лишний знак не обрезается: ошибку под полем покажет разбор.
    expect(plain(groupMoneyInput('1234,567'))).toBe('1 234,567');
  });

  it('не число — как набрано', () => {
    expect(groupMoneyInput('12а')).toBe('12а');
    expect(groupMoneyInput('-5000')).toBe('-5000');
    expect(groupMoneyInput(',5')).toBe(',5');
  });

  it('повтор не меняет результат', () => {
    for (const raw of ['130000', '1250.5', '1 250,5', '12а']) {
      expect(groupMoneyInput(groupMoneyInput(raw))).toBe(groupMoneyInput(raw));
    }
  });
});
