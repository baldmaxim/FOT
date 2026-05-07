import { beforeEach, describe, expect, it, vi } from 'vitest';

type QueryRecord = {
  table: string;
  operations: Array<{ method: string; args: unknown[] }>;
};

type QueryResponse = {
  data?: unknown;
  error?: { code?: string; message?: string } | null;
};

const mockedState = vi.hoisted(() => ({
  queryLog: [] as QueryRecord[],
  resolver: (() => ({ data: [], error: null })) as (query: QueryRecord) => QueryResponse | Promise<QueryResponse>,
}));

function createBuilder(table: string) {
  const query: QueryRecord = { table, operations: [] };
  mockedState.queryLog.push(query);

  const builder = {
    select: (...args: unknown[]) => {
      query.operations.push({ method: 'select', args });
      return builder;
    },
    eq: (...args: unknown[]) => {
      query.operations.push({ method: 'eq', args });
      return builder;
    },
    in: (...args: unknown[]) => {
      query.operations.push({ method: 'in', args });
      return builder;
    },
    lte: (...args: unknown[]) => {
      query.operations.push({ method: 'lte', args });
      return builder;
    },
    or: (...args: unknown[]) => {
      query.operations.push({ method: 'or', args });
      return builder;
    },
    order: (...args: unknown[]) => {
      query.operations.push({ method: 'order', args });
      return builder;
    },
    limit: (...args: unknown[]) => {
      query.operations.push({ method: 'limit', args });
      return builder;
    },
    maybeSingle: async () => mockedState.resolver(query),
    then: (onFulfilled: (value: QueryResponse) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(mockedState.resolver(query)).then(onFulfilled, onRejected),
  };

  return builder;
}

vi.mock('../config/database.js', () => ({
  supabase: {
    from: vi.fn((table: string) => createBuilder(table)),
  },
}));

import {
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
    mockedState.queryLog.length = 0;
    mockedState.resolver = () => ({ data: [], error: null });
  });

  it('resolves an object schedule for a single date', async () => {
    mockedState.resolver = (query) => {
      if (query.table === 'object_schedule_assignments') {
        return {
          data: {
            schedule_id: 'sched-object',
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
              full_day_threshold_minutes: null,
              weekend_full_day_threshold_minutes: null,
            },
          },
          error: null,
        };
      }

      throw new Error(`Unexpected query for table ${query.table}`);
    };

    const result = await resolveObjectSchedule('obj-a', '2026-04-10');

    expect(result).toMatchObject({
      schedule_id: 'sched-object',
      work_hours: 9,
      source: 'object',
    });
  });

  it('returns null when object has no assigned schedule on date', async () => {
    const result = await resolveObjectSchedule('obj-missing', '2026-04-10');
    expect(result).toBeNull();
  });

  it('builds daily object schedules only for dates covered by object assignment periods', async () => {
    mockedState.resolver = (query) => {
      if (query.table === 'object_schedule_assignments') {
        return {
          data: [
            {
              object_id: 'obj-a',
              effective_from: '2026-04-01',
              effective_to: '2026-04-02',
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
                full_day_threshold_minutes: null,
                weekend_full_day_threshold_minutes: null,
              },
            },
            {
              object_id: 'obj-b',
              effective_from: '2026-04-02',
              effective_to: null,
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
                full_day_threshold_minutes: null,
                weekend_full_day_threshold_minutes: null,
              },
            },
          ],
          error: null,
        };
      }

      throw new Error(`Unexpected query for table ${query.table}`);
    };

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
    // 2026-12-29 — вторник, обычный будний день
    expect(getDayNormHours(baseSchedule, new Date(2026, 11, 29), calendar)).toBe(8);
  });

  it('getDayNormHours: предпраздничный будень при respects_holidays=true — work_hours - 1', () => {
    // 2026-12-30 — среда, предпразник
    expect(getDayNormHours(baseSchedule, new Date(2026, 11, 30), calendar)).toBe(7);
  });

  it('getDayNormHours: respects_holidays=false — без вычета даже в предпразник', () => {
    const sched = { ...baseSchedule, respects_holidays: false };
    expect(getDayNormHours(sched, new Date(2026, 11, 30), calendar)).toBe(8);
  });

  it('getDayNormHours: предпразник, выпавший на нерабочий день по графику — 0', () => {
    // суббота 2026-01-03 — выходной по 5-дневке
    const sat = { ...calendar, pre_holidays: ['2026-01-03'] };
    expect(getDayNormHours(baseSchedule, new Date(2026, 0, 3), sat)).toBe(0);
  });

  it('getDayNormHours: work_hours < 1 (короткий override) clamp до 0', () => {
    const tiny = { ...baseSchedule, work_hours: 0.5 };
    expect(getDayNormHours(tiny, new Date(2026, 11, 30), calendar)).toBe(0);
  });

  it('countNormHoursForSchedule: вычитает 1ч за каждый предпраздничный будний день', () => {
    // декабрь 2026: 23 будня × 8ч = 184ч; один предпразник 30.12 (среда) → 183
    const total = countNormHoursForSchedule(2026, 12, baseSchedule, calendar);
    const without = countNormHoursForSchedule(2026, 12, baseSchedule, { ...calendar, pre_holidays: [] });
    expect(without - total).toBe(1);
  });

  it('getFullDayThresholdHoursForDate: порог снижается на 1ч в предпразник (fallback от work_hours)', () => {
    // work_hours хранится как нетто, обед в формуле не вычитается
    // обычный будень: 8ч
    expect(getFullDayThresholdHoursForDate(baseSchedule, new Date(2026, 11, 29), calendar)).toBe(8);
    // предпразник: 8 - 1 = 7
    expect(getFullDayThresholdHoursForDate(baseSchedule, new Date(2026, 11, 30), calendar)).toBe(7);
  });

  it('getFullDayThresholdHoursForDate: явно заданный full_day_threshold_minutes тоже снижается на 60мин в предпразник', () => {
    const sched = { ...baseSchedule, full_day_threshold_minutes: 480 };
    expect(getFullDayThresholdHoursForDate(sched, new Date(2026, 11, 29), calendar)).toBe(8);
    expect(getFullDayThresholdHoursForDate(sched, new Date(2026, 11, 30), calendar)).toBe(7);
  });
});

describe('schedule.service cycle patterns', () => {
  // 2/2: 2 дня по 11ч, 2 дня выходных. Цикл длиной 4 дня.
  // anchor_date = 2026-05-04 (понедельник). Дни 0..3 = 04,05,06,07 (Пн,Вт,Ср,Чт):
  //   04 Пн: work, 05 Вт: work, 06 Ср: off, 07 Чт: off, далее повтор.
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

  // Сутки/трое: 1 день по 24ч + 3 выходных. Цикл длиной 4 дня.
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
    expect(getCycleSlot(s, new Date(2026, 4, 4))?.work_hours).toBe(11); // Пн (idx 0)
    expect(getCycleSlot(s, new Date(2026, 4, 5))?.work_hours).toBe(11); // Вт (idx 1)
    expect(getCycleSlot(s, new Date(2026, 4, 6))?.work_hours).toBe(0);  // Ср (idx 2)
    expect(getCycleSlot(s, new Date(2026, 4, 7))?.work_hours).toBe(0);  // Чт (idx 3)
    expect(getCycleSlot(s, new Date(2026, 4, 8))?.work_hours).toBe(11); // Пт (idx 0 повтор)
  });

  it('getCycleSlot: даты раньше anchor нормализуются корректно (отрицательный сдвиг)', () => {
    const s = buildCycle22();
    // 2026-05-03 (Вс) = anchor − 1 = idx ((-1 % 4) + 4) % 4 = 3 → выходной
    expect(getCycleSlot(s, new Date(2026, 4, 3))?.work_hours).toBe(0);
    // 2026-05-02 (Сб) = anchor − 2 = idx 2 → выходной
    expect(getCycleSlot(s, new Date(2026, 4, 2))?.work_hours).toBe(0);
    // 2026-05-01 (Пт) = anchor − 3 = idx 1 → 11ч (рабочий из «прошлого» цикла)
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
    const s = buildCycle22(); // respects_holidays=false
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
    // 5-е по циклу — рабочий, не праздник → работает
    expect(isWorkingDay(s, new Date(2026, 4, 5), cal)).toBe(true);
  });

  it('getScheduleForDate: возвращает work_start/work_end из слота цикла', () => {
    const s = buildCycle22();
    const day = getScheduleForDate(s, new Date(2026, 4, 4));
    expect(day).toEqual({ work_start: '08:00:00', work_end: '20:00:00', work_hours: 11 });
  });

  it('getScheduleForDate: для нерабочего дня цикла work_hours=0, время — fallback на schedule', () => {
    const s = buildCycle22();
    const day = getScheduleForDate(s, new Date(2026, 4, 6)); // выходной по циклу
    expect(day.work_hours).toBe(0);
  });

  it('getDayNormHours: цикл 2/2 — 11ч в рабочий день, 0 в выходной', () => {
    const s = buildCycle22();
    expect(getDayNormHours(s, new Date(2026, 4, 4))).toBe(11);
    expect(getDayNormHours(s, new Date(2026, 4, 6))).toBe(0);
  });

  it('countNormHoursForSchedule: для цикла 2/2 в мае 2026 = 31 день / 4 × 2 раб ≈ 15.5 рабочих дней × 11ч', () => {
    const s = buildCycle22();
    // Май 2026: 31 день, anchor=04.05. По циклу (4-04+offset) рабочие дни:
    // 1,4,5,8,9,12,13,16,17,20,21,24,25,28,29 = 15 дней × 11 = 165
    expect(countNormHoursForSchedule(2026, 5, s)).toBe(165);
  });

  it('assignment_anchor_date перебивает schedule.anchor_date', () => {
    // Сдвигаем anchor через назначение на 1 день вперёд: 04.05 теперь idx 3 (выходной).
    const s = buildCycle22({ assignment_anchor_date: '2026-05-05' });
    // 05.05: idx 0 → 11ч
    expect(getDayNormHours(s, new Date(2026, 4, 5))).toBe(11);
    // 04.05: idx ((-1 % 4) + 4) % 4 = 3 → 0
    expect(getDayNormHours(s, new Date(2026, 4, 4))).toBe(0);
  });

  it('пограничный переход через границу месяца сохраняет фазу цикла', () => {
    const s = buildCycle22();
    // 31.05.26 = 27 дней от anchor → idx 27 % 4 = 3 (выходной)
    expect(getDayNormHours(s, new Date(2026, 4, 31))).toBe(0);
    // 01.06.26 = 28 дней → idx 0 (рабочий)
    expect(getDayNormHours(s, new Date(2026, 5, 1))).toBe(11);
    // 02.06.26 = 29 дней → idx 1 (рабочий)
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
    // anchor 04.05 → 04 рабочий, 05 выходной, 06 рабочий, 07 выходной...
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

  it('countNormHoursForSchedule: формула 5+2-суббот не применяется к cycle', () => {
    const s = buildCycle22({ pattern_type: 'cycle', expected_saturdays_per_month: 4 });
    // Если бы 5+2-формула применялась, было бы 165 + 4*11 = 209.
    expect(countNormHoursForSchedule(2026, 5, s)).toBe(165);
  });

  it('cycle с битыми данными (cycle_days длина не совпадает с cycle_length) → null, фоллбек на work_days', () => {
    const broken: IResolvedSchedule = {
      ...buildCycle22(),
      cycle_length: 4,
      cycle_days: [{ work_hours: 11 }], // длина 1 ≠ 4
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
