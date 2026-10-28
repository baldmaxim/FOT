import { describe, expect, it } from 'vitest';

import type { IResolvedSchedule } from '../types/schedule';
import type { IProductionCalendarMonth } from '../types/timesheet';
import { getCorrectionDefaultHoursForDay } from './scheduleUtils';

const fiveTwo: IResolvedSchedule = {
  schedule_id: 'sched-5-2',
  schedule_type: 'office',
  work_start: '09:00:00',
  work_end: '18:00:00',
  work_hours: 8,
  work_days: [1, 2, 3, 4, 5],
  office_days: null,
  late_threshold_minutes: 0,
  day_overrides: null,
  lunch_minutes: 0,
  respects_holidays: true,
  pattern_type: 'custom',
  expected_saturdays_per_month: 0,
  expected_sundays_per_month: 0,
  full_day_threshold_minutes: null,
  weekend_full_day_threshold_minutes: null,
  cycle_length: null,
  cycle_days: null,
  anchor_date: null,
  assignment_anchor_date: null,
  source: 'employee',
};

// Июнь 2026: 11-е (чт) — предпраздничный, 12-е (пт) — праздник.
const june: IProductionCalendarMonth = {
  year: 2026, month: 6, norm_days: 21, norm_hours: 167, holidays: ['2026-06-12'], mandatory_holidays: [],
  pre_holidays: ['2026-06-11'],
};

describe('часы по умолчанию в окне корректировки дня', () => {
  it('предпраздничный день — норма с −1 ч (11.06.2026: 7, а не 8)', () => {
    expect(getCorrectionDefaultHoursForDay(fiveTwo, june, 2026, 6, 11)).toBe(7);
  });

  it('обычный рабочий день — часы графика; смена 10 ч в предпраздничный — 9', () => {
    expect(getCorrectionDefaultHoursForDay(fiveTwo, june, 2026, 6, 10)).toBe(8);
    expect(getCorrectionDefaultHoursForDay({ ...fiveTwo, work_hours: 10 }, june, 2026, 6, 11)).toBe(9);
  });

  it('выходной и праздник — часы графика, как для выхода; без графика — 8', () => {
    expect(getCorrectionDefaultHoursForDay(fiveTwo, june, 2026, 6, 13)).toBe(8);
    expect(getCorrectionDefaultHoursForDay(fiveTwo, june, 2026, 6, 12)).toBe(8);
    expect(getCorrectionDefaultHoursForDay(undefined, june, 2026, 6, 11)).toBe(8);
  });
});
