import { describe, expect, it } from 'vitest';
import { addIsoDays } from './staffControlPage.helpers';

describe('addIsoDays', () => {
  it('переходит через конец месяца', () => {
    expect(addIsoDays('2026-08-31', 1)).toBe('2026-09-01');
  });

  it('переходит через конец года', () => {
    expect(addIsoDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('учитывает високосный февраль', () => {
    expect(addIsoDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addIsoDays('2028-02-29', 1)).toBe('2028-03-01');
    expect(addIsoDays('2027-02-28', 1)).toBe('2027-03-01');
  });
});
