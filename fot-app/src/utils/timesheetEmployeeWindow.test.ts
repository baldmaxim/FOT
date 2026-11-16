import { describe, expect, it } from 'vitest';

import { getInactiveFromDate, isDateInactiveForEmployee, isDayInactiveForEmployee } from './timesheetEmployeeWindow';

describe('окно строки табеля', () => {
  it('выход — раньшая из дат перевода и исключения', () => {
    expect(getInactiveFromDate({ transferred_out_date: '2026-11-20', excluded_from_timesheet_date: '2026-11-10' })).toBe('2026-11-10');
    expect(getInactiveFromDate({ transferred_out_date: '2026-11-20' })).toBe('2026-11-20');
    expect(getInactiveFromDate({})).toBeNull();
  });

  it('с даты выхода и до даты входа — вне окна', () => {
    const employee = { joined_date: '2026-11-05', transferred_out_date: '2026-11-20' };
    expect(isDateInactiveForEmployee(employee, '2026-11-04')).toBe(true);
    expect(isDateInactiveForEmployee(employee, '2026-11-05')).toBe(false);
    expect(isDateInactiveForEmployee(employee, '2026-11-19')).toBe(false);
    expect(isDateInactiveForEmployee(employee, '2026-11-20')).toBe(true);
    expect(isDayInactiveForEmployee(employee, 2026, 11, 4)).toBe(true);
  });
});
