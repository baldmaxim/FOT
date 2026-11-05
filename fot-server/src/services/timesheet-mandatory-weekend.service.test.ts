import { describe, expect, it } from 'vitest';
import type { IProductionCalendarMonth, IResolvedSchedule } from '../types/index.js';
import { pickApprovedWeekendDaysInQuota, splitShiftBetweenObjects } from './timesheet-mandatory-weekend.service.js';

// График как на проде: цикл 5+2 со слотом субботы и воскресенья 0 ч, квота задана отдельно.
const makeQuotaSchedule = (saturdays: number, sundays = 0): IResolvedSchedule => ({
  schedule_id: 'quota',
  schedule_type: 'office',
  work_start: '08:00:00',
  work_end: '19:00:00',
  work_hours: 10,
  work_days: [1, 2, 3, 4, 5],
  office_days: null,
  late_threshold_minutes: 0,
  day_overrides: null,
  lunch_minutes: 60,
  respects_holidays: true,
  pattern_type: 'cycle',
  expected_saturdays_per_month: saturdays,
  expected_sundays_per_month: sundays,
  full_day_threshold_minutes: null,
  weekend_full_day_threshold_minutes: null,
  cycle_length: 7,
  cycle_days: [
    ...Array.from({ length: 5 }, () => ({ work_start: '08:00', work_end: '19:00', work_hours: 10, lunch_minutes: 60 })),
    { work_hours: 0 },
    { work_hours: 0 },
  ],
  anchor_date: '2025-12-29',
  assignment_anchor_date: null,
  source: 'employee',
});

const JUNE_CALENDAR: IProductionCalendarMonth = {
  year: 2026,
  month: 6,
  norm_days: 21,
  norm_hours: 168,
  holidays: ['2026-06-12', '2026-06-13'],
  mandatory_holidays: [],
  pre_holidays: [],
};

const pick = (
  dates: string[],
  planned: string[],
  schedule: IResolvedSchedule,
  calendar: IProductionCalendarMonth | null = null,
): string[] => [...pickApprovedWeekendDaysInQuota(
  dates.map(date => ({ employeeId: 1, date })),
  new Set(planned.map(date => `1|${date}`)),
  () => schedule,
  calendar,
)].sort();

describe('pickApprovedWeekendDaysInQuota — согласованные выходы на свободных местах квоты', () => {
  it('плановая суббота занимает место первой: заявка получает только оставшееся', () => {
    expect(pick(['2026-09-12', '2026-09-19'], ['2026-09-05'], makeQuotaSchedule(2))).toEqual(['1|2026-09-12']);
  });

  it('квота занята плановыми: заявка остаётся выходом сверх квоты', () => {
    expect(pick(['2026-09-19'], ['2026-09-05', '2026-09-12'], makeQuotaSchedule(2))).toEqual([]);
  });

  it('свободные места получают самые ранние выходы, порядок входа не важен', () => {
    expect(pick(['2026-09-26', '2026-09-05', '2026-09-12'], [], makeQuotaSchedule(2)))
      .toEqual(['1|2026-09-05', '1|2026-09-12']);
  });

  it('воскресенье при квоте на субботы не занимает её и в набор не попадает', () => {
    expect(pick(['2026-09-06', '2026-09-12'], [], makeQuotaSchedule(1))).toEqual(['1|2026-09-12']);
  });

  it('квоты суббот и воскресений раздельные', () => {
    expect(pick(['2026-09-05', '2026-09-06', '2026-09-13'], [], makeQuotaSchedule(0, 1))).toEqual(['1|2026-09-06']);
    expect(pick(['2026-09-06'], ['2026-09-05'], makeQuotaSchedule(1, 1))).toEqual(['1|2026-09-06']);
  });

  it('один день в кандидатах дважды занимает одно место', () => {
    expect(pick(['2026-09-05', '2026-09-05', '2026-09-12'], [], makeQuotaSchedule(2)))
      .toEqual(['1|2026-09-05', '1|2026-09-12']);
  });

  it('праздник-будень — в субботней корзине и занимает её место', () => {
    expect(pick(['2026-06-12', '2026-06-20'], [], makeQuotaSchedule(1), JUNE_CALENDAR)).toEqual(['1|2026-06-12']);
  });

  it('плановый праздник-будень считается занятым местом субботней корзины', () => {
    expect(pick(['2026-06-20'], ['2026-06-12'], makeQuotaSchedule(1), JUNE_CALENDAR)).toEqual([]);
  });

  it('праздничная суббота в квоту не входит и места не занимает', () => {
    expect(pick(['2026-06-13', '2026-06-20'], [], makeQuotaSchedule(1), JUNE_CALENDAR)).toEqual(['1|2026-06-20']);
  });

  it('у каждого сотрудника своя квота', () => {
    const picked = pickApprovedWeekendDaysInQuota(
      [{ employeeId: 1, date: '2026-09-12' }, { employeeId: 2, date: '2026-09-12' }],
      new Set(['1|2026-09-05']),
      () => makeQuotaSchedule(1),
      null,
    );
    expect([...picked]).toEqual(['2|2026-09-12']);
  });
});

describe('splitShiftBetweenObjects — сумма строк за день не выше смены', () => {
  const split = (hours: Record<string, number>, shift: number): Record<string, number> => (
    Object.fromEntries(splitShiftBetweenObjects(new Map(Object.entries(hours)), shift))
  );

  it('смена 10, объекты 6 и 7 → 5 и 5', () => {
    expect(split({ a: 6, b: 7 }, 10)).toEqual({ a: 5, b: 5 });
  });

  it('один объект или сумма в пределах смены — делить не нужно', () => {
    expect(split({ a: 13 }, 10)).toEqual({});
    expect(split({ a: 4, b: 5 }, 10)).toEqual({});
    expect(split({ a: 5.1, b: 5.1 }, 10)).toEqual({});
  });

  it('малая доля может стать нулём, сумма всё равно равна смене', () => {
    expect(split({ a: 13.6, b: 0.4 }, 10)).toEqual({ a: 10, b: 0 });
  });

  it('округление трёх строк не выводит сумму за смену', () => {
    const limits = split({ a: 3.5, b: 3.5, c: 2.9 }, 10);
    expect(Object.values(limits).reduce((sum, limit) => sum + limit, 0)).toBe(10);
  });

  it('при равных остатках решает object_key', () => {
    expect(split({ b: 8, a: 8 }, 11)).toEqual({ a: 6, b: 5 });
  });
});
