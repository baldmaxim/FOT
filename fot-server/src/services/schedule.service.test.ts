import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pgQuery, pgQueryOne, pgExecute, pgTx } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  pgExecute: vi.fn(),
  pgTx: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: pgExecute,
  withTransaction: pgTx,
}));

import {
  computeCappedFactHours,
  countNormHoursForSchedule,
  getCycleSlot,
  getDayNormHours,
  getFullDayThresholdHoursForDate,
  getScheduleForDate,
  isWorkingDay,
  needsSkudCheck,
  NON_WORKING_STATUSES,
  resolveObjectSchedule,
  resolveObjectSchedulesForPeriod,
} from './schedule.service.js';
import type { IProductionCalendarMonth, IResolvedSchedule } from '../types/index.js';

describe('schedule.service object assignments', () => {
  beforeEach(() => {
    pgQuery.mockReset();
    pgQueryOne.mockReset();
    pgExecute.mockReset();
    pgTx.mockReset();
  });

  it('resolves an object schedule for a single date', async () => {
    pgQueryOne.mockImplementation(async (sql: string) => {
      if (!/object_schedule_assignments/i.test(sql)) {
        throw new Error(`Unexpected SQL: ${sql}`);
      }
      return {
        schedule_id: 'sched-object',
        anchor_date: null,
        work_schedules: {
          id: 'sched-object',
          schedule_type: 'shift',
          work_start: '08:00:00',
          work_end: '17:00:00',
          work_hours: 9,
          work_days: [1, 2, 3, 4, 5],
          office_days: null,
          late_threshold_minutes: 15,
          day_overrides: null,
          lunch_minutes: 60,
          respects_holidays: true,
          pattern_type: 'custom',
          expected_saturdays_per_month: 0,
          expected_sundays_per_month: 0,
          full_day_threshold_minutes: null,
          weekend_full_day_threshold_minutes: null,
        },
      };
    });

    const result = await resolveObjectSchedule('obj-a', '2026-04-10');

    expect(result).toMatchObject({
      schedule_id: 'sched-object',
      work_hours: 9,
      source: 'object',
    });
  });

  it('returns null when object has no assigned schedule on date', async () => {
    pgQueryOne.mockResolvedValueOnce(null);
    const result = await resolveObjectSchedule('obj-missing', '2026-04-10');
    expect(result).toBeNull();
  });

  it('builds daily object schedules only for dates covered by object assignment periods', async () => {
    pgQuery.mockImplementation(async (sql: string) => {
      if (!/object_schedule_assignments/i.test(sql)) {
        throw new Error(`Unexpected SQL: ${sql}`);
      }
      return [
        {
          object_id: 'obj-a',
          effective_from: '2026-04-01',
          effective_to: '2026-04-02',
          anchor_date: null,
          work_schedules: {
            id: 'sched-a',
            schedule_type: 'office',
            work_start: '09:00:00',
            work_end: '12:00:00',
            work_hours: 3,
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
          },
        },
        {
          object_id: 'obj-b',
          effective_from: '2026-04-02',
          effective_to: null,
          anchor_date: null,
          work_schedules: {
            id: 'sched-b',
            schedule_type: 'office',
            work_start: '10:00:00',
            work_end: '14:00:00',
            work_hours: 4,
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
          },
        },
      ];
    });

    const result = await resolveObjectSchedulesForPeriod(
      ['obj-a', 'obj-b', 'obj-c'],
      '2026-04-01',
      '2026-04-03',
    );

    expect(result.get('obj-a')).toEqual(new Map([
      ['2026-04-01', expect.objectContaining({ schedule_id: 'sched-a', source: 'object' })],
      ['2026-04-02', expect.objectContaining({ schedule_id: 'sched-a', source: 'object' })],
    ]));
    expect(result.get('obj-b')).toEqual(new Map([
      ['2026-04-02', expect.objectContaining({ schedule_id: 'sched-b', source: 'object' })],
      ['2026-04-03', expect.objectContaining({ schedule_id: 'sched-b', source: 'object' })],
    ]));
    expect(result.has('obj-c')).toBe(false);
  });
});

describe('schedule.service pre-holidays', () => {
  const baseSchedule: IResolvedSchedule = {
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
    source: 'default',
  };

  const calendar: IProductionCalendarMonth = {
    year: 2026,
    month: 12,
    norm_days: 23,
    norm_hours: 183,
    holidays: [],
    mandatory_holidays: [],
    pre_holidays: ['2026-12-30'],
  };

  it('getDayNormHours: обычный будний день — work_hours без вычета', () => {
    expect(getDayNormHours(baseSchedule, new Date(2026, 11, 29), calendar)).toBe(8);
  });

  it('getDayNormHours: предпраздничный будень при respects_holidays=true — work_hours - 1', () => {
    expect(getDayNormHours(baseSchedule, new Date(2026, 11, 30), calendar)).toBe(7);
  });

  it('getDayNormHours: respects_holidays=false — без вычета даже в предпразник', () => {
    const sched = { ...baseSchedule, respects_holidays: false };
    expect(getDayNormHours(sched, new Date(2026, 11, 30), calendar)).toBe(8);
  });

  it('getDayNormHours: предпразник, выпавший на нерабочий день по графику — 0', () => {
    const sat = { ...calendar, pre_holidays: ['2026-01-03'] };
    expect(getDayNormHours(baseSchedule, new Date(2026, 0, 3), sat)).toBe(0);
  });

  it('getDayNormHours: work_hours < 1 (короткий override) clamp до 0', () => {
    const tiny = { ...baseSchedule, work_hours: 0.5 };
    expect(getDayNormHours(tiny, new Date(2026, 11, 30), calendar)).toBe(0);
  });

  it('countNormHoursForSchedule: вычитает 1ч за каждый предпраздничный будний день', () => {
    const total = countNormHoursForSchedule(2026, 12, baseSchedule, calendar);
    const without = countNormHoursForSchedule(2026, 12, baseSchedule, { ...calendar, pre_holidays: [] });
    expect(without - total).toBe(1);
  });

  it('getFullDayThresholdHoursForDate: порог снижается на 1ч в предпразник (fallback от work_hours)', () => {
    expect(getFullDayThresholdHoursForDate(baseSchedule, new Date(2026, 11, 29), calendar)).toBe(8);
    expect(getFullDayThresholdHoursForDate(baseSchedule, new Date(2026, 11, 30), calendar)).toBe(7);
  });

  it('getFullDayThresholdHoursForDate: явно заданный full_day_threshold_minutes тоже снижается на 60мин в предпразник', () => {
    const sched = { ...baseSchedule, full_day_threshold_minutes: 480 };
    expect(getFullDayThresholdHoursForDate(sched, new Date(2026, 11, 29), calendar)).toBe(8);
    expect(getFullDayThresholdHoursForDate(sched, new Date(2026, 11, 30), calendar)).toBe(7);
  });
});

describe('schedule.service cycle patterns', () => {
  const buildCycle22 = (overrides: Partial<IResolvedSchedule> = {}): IResolvedSchedule => ({
    schedule_id: 'sched-2-2',
    schedule_type: 'shift',
    work_start: '08:00:00',
    work_end: '20:00:00',
    work_hours: 11,
    work_days: [],
    office_days: null,
    late_threshold_minutes: 0,
    day_overrides: null,
    lunch_minutes: 60,
    respects_holidays: false,
    pattern_type: 'cycle',
    expected_saturdays_per_month: 0,
    expected_sundays_per_month: 0,
    full_day_threshold_minutes: null,
    weekend_full_day_threshold_minutes: null,
    cycle_length: 4,
    cycle_days: [
      { work_hours: 11, work_start: '08:00:00', work_end: '20:00:00', lunch_minutes: 60 },
      { work_hours: 11, work_start: '08:00:00', work_end: '20:00:00', lunch_minutes: 60 },
      { work_hours: 0 },
      { work_hours: 0 },
    ],
    anchor_date: '2026-05-04',
    assignment_anchor_date: null,
    source: 'employee',
    ...overrides,
  });

  const buildCycle24x3 = (overrides: Partial<IResolvedSchedule> = {}): IResolvedSchedule => ({
    schedule_id: 'sched-24-3',
    schedule_type: 'shift',
    work_start: '08:00:00',
    work_end: '08:00:00',
    work_hours: 24,
    work_days: [],
    office_days: null,
    late_threshold_minutes: 0,
    day_overrides: null,
    lunch_minutes: 0,
    respects_holidays: false,
    pattern_type: 'cycle',
    expected_saturdays_per_month: 0,
    expected_sundays_per_month: 0,
    full_day_threshold_minutes: null,
    weekend_full_day_threshold_minutes: null,
    cycle_length: 4,
    cycle_days: [
      { work_hours: 24, work_start: '08:00:00', work_end: '08:00:00' },
      { work_hours: 0 },
      { work_hours: 0 },
      { work_hours: 0 },
    ],
    anchor_date: '2026-05-04',
    assignment_anchor_date: null,
    source: 'employee',
    ...overrides,
  });

  it('getCycleSlot: возвращает корректный слот по индексу (anchor + N) mod cycle_length', () => {
    const s = buildCycle22();
    expect(getCycleSlot(s, new Date(2026, 4, 4))?.work_hours).toBe(11);
    expect(getCycleSlot(s, new Date(2026, 4, 5))?.work_hours).toBe(11);
    expect(getCycleSlot(s, new Date(2026, 4, 6))?.work_hours).toBe(0);
    expect(getCycleSlot(s, new Date(2026, 4, 7))?.work_hours).toBe(0);
    expect(getCycleSlot(s, new Date(2026, 4, 8))?.work_hours).toBe(11);
  });

  it('getCycleSlot: даты раньше anchor нормализуются корректно (отрицательный сдвиг)', () => {
    const s = buildCycle22();
    expect(getCycleSlot(s, new Date(2026, 4, 3))?.work_hours).toBe(0);
    expect(getCycleSlot(s, new Date(2026, 4, 2))?.work_hours).toBe(0);
    expect(getCycleSlot(s, new Date(2026, 4, 1))?.work_hours).toBe(11);
  });

  it('isWorkingDay: цикл сутки/трое — рабочий каждый 4-й день', () => {
    const s = buildCycle24x3();
    expect(isWorkingDay(s, new Date(2026, 4, 4))).toBe(true);
    expect(isWorkingDay(s, new Date(2026, 4, 5))).toBe(false);
    expect(isWorkingDay(s, new Date(2026, 4, 6))).toBe(false);
    expect(isWorkingDay(s, new Date(2026, 4, 7))).toBe(false);
    expect(isWorkingDay(s, new Date(2026, 4, 8))).toBe(true);
    expect(isWorkingDay(s, new Date(2026, 4, 12))).toBe(true);
  });

  it('isWorkingDay: цикл с respects_holidays=false работает в праздники', () => {
    const s = buildCycle22();
    const cal: IProductionCalendarMonth = {
      year: 2026, month: 5, norm_days: 0, norm_hours: 0,
      holidays: ['2026-05-04'],
      mandatory_holidays: [],
      pre_holidays: [],
    };
    expect(isWorkingDay(s, new Date(2026, 4, 4), cal)).toBe(true);
  });

  it('isWorkingDay: цикл с respects_holidays=true пропускает праздник', () => {
    const s = buildCycle22({ respects_holidays: true });
    const cal: IProductionCalendarMonth = {
      year: 2026, month: 5, norm_days: 0, norm_hours: 0,
      holidays: ['2026-05-04'],
      mandatory_holidays: [],
      pre_holidays: [],
    };
    expect(isWorkingDay(s, new Date(2026, 4, 4), cal)).toBe(false);
    expect(isWorkingDay(s, new Date(2026, 4, 5), cal)).toBe(true);
  });

  it('getScheduleForDate: возвращает work_start/work_end из слота цикла', () => {
    const s = buildCycle22();
    const day = getScheduleForDate(s, new Date(2026, 4, 4));
    expect(day).toEqual({ work_start: '08:00:00', work_end: '20:00:00', work_hours: 11, lunch_minutes: 60 });
  });

  it('getScheduleForDate: для нерабочего дня цикла work_hours=0, время — fallback на schedule', () => {
    const s = buildCycle22();
    const day = getScheduleForDate(s, new Date(2026, 4, 6));
    expect(day.work_hours).toBe(0);
  });

  it('getScheduleForDate: cycle_days[i].lunch_minutes переопределяет глобальный schedule.lunch_minutes', () => {
    const s = buildCycle22({
      lunch_minutes: 60,
      cycle_days: [
        { work_hours: 11, work_start: '08:00:00', work_end: '20:00:00', lunch_minutes: 0 },
        { work_hours: 11, work_start: '08:00:00', work_end: '20:00:00', lunch_minutes: 60 },
        { work_hours: 0 },
        { work_hours: 0 },
      ],
    });
    expect(getScheduleForDate(s, new Date(2026, 4, 4)).lunch_minutes).toBe(0);
    expect(getScheduleForDate(s, new Date(2026, 4, 5)).lunch_minutes).toBe(60);
  });

  it('getScheduleForDate: cycle_days без lunch_minutes — fallback на schedule.lunch_minutes', () => {
    const s = buildCycle22({
      lunch_minutes: 45,
      cycle_days: [
        { work_hours: 11, work_start: '08:00:00', work_end: '20:00:00' },
        { work_hours: 0 },
        { work_hours: 0 },
        { work_hours: 0 },
      ],
    });
    expect(getScheduleForDate(s, new Date(2026, 4, 4)).lunch_minutes).toBe(45);
  });

  it('getScheduleForDate: day_overrides[dow].lunch_minutes переопределяет schedule.lunch_minutes', () => {
    const base: IResolvedSchedule = {
      schedule_id: 'sched-5plus2',
      schedule_type: 'office',
      work_start: '09:00:00',
      work_end: '18:00:00',
      work_hours: 8,
      work_days: [1, 2, 3, 4, 5, 6],
      office_days: null,
      late_threshold_minutes: 0,
      day_overrides: {
        '6': { work_start: '09:00:00', work_end: '13:00:00', work_hours: 4, lunch_minutes: 0 },
      },
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
    };
    // Saturday 2026-05-09 (ISO dow=6) — override с lunch_minutes=0
    expect(getScheduleForDate(base, new Date(2026, 4, 9)).lunch_minutes).toBe(0);
    // Monday 2026-05-04 — fallback на schedule.lunch_minutes=60
    expect(getScheduleForDate(base, new Date(2026, 4, 4)).lunch_minutes).toBe(60);
  });

  it('getDayNormHours: цикл 2/2 — 11ч в рабочий день, 0 в выходной', () => {
    const s = buildCycle22();
    expect(getDayNormHours(s, new Date(2026, 4, 4))).toBe(11);
    expect(getDayNormHours(s, new Date(2026, 4, 6))).toBe(0);
  });

  it('countNormHoursForSchedule: для цикла 2/2 в мае 2026 = 31 день / 4 × 2 раб ≈ 15.5 рабочих дней × 11ч', () => {
    const s = buildCycle22();
    expect(countNormHoursForSchedule(2026, 5, s)).toBe(165);
  });

  it('assignment_anchor_date перебивает schedule.anchor_date', () => {
    const s = buildCycle22({ assignment_anchor_date: '2026-05-05' });
    expect(getDayNormHours(s, new Date(2026, 4, 5))).toBe(11);
    expect(getDayNormHours(s, new Date(2026, 4, 4))).toBe(0);
  });

  it('пограничный переход через границу месяца сохраняет фазу цикла', () => {
    const s = buildCycle22();
    expect(getDayNormHours(s, new Date(2026, 4, 31))).toBe(0);
    expect(getDayNormHours(s, new Date(2026, 5, 1))).toBe(11);
    expect(getDayNormHours(s, new Date(2026, 5, 2))).toBe(11);
  });

  it('ночные смены: цикл 24/0/24/0 (через день)', () => {
    const night: IResolvedSchedule = {
      ...buildCycle22(),
      schedule_id: 'sched-night',
      cycle_length: 2,
      cycle_days: [
        { work_hours: 12, work_start: '20:00:00', work_end: '08:00:00' },
        { work_hours: 0 },
      ],
      work_hours: 12,
      work_start: '20:00:00',
      work_end: '08:00:00',
    };
    expect(isWorkingDay(night, new Date(2026, 4, 4))).toBe(true);
    expect(isWorkingDay(night, new Date(2026, 4, 5))).toBe(false);
    expect(isWorkingDay(night, new Date(2026, 4, 6))).toBe(true);
    const day = getScheduleForDate(night, new Date(2026, 4, 4));
    expect(day.work_start).toBe('20:00:00');
    expect(day.work_end).toBe('08:00:00');
  });

  it('needsSkudCheck: в рабочий день цикла = true, в выходной = false', () => {
    const s = buildCycle22();
    expect(needsSkudCheck(s, new Date(2026, 4, 4))).toBe(true);
    expect(needsSkudCheck(s, new Date(2026, 4, 6))).toBe(false);
  });

  it('countNormHoursForSchedule: cycle без обязательных суббот — норма не меняется', () => {
    const s = buildCycle22({ pattern_type: 'cycle', expected_saturdays_per_month: 0 });
    expect(countNormHoursForSchedule(2026, 5, s)).toBe(165);
  });

  it('countNormHoursForSchedule: cycle с обязательными субботами добавляет N×work_hours', () => {
    // 165 (база цикла 2/2, май 2026) + 2 субботы × 11ч = 187
    const s = buildCycle22({ pattern_type: 'cycle', expected_saturdays_per_month: 2 });
    expect(countNormHoursForSchedule(2026, 5, s)).toBe(187);
  });

  it('countNormHoursForSchedule: cycle с обязательными воскресеньями добавляет M×work_hours', () => {
    // 165 + 1 воскресенье × 11ч = 176
    const s = buildCycle22({ pattern_type: 'cycle', expected_sundays_per_month: 1 });
    expect(countNormHoursForSchedule(2026, 5, s)).toBe(176);
  });

  it('countNormHoursForSchedule: обязательные субботы и воскресенья суммируются', () => {
    // 165 + 2×11 + 1×11 = 198
    const s = buildCycle22({
      pattern_type: 'cycle',
      expected_saturdays_per_month: 2,
      expected_sundays_per_month: 1,
    });
    expect(countNormHoursForSchedule(2026, 5, s)).toBe(198);
  });

  it('cycle с битыми данными (cycle_days длина не совпадает с cycle_length) → null, фоллбек на work_days', () => {
    const broken: IResolvedSchedule = {
      ...buildCycle22(),
      cycle_length: 4,
      cycle_days: [{ work_hours: 11 }],
    };
    expect(getCycleSlot(broken, new Date(2026, 4, 4))).toBeNull();
  });
});

describe('schedule.service NON_WORKING_STATUSES', () => {
  it('содержит отпуск, больничный, учебный и неоплачиваемый отпуск', () => {
    expect(NON_WORKING_STATUSES.has('vacation')).toBe(true);
    expect(NON_WORKING_STATUSES.has('sick')).toBe(true);
    expect(NON_WORKING_STATUSES.has('educational_leave')).toBe(true);
    expect(NON_WORKING_STATUSES.has('unpaid')).toBe(true);
  });

  it('НЕ содержит прогул, удалёнку, обычную работу — у этих статусов план остаётся', () => {
    expect(NON_WORKING_STATUSES.has('absent')).toBe(false);
    expect(NON_WORKING_STATUSES.has('work')).toBe(false);
    expect(NON_WORKING_STATUSES.has('remote')).toBe(false);
    expect(NON_WORKING_STATUSES.has('dayoff')).toBe(false);
  });

  it('состоит ровно из 4 статусов (защита от случайного расширения)', () => {
    expect(NON_WORKING_STATUSES.size).toBe(4);
  });
});

describe('schedule.service computeCappedFactHours', () => {
  const sched52: IResolvedSchedule = {
    schedule_id: 's-52',
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
    source: 'default',
  };

  const calMay: IProductionCalendarMonth = {
    year: 2026,
    month: 5,
    norm_days: 0,
    norm_hours: 0,
    holidays: [],
    mandatory_holidays: [],
    pre_holidays: [],
  };

  const cycle22: IResolvedSchedule = {
    schedule_id: 'sched-2-2',
    schedule_type: 'shift',
    work_start: '08:00:00',
    work_end: '20:00:00',
    work_hours: 11,
    work_days: [],
    office_days: null,
    late_threshold_minutes: 0,
    day_overrides: null,
    lunch_minutes: 60,
    respects_holidays: false,
    pattern_type: 'cycle',
    expected_saturdays_per_month: 0,
    expected_sundays_per_month: 0,
    full_day_threshold_minutes: null,
    weekend_full_day_threshold_minutes: null,
    cycle_length: 4,
    cycle_days: [
      { work_hours: 11, work_start: '08:00:00', work_end: '20:00:00', lunch_minutes: 60 },
      { work_hours: 11, work_start: '08:00:00', work_end: '20:00:00', lunch_minutes: 60 },
      { work_hours: 0 },
      { work_hours: 0 },
    ],
    anchor_date: '2026-05-04',
    assignment_anchor_date: null,
    source: 'employee',
  };

  it('будний 5/2, факт < нормы → возвращает фактические часы', () => {
    expect(computeCappedFactHours(sched52, new Date(2026, 4, 5), calMay, 6, 'work')).toBe(6);
  });

  it('будний 5/2, факт = норме → возвращает норму', () => {
    expect(computeCappedFactHours(sched52, new Date(2026, 4, 5), calMay, 8, 'work')).toBe(8);
  });

  it('будний 5/2, факт > нормы → cap до плановой смены', () => {
    expect(computeCappedFactHours(sched52, new Date(2026, 4, 5), calMay, 10, 'work')).toBe(8);
  });

  it('суббота при графике 5/2, status=work, 4ч → 0 (выходной по графику)', () => {
    expect(computeCappedFactHours(sched52, new Date(2026, 4, 9), calMay, 4, 'work')).toBe(0);
  });

  it('праздник из production_calendar при respects_holidays=true, 8ч → 0', () => {
    const cal = { ...calMay, holidays: ['2026-05-05'] };
    expect(computeCappedFactHours(sched52, new Date(2026, 4, 5), cal, 8, 'work')).toBe(0);
  });

  it('отпуск (vacation) в будний день → 0', () => {
    expect(computeCappedFactHours(sched52, new Date(2026, 4, 5), calMay, 8, 'vacation')).toBe(0);
  });

  it('больничный (sick) в будний день → 0', () => {
    expect(computeCappedFactHours(sched52, new Date(2026, 4, 5), calMay, 8, 'sick')).toBe(0);
  });

  it('предпраздничный будень: cap = work_hours − 1', () => {
    const cal = { ...calMay, pre_holidays: ['2026-05-05'] };
    expect(computeCappedFactHours(sched52, new Date(2026, 4, 5), cal, 8, 'work')).toBe(7);
  });

  it('absent в рабочий день: cap применяется (обычно hours_worked=0 → 0)', () => {
    expect(computeCappedFactHours(sched52, new Date(2026, 4, 5), calMay, 0, 'absent')).toBe(0);
  });

  it('dayoff с hours_worked=5 в будний день — мусор в БД, явно отбрасываем', () => {
    expect(computeCappedFactHours(sched52, new Date(2026, 4, 5), calMay, 5, 'dayoff')).toBe(0);
  });

  it('отсутствующий schedule → 0', () => {
    expect(computeCappedFactHours(null, new Date(2026, 4, 5), calMay, 8, 'work')).toBe(0);
    expect(computeCappedFactHours(undefined, new Date(2026, 4, 5), calMay, 8, 'work')).toBe(0);
  });

  it('hours_worked=null/undefined → 0', () => {
    expect(computeCappedFactHours(sched52, new Date(2026, 4, 5), calMay, null, 'work')).toBe(0);
    expect(computeCappedFactHours(sched52, new Date(2026, 4, 5), calMay, undefined, 'work')).toBe(0);
  });

  it('cycle 2/2: рабочий слот 11ч, факт 12ч → 11 (cap)', () => {
    expect(computeCappedFactHours(cycle22, new Date(2026, 4, 4), null, 12, 'work')).toBe(11);
  });

  it('cycle 2/2: выходной слот, факт 8ч → 0', () => {
    expect(computeCappedFactHours(cycle22, new Date(2026, 4, 6), null, 8, 'work')).toBe(0);
  });

  it('remote-работа в будний день обрабатывается как work (cap по норме)', () => {
    expect(computeCappedFactHours(sched52, new Date(2026, 4, 5), calMay, 9, 'remote')).toBe(8);
  });
});
