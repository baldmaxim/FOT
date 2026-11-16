import { describe, expect, it } from 'vitest';

import { isSalaryByHoursMonth, SALARY_BY_HOURS_FROM } from './payroll-salary-hours.js';

describe('оклад по часам: месяц перехода', () => {
  it('с ноября 2026 — по часам, в обоих форматах месяца', () => {
    expect(SALARY_BY_HOURS_FROM).toBe('2026-11');
    expect(isSalaryByHoursMonth('2026-11')).toBe(true);
    expect(isSalaryByHoursMonth('2026-11-01')).toBe(true);
    expect(isSalaryByHoursMonth('2027-01-01')).toBe(true);
    expect(isSalaryByHoursMonth('2026-10')).toBe(false);
    expect(isSalaryByHoursMonth('2026-10-31')).toBe(false);
  });
});
