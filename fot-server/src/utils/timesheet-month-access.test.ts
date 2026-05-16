import { describe, expect, it } from 'vitest';

import {
  isDepartmentMonthAllowed,
  isTimesheetWindowExempt,
  monthAccessFromUser,
} from './timesheet-month-access.js';

// Фиксированная точка отсчёта: май 2026.
const REF = new Date(2026, 4, 16);

describe('isDepartmentMonthAllowed', () => {
  it('окно 1/1 (дефолт): пред., текущий, след. месяцы разрешены', () => {
    expect(isDepartmentMonthAllowed(2026, 4, { referenceDate: REF })).toBe(true); // апрель
    expect(isDepartmentMonthAllowed(2026, 5, { referenceDate: REF })).toBe(true); // май
    expect(isDepartmentMonthAllowed(2026, 6, { referenceDate: REF })).toBe(true); // июнь
  });

  it('окно 1/1: за пределами — запрещено', () => {
    expect(isDepartmentMonthAllowed(2026, 3, { referenceDate: REF })).toBe(false); // март
    expect(isDepartmentMonthAllowed(2026, 7, { referenceDate: REF })).toBe(false); // июль
  });

  it('forward учитывается отдельно от back (регресс: «вперёд не работало»)', () => {
    expect(
      isDepartmentMonthAllowed(2026, 6, { monthsBack: 1, monthsForward: 1, referenceDate: REF }),
    ).toBe(true);
    expect(
      isDepartmentMonthAllowed(2026, 6, { monthsBack: 1, monthsForward: 0, referenceDate: REF }),
    ).toBe(false);
  });

  it('окно 0/0: разрешён только текущий месяц', () => {
    expect(isDepartmentMonthAllowed(2026, 5, { monthsBack: 0, monthsForward: 0, referenceDate: REF })).toBe(true);
    expect(isDepartmentMonthAllowed(2026, 4, { monthsBack: 0, monthsForward: 0, referenceDate: REF })).toBe(false);
    expect(isDepartmentMonthAllowed(2026, 6, { monthsBack: 0, monthsForward: 0, referenceDate: REF })).toBe(false);
  });

  it('широкое окно через границу года', () => {
    expect(
      isDepartmentMonthAllowed(2026, 2, { monthsBack: 3, monthsForward: 3, referenceDate: REF }),
    ).toBe(true); // февраль (back 3)
    expect(
      isDepartmentMonthAllowed(2026, 8, { monthsBack: 3, monthsForward: 3, referenceDate: REF }),
    ).toBe(true); // август (forward 3)
    expect(
      isDepartmentMonthAllowed(2026, 1, { monthsBack: 3, monthsForward: 3, referenceDate: REF }),
    ).toBe(false); // январь — вне
  });

  it('некорректные границы откатываются к дефолту 1/1', () => {
    expect(isDepartmentMonthAllowed(2026, 6, { monthsForward: undefined, referenceDate: REF })).toBe(true);
    expect(isDepartmentMonthAllowed(2026, 4, { monthsBack: -5, referenceDate: REF })).toBe(true);
    expect(isDepartmentMonthAllowed(2026, 3, { monthsBack: -5, referenceDate: REF })).toBe(false);
  });

  it('monthAccessFromUser пробрасывает окно из req.user', () => {
    const opts = monthAccessFromUser({ timesheet_months_back: 2, timesheet_months_forward: 0 });
    expect(opts).toEqual({ monthsBack: 2, monthsForward: 0 });
    expect(isDepartmentMonthAllowed(2026, 3, { ...opts, referenceDate: REF })).toBe(true);
    expect(isDepartmentMonthAllowed(2026, 6, { ...opts, referenceDate: REF })).toBe(false);
  });
});

describe('isTimesheetWindowExempt', () => {
  it('админ (is_admin) освобождён даже при scope=department', () => {
    expect(isTimesheetWindowExempt({ is_admin: true }, 'department')).toBe(true);
  });

  it('обычный руководитель (department, не админ) — не освобождён', () => {
    expect(isTimesheetWindowExempt({ is_admin: false }, 'department')).toBe(false);
    expect(isTimesheetWindowExempt({}, 'department')).toBe(false);
  });

  it('scope не department — освобождён независимо от is_admin', () => {
    expect(isTimesheetWindowExempt({ is_admin: false }, 'all')).toBe(true);
    expect(isTimesheetWindowExempt({ is_admin: false }, null)).toBe(true);
    expect(isTimesheetWindowExempt({ is_admin: false }, undefined)).toBe(true);
  });
});
