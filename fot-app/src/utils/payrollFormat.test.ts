import { describe, expect, it } from 'vitest';

import { formatPayrollRubles } from './payrollFormat';

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
