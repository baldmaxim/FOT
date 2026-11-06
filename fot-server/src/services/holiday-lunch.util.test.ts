import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

import type { IProductionCalendarMonth, IResolvedSchedule } from '../types/index.js';
import { getHolidayLunchHours, getPaidLunchMinutes, isLunchFreeHoliday } from './holiday-lunch.util.js';

const schedule = (over: Partial<IResolvedSchedule> = {}): IResolvedSchedule => ({
  schedule_id: 's-1',
  schedule_type: 'office',
  work_start: '09:00:00',
  work_end: '18:00:00',
  work_hours: 8,
  work_days: [1, 2, 3, 4, 5],
  office_days: null,
  late_threshold_minutes: 0,
  day_overrides: null,
  lunch_minutes: 60,
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
  ...over,
});

const calendar = (over: Partial<IProductionCalendarMonth> = {}): IProductionCalendarMonth => ({
  year: 2026,
  month: 11,
  norm_days: 20,
  norm_hours: 159,
  holidays: ['2026-10-31', '2026-11-01', '2026-11-04', '2026-06-12'],
  mandatory_holidays: [],
  pre_holidays: ['2026-11-03'],
  ...over,
});

const at = (iso: string): Date => {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day);
};

describe('isLunchFreeHoliday', () => {
  it.each([
    ['2026-10-31', false, 'последний день до начала правила'],
    ['2026-11-01', true, 'первый день правила'],
    ['2026-11-04', true, 'праздник из календаря'],
    ['2026-06-12', false, 'праздник до начала правила'],
    ['2026-11-03', false, 'предпраздничный день'],
    ['2026-11-05', false, 'обычный день'],
  ])('%s → %s (%s)', (iso, expected) => {
    expect(isLunchFreeHoliday(at(iso), calendar())).toBe(expected);
  });

  it('обязательный праздник тоже считается', () => {
    const value = calendar({ holidays: [], mandatory_holidays: ['2026-11-04'] });
    expect(isLunchFreeHoliday(at('2026-11-04'), value)).toBe(true);
  });

  it('без календаря праздника нет', () => {
    expect(isLunchFreeHoliday(at('2026-11-04'), null)).toBe(false);
  });
});

describe('getPaidLunchMinutes', () => {
  it.each([[true], [false]])('праздник: обед не вычитается при respects_holidays=%s', (respects) => {
    expect(getPaidLunchMinutes(schedule({ respects_holidays: respects }), at('2026-11-04'), calendar())).toBe(0);
  });

  it('обычный день и праздник до начала правила — обед графика', () => {
    expect(getPaidLunchMinutes(schedule(), at('2026-11-05'), calendar())).toBe(60);
    expect(getPaidLunchMinutes(schedule(), at('2026-06-12'), calendar())).toBe(60);
  });

  it('свой обед дня работает и в обычный день', () => {
    const value = schedule({
      day_overrides: { 4: { work_start: '09:00', work_end: '18:00', work_hours: 8.5, lunch_minutes: 30 } },
    } as unknown as Partial<IResolvedSchedule>);
    expect(getPaidLunchMinutes(value, at('2026-11-05'), calendar())).toBe(30);
  });
});

describe('getHolidayLunchHours', () => {
  it('в праздник — обед дня в часах', () => {
    expect(getHolidayLunchHours(schedule(), at('2026-11-04'), calendar())).toBe(1);
    expect(getHolidayLunchHours(schedule({ lunch_minutes: 30 }), at('2026-11-04'), calendar())).toBe(0.5);
    expect(getHolidayLunchHours(schedule({ lunch_minutes: 0 }), at('2026-11-04'), calendar())).toBe(0);
  });

  it('в обычный день и до начала правила — ноль', () => {
    expect(getHolidayLunchHours(schedule(), at('2026-11-05'), calendar())).toBe(0);
    expect(getHolidayLunchHours(schedule(), at('2026-06-12'), calendar())).toBe(0);
    expect(getHolidayLunchHours(schedule(), at('2026-11-04'), null)).toBe(0);
  });
});
