import { describe, expect, it, vi } from 'vitest';

import type { IProductionCalendarMonth, IResolvedSchedule } from '../../types/index.js';

vi.mock('../../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

// Графики и календарь для buildPayrollBasisDrafts — подменены: «5+2» на весь сентябрь, календаря нет.
const schedules = vi.hoisted(() => ({ resolveSchedulesForPeriod: vi.fn(), loadCalendarMonth: vi.fn(async () => null) }));
vi.mock('../schedule.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../schedule.service.js')>()),
  resolveSchedulesForPeriod: schedules.resolveSchedulesForPeriod,
  loadCalendarMonth: schedules.loadCalendarMonth,
}));
vi.mock('../timesheet-export.service.js', () => ({ computeExportWeekendExemptions: vi.fn(async () => new Set()) }));

import type { DbExecutor } from '../../config/postgres.js';
import type { ITimesheetVersionPayload } from '../timesheet-version.service.js';
import {
  buildBasisDraftsForDays,
  buildPayrollBasisDrafts,
  classifyBasisDays,
  computeBasisHash,
  countMonthNormDays,
  countMonthNormMinutes,
  monthsInRange,
  type IClassifyBasisInput,
} from './payroll-basis.service.js';

// «5+2» без плановых суббот; сентябрь 2026 — 22 будних, 5-е — суббота.
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

const septemberDates = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
const septemberSchedules = new Map(septemberDates.map(date => [date, fiveTwo]));

const day = (status: string, hours = 0, overridden = false) => ({ status, hours, hours_overridden: overridden });

const classify = (days: IClassifyBasisInput['days'], over: Partial<IClassifyBasisInput> = {}) => classifyBasisDays({
  employeeId: 71,
  month: '2026-09',
  days,
  schedules: septemberSchedules,
  calendar: null,
  plannedWeekendDays: new Set(),
  cutoff: null,
  ...over,
});

describe('основа расчёта: дни месяца', () => {
  it('будни с часами и УУ без часов — рабочие; Абраменко, сентябрь: 10 «Я» + 12 «УУ» = 22', () => {
    const days: Record<string, ReturnType<typeof day>> = {};
    const weekdays = septemberDates.filter(date => ![0, 6].includes(new Date(`${date}T12:00:00`).getDay()));
    weekdays.forEach((date, index) => { days[date] = index < 10 ? day('work', 8.2) : day('remote', index % 3 === 0 ? 0 : 8); });
    const result = classify(days);
    expect(result.workdayDates).toHaveLength(22);
    expect(result.dayoffDates).toEqual([]);
  });

  it('согласованный выход в субботу — выход; плановая суббота в квоте — рабочий день', () => {
    const result = classify(
      { '2026-09-05': day('work', 6), '2026-09-12': day('work', 8) },
      { plannedWeekendDays: new Set(['71|2026-09-12']) },
    );
    expect(result.dayoffDates).toEqual(['2026-09-05']);
    expect(result.workdayDates).toEqual(['2026-09-12']);
  });

  it('квота суббот графика сначала заполняется выходами: «5+2» с одной субботой, два выхода — 1 рабочий + 1 выход', () => {
    const oneSaturday = new Map(septemberDates.map(date => [date, { ...fiveTwo, expected_saturdays_per_month: 1 }]));
    const result = classify(
      { '2026-09-04': day('work', 8), '2026-09-05': day('work', 8), '2026-09-12': day('manual', 8) },
      { schedules: oneSaturday },
    );
    expect(result.workdayDates).toEqual(['2026-09-04', '2026-09-05']);
    expect(result.dayoffDates).toEqual(['2026-09-12']);
  });

  it('квоту уже заняла плановая суббота — выход остаётся выходом', () => {
    const oneSaturday = new Map(septemberDates.map(date => [date, { ...fiveTwo, expected_saturdays_per_month: 1 }]));
    const result = classify(
      { '2026-09-05': day('work', 8), '2026-09-12': day('work', 8) },
      { schedules: oneSaturday, plannedWeekendDays: new Set(['71|2026-09-05']) },
    );
    expect(result.workdayDates).toEqual(['2026-09-05']);
    expect(result.dayoffDates).toEqual(['2026-09-12']);
  });

  it('РБ и УД в выходной — не выход и не рабочий день; в будни — рабочий', () => {
    const result = classify({
      '2026-09-05': day('sick_worked'),
      '2026-09-06': day('study_day'),
      '2026-09-07': day('sick_worked'),
      '2026-09-08': day('study_day'),
    });
    expect(result.dayoffDates).toEqual([]);
    expect(result.workdayDates).toEqual(['2026-09-07', '2026-09-08']);
  });

  it('несогласованный выход (часы обнулены выгрузкой) и меньше получаса — не день', () => {
    const result = classify({ '2026-09-05': day('work', 0), '2026-09-07': day('work', 0.4) });
    expect(result.dayoffDates).toEqual([]);
    expect(result.workdayDates).toEqual([]);
  });

  it('отпуск, больничный, учебный, без сохранения — отсутствия; неявка — никуда', () => {
    const result = classify({
      '2026-09-01': day('vacation', 8),
      '2026-09-02': day('vacation', 8),
      '2026-09-05': day('vacation', 0),
      '2026-09-03': day('sick', 8),
      '2026-09-04': day('educational_leave', 8),
      '2026-09-07': day('unpaid'),
      '2026-09-08': day('absent'),
    });
    expect(result.absenceDays).toEqual({ vacation: 3, sick: 1, educational_leave: 1, unpaid: 1 });
    // Даты — те же дни по статусам (миграция 339: дни «Квартиры» без отсутствий).
    expect(result.absenceDates).toEqual({
      vacation: ['2026-09-01', '2026-09-02', '2026-09-05'],
      sick: ['2026-09-03'],
      educational_leave: ['2026-09-04'],
      unpaid: ['2026-09-07'],
    });
    expect(result.workdayDates).toEqual([]);
  });

  it('дни после отсечки увольнения и чужого месяца не считаются', () => {
    const result = classify(
      { '2026-08-31': day('work', 8), '2026-09-14': day('work', 8), '2026-09-15': day('work', 8) },
      { cutoff: '2026-09-15' },
    );
    expect(result.workdayDates).toEqual(['2026-09-14']);
  });

  it('переработка в будни — только по корректировке, часами 1С сверх нормы: 8,47 / 11 / 11 → 0 + 3 + 3 ч', () => {
    const result = classify({
      '2026-09-01': day('work', 8.47, true),
      '2026-09-02': day('work', 11, true),
      '2026-09-03': day('manual', 11, true),
      // СКУД сверх графика без правки — не переработка.
      '2026-09-04': day('work', 11.5),
      // Корректировка в выходной — выход целым днём, не часы.
      '2026-09-05': day('work', 11, true),
    });
    expect(result.overtimeMinutes).toEqual({ '2026-09-02': 180, '2026-09-03': 180 });
    expect(result.dayoffDates).toEqual(['2026-09-05']);
  });

  it('порог переработки — не ниже 8 ч: короткая пятница графика (7 ч) с правкой 8 — не переработка, 9 — 1 ч', () => {
    // «5+0 + рос пр(8час) пт - час»: пятница 09:00–17:00, 7 ч (Марухина, сентябрь: четыре такие пятницы).
    const shortFriday: IResolvedSchedule = {
      ...fiveTwo,
      day_overrides: { 5: { work_start: '09:00:00', work_end: '17:00:00', work_hours: 7 } },
    };
    const result = classify({
      '2026-09-04': day('work', 8, true),
      '2026-09-11': day('work', 9, true),
    }, { schedules: new Map(septemberDates.map(date => [date, shortFriday])) });
    expect(result.overtimeMinutes).toEqual({ '2026-09-11': 60 });
  });

  it('предпраздничный день — порог тоже 8 ч (правка «8» — полный день); смена длиннее 8 ч — порог её норма', () => {
    const calendar: IProductionCalendarMonth = {
      year: 2026, month: 9, norm_days: 22, norm_hours: 175, holidays: [], mandatory_holidays: [],
      pre_holidays: ['2026-09-29', '2026-09-30'],
    };
    expect(classify({ '2026-09-29': day('work', 8, true), '2026-09-30': day('manual', 9, true) }, { calendar }).overtimeMinutes)
      .toEqual({ '2026-09-30': 60 });
    // «УУ 8» в предпраздничный (11.06.2026: «Полная удаленка», форма подставила 8) — не переработка.
    expect(classify({ '2026-09-29': day('remote', 8, true), '2026-09-30': day('remote', 9, true) }, { calendar }).overtimeMinutes)
      .toEqual({ '2026-09-30': 60 });

    const longShift: IResolvedSchedule = { ...fiveTwo, work_hours: 11 };
    expect(classify({
      '2026-09-01': day('work', 11, true),
      '2026-09-02': day('work', 12, true),
    }, { schedules: new Map(septemberDates.map(date => [date, longShift])) }).overtimeMinutes)
      .toEqual({ '2026-09-02': 60 });
  });

  it('«УУ» с правкой часов — переработка сверх порога, рабочий день остаётся; Разаханов, 10.09: 9 ч → 1 ч', () => {
    const shortFriday: IResolvedSchedule = {
      ...fiveTwo,
      day_overrides: { 5: { work_start: '09:00:00', work_end: '17:00:00', work_hours: 7 } },
    };
    const result = classify({
      '2026-09-10': day('remote', 9, true),
      // Без правки (часы графика) — не переработка, даже сверх порога.
      '2026-09-14': day('remote', 9),
      // Правка 8 в короткую пятницу — порог 8 ч.
      '2026-09-11': day('remote', 8, true),
      // Ручная «УУ» с 0 ч — рабочий день без переработки.
      '2026-09-15': day('remote', 0, true),
      // Правка в выходной — выход днём, не часы.
      '2026-09-12': day('remote', 9, true),
    }, { schedules: new Map(septemberDates.map(date => [date, shortFriday])) });
    expect(result.overtimeMinutes).toEqual({ '2026-09-10': 60 });
    expect(result.workdayDates).toEqual(['2026-09-10', '2026-09-11', '2026-09-14', '2026-09-15']);
    expect(result.dayoffDates).toEqual(['2026-09-12']);
  });

  it('«УУ» с правкой: смена 10 ч — порог её норма; дня нет в графике — переработки нет', () => {
    const tenHours: IResolvedSchedule = { ...fiveTwo, work_hours: 10 };
    expect(classify({
      '2026-09-01': day('remote', 10, true),
      '2026-09-02': day('remote', 11, true),
    }, { schedules: new Map(septemberDates.map(date => [date, tenHours])) }).overtimeMinutes)
      .toEqual({ '2026-09-02': 60 });

    const noSchedule = classify({ '2026-09-01': day('remote', 10, true) }, { schedules: new Map() });
    expect(noSchedule.workdayDates).toEqual(['2026-09-01']);
    expect(noSchedule.overtimeMinutes).toEqual({});
  });

  it('дня нет в графике — рабочий, как в выгрузке 1С', () => {
    const result = classify({ '2026-09-05': day('work', 8) }, { schedules: new Map() });
    expect(result.workdayDates).toEqual(['2026-09-05']);
  });
});

describe('основа расчёта: норма дней месяца', () => {
  const calendar: IProductionCalendarMonth = {
    year: 2026, month: 9, norm_days: 22, norm_hours: 176, holidays: [], mandatory_holidays: [], pre_holidays: [],
  };

  it('по графику каждого дня + плановые субботы графика последнего дня', () => {
    expect(countMonthNormDays(septemberSchedules, '2026-09', null)).toBe(22);
    const withSaturdays = new Map(septemberDates.map(date => [date, { ...fiveTwo, expected_saturdays_per_month: 2 }]));
    expect(countMonthNormDays(withSaturdays, '2026-09', null)).toBe(24);
  });

  it('норма часов — производственного календаря, как ЗУП; без календаря — по графику с плановыми субботами', () => {
    const shortFriday = new Map(septemberDates.map(date => [date, { ...fiveTwo, work_hours: 7 }]));
    expect(countMonthNormMinutes(shortFriday, '2026-09', calendar)).toBe(176 * 60);
    expect(countMonthNormMinutes(septemberSchedules, '2026-09', null)).toBe(22 * 8 * 60);
    const withSaturdays = new Map(septemberDates.map(date => [date, { ...fiveTwo, expected_saturdays_per_month: 2 }]));
    expect(countMonthNormMinutes(withSaturdays, '2026-09', null)).toBe(24 * 8 * 60);
    expect(countMonthNormMinutes(undefined, '2026-09', null)).toBeNull();
  });

  it('нет графика хоть на день — норма календаря, нет и её — null', () => {
    const partial = new Map(septemberDates.slice(1).map(date => [date, fiveTwo]));
    expect(countMonthNormDays(partial, '2026-09', calendar)).toBe(22);
    expect(countMonthNormDays(undefined, '2026-09', null)).toBeNull();
  });
});

describe('основа расчёта: служебное', () => {
  it('месяцы периода подачи', () => {
    expect(monthsInRange('2026-09-16', '2026-09-30')).toEqual(['2026-09']);
    expect(monthsInRange('2026-12-20', '2027-01-10')).toEqual(['2026-12', '2027-01']);
  });

  it('хэш основы не зависит от порядка ключей и меняется с нормой', () => {
    const draft = {
      employeeId: 71,
      month: '2026-09-01',
      normDays: 22,
      normMinutes: 10560,
      workdayDates: ['2026-09-01'],
      dayoffDates: [],
      absenceDays: { vacation: 0, sick: 0, educational_leave: 0, unpaid: 0 },
      absenceDates: { vacation: [], sick: [], educational_leave: [], unpaid: [] },
      overtimeMinutes: {},
    };
    expect(computeBasisHash(draft)).toBe(computeBasisHash({ ...draft, absenceDays: { unpaid: 0, sick: 0, vacation: 0, educational_leave: 0 } }));
    expect(computeBasisHash(draft)).not.toBe(computeBasisHash({
      ...draft, absenceDates: { vacation: ['2026-09-02'], sick: [], educational_leave: [], unpaid: [] },
    }));
    expect(computeBasisHash(draft)).not.toBe(computeBasisHash({ ...draft, normDays: 23 }));
    expect(computeBasisHash(draft)).not.toBe(computeBasisHash({ ...draft, overtimeMinutes: { '2026-09-01': 60 } }));
  });
});

describe('buildPayrollBasisDrafts — обёртка над buildBasisDraftsForDays', () => {
  it('редакция и те же дни напрямую (живой табель «Расчётов») дают одну основу', async () => {
    schedules.resolveSchedulesForPeriod.mockResolvedValue(new Map([[71, septemberSchedules]]));
    const exec = {
      query: async () => ({ rows: [{ id: 71, employment_status: 'active', dismissal_date: null, excluded_from_timesheet_date: null }] }),
    } as unknown as DbExecutor;
    const days = { '2026-09-01': day('work', 9, true), '2026-09-02': day('work', 8), '2026-09-05': day('work', 6) };
    const payload = {
      approval: { start_date: '2026-09-01', end_date: '2026-09-30' },
      employees: [{ identity: { employee_id: 71 }, days: Object.fromEntries(Object.entries(days).map(([date, value]) => (
        [date, { ...value, corrected: value.hours_overridden }]
      ))) }],
    } as unknown as ITimesheetVersionPayload;

    const fromVersion = await buildPayrollBasisDrafts(exec, payload);
    const fromDays = await buildBasisDraftsForDays(exec, {
      start_date: '2026-09-01', end_date: '2026-09-30', employees: [{ employee_id: 71, days }],
    });

    expect(fromDays).toEqual(fromVersion);
    expect(fromVersion).toEqual([expect.objectContaining({
      employeeId: 71, month: '2026-09-01', normDays: 22,
      workdayDates: ['2026-09-01', '2026-09-02'], dayoffDates: ['2026-09-05'], overtimeMinutes: { '2026-09-01': 60 },
    })]);
  });
});
