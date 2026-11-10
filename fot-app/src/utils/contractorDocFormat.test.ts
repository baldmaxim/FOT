import { describe, it, expect } from 'vitest';
import {
  citizenshipIsRussia,
  citizenshipNeedsKig,
  digitsOnly,
  formatInnInput,
  formatSnilsInput,
  isValidInn,
  isValidSnils,
} from './contractorDocFormat';

describe('contractorDocFormat', () => {
  it('formatSnilsInput: постепенная маска и обрезка лишнего', () => {
    expect(formatSnilsInput('')).toBe('');
    expect(formatSnilsInput('123')).toBe('123');
    expect(formatSnilsInput('1234')).toBe('123-4');
    expect(formatSnilsInput('1234567')).toBe('123-456-7');
    expect(formatSnilsInput('12345678900')).toBe('123-456-789 00');
    expect(formatSnilsInput('123-456-789 0099')).toBe('123-456-789 00');
    expect(formatSnilsInput(null)).toBe('');
  });

  it('formatInnInput / digitsOnly', () => {
    expect(formatInnInput('7707 0832-8934 55')).toBe('770708328934');
    expect(digitsOnly('123-456 789')).toBe('123456789');
  });

  it('isValidSnils / isValidInn: пусто или точная длина', () => {
    expect(isValidSnils('')).toBe(true);
    expect(isValidSnils('123-456-789 00')).toBe(true);
    expect(isValidSnils('123-456')).toBe(false);
    expect(isValidInn('')).toBe(true);
    expect(isValidInn('770708328934')).toBe(true);
    expect(isValidInn('7707083893')).toBe(false);
  });

  it('citizenshipIsRussia / citizenshipNeedsKig', () => {
    expect(citizenshipIsRussia(' россия ')).toBe(true);
    expect(citizenshipIsRussia('Таджикистан')).toBe(false);
    expect(citizenshipNeedsKig('Таджикистан')).toBe(true);
    expect(citizenshipNeedsKig('Казахстан')).toBe(true);
    expect(citizenshipNeedsKig('Россия')).toBe(false);
    expect(citizenshipNeedsKig('')).toBe(false);
    expect(citizenshipNeedsKig(null)).toBe(false);
  });
});
