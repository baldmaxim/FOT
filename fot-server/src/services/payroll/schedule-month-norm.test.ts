import { describe, expect, it } from 'vitest';

import type { IProductionCalendarMonth, IResolvedSchedule } from '../../types/index.js';
import { getDayNormHours } from '../schedule.service.js';
import { scheduleMonthNorm, toNormPlan } from './schedule-month-norm.js';

// «ЛИНИЯ 5дн +2суб с 01.02.22г 10 час»: цикл 7 дн. с якорем в понедельник, праздники РФ не учитывает.
const line10: IResolvedSchedule = {
  schedule_id: 'line-10',
  name: 'ЛИНИЯ 5дн +2суб с 01.02.22г 10 час',
  schedule_type: 'office',
  work_start: '08:00:00',
  work_end: '19:00:00',
  work_hours: 10,
  work_days: [1, 2, 3, 4, 5],
  office_days: null,
  late_threshold_minutes: 0,
  day_overrides: null,
  lunch_minutes: 60,
  respects_holidays: false,
  pattern_type: 'cycle',
  expected_saturdays_per_month: 2,
  expected_sundays_per_month: 0,
  full_day_threshold_minutes: null,
  weekend_full_day_threshold_minutes: null,
  cycle_length: 7,
  cycle_days: [
    ...Array.from({ length: 5 }, () => ({ work_hours: 10, work_start: '08:00', work_end: '19:00', lunch_minutes: 60 })),
    { work_hours: 0 },
    { work_hours: 0 },
  ],
  anchor_date: '2025-12-29',
  assignment_anchor_date: null,
  source: 'employee',
};

// «5+2» по 8 ч с праздниками РФ.
const office8: IResolvedSchedule = {
  ...line10,
  schedule_id: 'office-8',
  name: 'ОФИС пятидневка',
  work_hours: 8,
  respects_holidays: true,
  pattern_type: 'custom',
  expected_saturdays_per_month: 0,
  cycle_length: null,
  cycle_days: null,
  anchor_date: null,
};

const november: IProductionCalendarMonth = {
  year: 2026, month: 11, norm_days: 20, norm_hours: 159, holidays: ['2026-11-04'], mandatory_holidays: [],
  pre_holidays: ['2026-11-03'],
};

const monthDates = (month: string): string[] => {
  const [year, mon] = month.split('-').map(Number);
  const total = new Date(year, mon, 0).getDate();
  return Array.from({ length: total }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`);
};

const scheduleMap = (month: string, schedule: IResolvedSchedule): Map<string, IResolvedSchedule> => (
  new Map(monthDates(month).map(date => [date, schedule]))
);

/** Прежняя countScheduleMonthNormMinutes (до общего модуля) — эталон: итог не должен сдвинуться ни на минуту. */
const legacyNormMinutes = (
  schedules: ReadonlyMap<string, IResolvedSchedule>,
  month: string,
  calendar: IProductionCalendarMonth | null,
): number | null => {
  const [year, mon] = month.split('-').map(Number);
  let hours = 0;
  let last: IResolvedSchedule | undefined;
  for (const [index, date] of monthDates(month).entries()) {
    last = schedules.get(date);
    if (!last) return null;
    hours += getDayNormHours(last, new Date(year, mon - 1, index + 1), calendar);
  }
  const quota = (last?.expected_saturdays_per_month ?? 0) + (last?.expected_sundays_per_month ?? 0);
  return Math.round((hours + quota * (last?.work_hours ?? 0)) * 60);
};

describe('норма графика по дням (scheduleMonthNorm)', () => {
  it('ЛИНИЯ 10 ч, ноябрь 2026: 21 будний × 10 ч + 2 Сб × 10 ч = 230 ч; снимок — дни с нормой и квота', () => {
    const norm = scheduleMonthNorm(scheduleMap('2026-11', line10), '2026-11', november);
    expect(norm).toMatchObject({ complete: true, saturdays: 2, sundays: 0, quotaHours: 10, totalMinutes: 13800 });
    const plan = toNormPlan(norm);
    expect(Object.keys(plan?.days ?? {})).toHaveLength(21);
    expect(plan).toMatchObject({ saturdays: 2, sundays: 0, quota_minutes: 600 });
    // Праздник 04.11 этот график не учитывает: 10 ч; субботы — не дни, а квота.
    expect(plan?.days['2026-11-04']).toBe(600);
    expect(plan?.days['2026-11-07']).toBeUndefined();
  });

  it('офис 8 ч: праздник 04.11 — 0 (в снимок не идёт), предпраздничный 03.11 — 7 ч', () => {
    const norm = scheduleMonthNorm(scheduleMap('2026-11', office8), '2026-11', november);
    expect(norm.totalMinutes).toBe(159 * 60);
    expect(norm.days.find(day => day.date === '2026-11-04')?.hours).toBe(0);
    expect(toNormPlan(norm)?.days).toMatchObject({ '2026-11-03': 420, '2026-11-05': 480 });
    expect(toNormPlan(norm)?.days['2026-11-04']).toBeUndefined();
  });

  it('итог совпадает с прежней формулой у разных графиков и месяцев', () => {
    for (const month of ['2026-09', '2026-10', '2026-11', '2026-12']) {
      for (const schedule of [line10, office8]) {
        const calendar = month === '2026-11' ? november : null;
        const schedules = scheduleMap(month, schedule);
        expect(scheduleMonthNorm(schedules, month, calendar).totalMinutes).toBe(legacyNormMinutes(schedules, month, calendar));
      }
    }
    // Смена графика в месяце: квота и её часы — из графика последнего дня.
    const mixed = new Map(monthDates('2026-11').map(date => [date, date < '2026-11-16' ? office8 : line10]));
    expect(scheduleMonthNorm(mixed, '2026-11', november).totalMinutes).toBe(legacyNormMinutes(mixed, '2026-11', november));
  });

  it('нет графика хоть на день — нормы и снимка нет, дни с графиком остаются', () => {
    const schedules = scheduleMap('2026-11', line10);
    schedules.delete('2026-11-15');
    const norm = scheduleMonthNorm(schedules, '2026-11', november);
    expect(norm).toMatchObject({ complete: false, totalMinutes: null });
    expect(norm.days).toHaveLength(29);
    expect(toNormPlan(norm)).toBeNull();
  });

  it('те же 230 ч на других датах — другой снимок: итог норму по дням не доказывает', () => {
    // Вт–Сб по 10 ч и 3 субботы квоты: 20 × 10 + 3 × 10 = 230 ч, как у ЛИНИИ, но рабочие даты другие.
    const tueSat: IResolvedSchedule = {
      ...line10, pattern_type: 'custom', cycle_length: null, cycle_days: null, anchor_date: null,
      work_days: [2, 3, 4, 5, 6], expected_saturdays_per_month: 3,
    };
    const line = scheduleMonthNorm(scheduleMap('2026-11', line10), '2026-11', november);
    const shifted = scheduleMonthNorm(scheduleMap('2026-11', tueSat), '2026-11', november);
    expect(shifted.totalMinutes).toBe(line.totalMinutes);
    expect(toNormPlan(shifted)).not.toEqual(toNormPlan(line));
  });
});
