import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IResolvedSchedule } from '../types/index.js';

const pgQuery = vi.fn();
vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

const mockedState = vi.hoisted(() => ({
  entries: [] as Array<Record<string, unknown>>,
}));

vi.mock('./attendance.service.js', () => ({
  buildAttendanceEntries: vi.fn(async () => ({
    entries: mockedState.entries,
    objectEntries: [],
    byEmployeeDate: new Map(),
    objectEntriesByEmployeeDate: new Map(),
    skudMap: new Map(),
  })),
}));

// График 5/2 на каждый день периода; календарь пуст. isWorkingDay/isPreHoliday — настоящие.
vi.mock('./schedule.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./schedule.service.js')>();
  const schedule = {
    schedule_id: 'test', schedule_type: 'office', work_start: '09:00:00', work_end: '18:00:00',
    work_hours: 8, work_days: [1, 2, 3, 4, 5], office_days: null, late_threshold_minutes: 0,
    day_overrides: null, lunch_minutes: 0, respects_holidays: true, pattern_type: 'custom',
    expected_saturdays_per_month: 0, expected_sundays_per_month: 0, full_day_threshold_minutes: null,
    weekend_full_day_threshold_minutes: null, cycle_length: null, cycle_days: null,
    anchor_date: null, assignment_anchor_date: null, source: 'default',
  } as unknown as IResolvedSchedule;
  return {
    ...actual,
    loadCalendarMonth: vi.fn(async () => null),
    resolveSchedulesForPeriod: vi.fn(async (
      employees: { id: number }[],
      startDate: string,
      endDate: string,
    ) => {
      const result = new Map<number, Map<string, IResolvedSchedule>>();
      for (const employee of employees) {
        const byDate = new Map<string, IResolvedSchedule>();
        const cursor = new Date(`${startDate}T00:00:00`);
        const last = new Date(`${endDate}T00:00:00`);
        while (cursor <= last) {
          byDate.set(cursor.toISOString().slice(0, 10), schedule);
          cursor.setDate(cursor.getDate() + 1);
        }
        result.set(employee.id, byDate);
      }
      return result;
    }),
  };
});

const {
  buildDetailDisplayItems,
  mergeDetailFailures,
  collectEmployeeTimesheetDetail,
} = await import('./skud-timesheet-detail-export.service.js');

const event = (
  id: number,
  time: string,
  direction: 'entry' | 'exit',
  accessPoint: string | null = 'Полковая-3 3 этаж',
  date = '2026-09-14',
) => ({ id, event_date: date, event_time: time, access_point: accessPoint, direction });

const entry = (date: string, extra: Record<string, unknown> = {}) => ({
  id: 1,
  employee_id: 7,
  work_date: date,
  status: 'work',
  hours_worked: 9,
  display_hours_worked: 8,
  base_hours_worked: 9,
  travel_minutes_credited: 0,
  travel_hours_credited: 0,
  travel_delay_minutes: 0,
  travel_segments_count: 0,
  travel_problematic_segments: 0,
  is_correction: false,
  first_entry: '07:41:00',
  last_exit: '16:55:00',
  ...extra,
});

describe('buildDetailDisplayItems', () => {
  it('считает длительность пары и вставляет «Перерыв» между парами', () => {
    const items = buildDetailDisplayItems(
      [
        event(1, '08:00:00', 'entry'),
        event(2, '12:00:00', 'exit'),
        event(3, '13:00:00', 'entry'),
        event(4, '17:00:00', 'exit'),
      ],
      new Set(),
      '2026-09-14',
      '2026-09-21',
    );

    expect(items.map(i => i.kind)).toEqual(['event', 'event', 'break', 'event', 'event']);
    const firstPair = items[1];
    expect(firstPair.kind === 'event' && firstPair.pairDurationSeconds).toBe(4 * 3600);
    const pause = items[2];
    expect(pause.kind === 'break' && pause.breakSeconds).toBe(3600);
  });

  it('внутренние проходы показывает, но в пару не берёт', () => {
    const items = buildDetailDisplayItems(
      [
        event(1, '08:00:00', 'entry'),
        event(2, '10:00:00', 'exit', 'Турникет 3 этаж'),
        event(3, '17:00:00', 'exit'),
      ],
      new Set(['Турникет 3 этаж']),
      '2026-09-14',
      '2026-09-21',
    );

    const internal = items[1];
    expect(internal.kind === 'event' && internal.isInternal).toBe(true);
    expect(internal.kind === 'event' && internal.pairDurationSeconds).toBeNull();
    const external = items[2];
    expect(external.kind === 'event' && external.pairDurationSeconds).toBe(9 * 3600);
  });

  it('открытый вход за сегодня закрывает по «сейчас»', () => {
    const items = buildDetailDisplayItems(
      [event(1, '08:00:00', 'entry')],
      new Set(),
      '2026-09-21',
      '2026-09-21',
      10 * 3600,
    );
    const open = items[0];
    expect(open.kind === 'event' && open.pairDurationSeconds).toBe(2 * 3600);
  });
});

describe('mergeDetailFailures', () => {
  it('ставит незачтённое событие на место по времени', () => {
    const items = buildDetailDisplayItems(
      [event(1, '08:00:00', 'entry'), event(2, '17:00:00', 'exit')],
      new Set(),
      '2026-09-14',
      '2026-09-21',
    );

    const merged = mergeDetailFailures(items, [{
      id: 99,
      event_date: '2026-09-14',
      event_time: '12:30:00',
      access_point: 'Полковая-3 3 этаж',
      failure_type: 'PASS_DENY',
      reason: 'Карта не найдена',
    }]);

    expect(merged.map(i => i.kind)).toEqual(['event', 'failure', 'event']);
  });
});

describe('collectEmployeeTimesheetDetail', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-21T10:00:00'));
    pgQuery.mockReset();
    pgQuery.mockResolvedValue([{ id: 7, full_name: 'Гладкая Н. В.' }]);
    mockedState.entries = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const collect = (startDate: string, endDate: string, showActualHours = false) =>
    collectEmployeeTimesheetDetail({
      employeeId: 7,
      startDate,
      endDate,
      showActualHours,
      events: [],
      failures: [],
      internalPoints: new Set(),
    });

  it('пропускает выходной без записи, будущий день и держит выходной с записью', async () => {
    // 2026-09-19 — суббота, 2026-09-20 — воскресенье, «сегодня» — 21-е.
    mockedState.entries = [entry('2026-09-14'), entry('2026-09-20')];

    const data = await collect('2026-09-14', '2026-09-22');

    const dates = data.days.map(day => day.date);
    expect(dates).toContain('2026-09-14');
    expect(dates).toContain('2026-09-20');
    expect(dates).not.toContain('2026-09-19');
    expect(dates).not.toContain('2026-09-22');
    // Рабочий день без записи остаётся в списке — как пустая строка в панели.
    expect(dates).toContain('2026-09-15');
    expect(data.days.find(day => day.date === '2026-09-15')?.hoursLabel).toBe('—');
  });

  it('берёт урезанные часы, а при show_actual_hours — фактические', async () => {
    mockedState.entries = [entry('2026-09-14')];

    const capped = await collect('2026-09-14', '2026-09-14');
    expect(capped.days[0].hoursLabel).toBe('8ч');
    expect(capped.days[0].firstEntry).toBe('07:41:00');
    expect(capped.days[0].lastExit).toBe('16:55:00');

    const actual = await collect('2026-09-14', '2026-09-14', true);
    expect(actual.days[0].hoursLabel).toBe('9ч');
  });

  it('показывает статусы вместо часов и собирает подпись проблем «Дороги»', async () => {
    mockedState.entries = [
      entry('2026-09-14', { status: 'absent', hours_worked: 0, display_hours_worked: 0 }),
      entry('2026-09-15', { status: 'sick' }),
      entry('2026-09-16', { status: 'vacation' }),
      entry('2026-09-17', { travel_delay_minutes: 30, travel_problematic_segments: 2 }),
    ];

    const data = await collect('2026-09-14', '2026-09-17');

    expect(data.days.map(day => day.hoursLabel)).toEqual(['Неявка', 'Б/л', 'Отпуск', '8ч']);
    expect(data.days[3].travelNote).toBe('превышение лимита 30 мин • не определён объект (2)');
  });

  it('раскладывает события СКУД по дням', async () => {
    mockedState.entries = [entry('2026-09-14'), entry('2026-09-15')];

    const data = await collectEmployeeTimesheetDetail({
      employeeId: 7,
      startDate: '2026-09-14',
      endDate: '2026-09-15',
      showActualHours: false,
      events: [
        event(1, '08:00:00', 'entry', 'Полковая-3 3 этаж', '2026-09-14'),
        event(2, '17:00:00', 'exit', 'Полковая-3 3 этаж', '2026-09-14'),
        event(3, '09:00:00', 'entry', 'Полковая-3 3 этаж', '2026-09-15'),
      ],
      failures: [],
      internalPoints: new Set(),
    });

    expect(data.days[0].items).toHaveLength(2);
    expect(data.days[1].items).toHaveLength(1);
    expect(data.employeeName).toBe('Гладкая Н. В.');
  });
});
