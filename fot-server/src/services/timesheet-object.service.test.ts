import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const mockedState = vi.hoisted(() => ({
  internalPoints: new Set<string>(),
  tables: {
    skud_object_access_points: [] as Array<{ object_id: string; access_point_name: string }>,
    skud_objects: [] as Array<{ id: string; name: string }>,
    skud_events: [] as Array<{
      employee_id: number;
      event_date: string;
      event_time: string;
      access_point: string;
      direction: 'entry' | 'exit';
    }>,
    employee_skud_object_access: [] as Array<{ employee_id: number; skud_object_id: string }>,
  },
}));

vi.mock('./skud-shared.service.js', () => ({
  getInternalAccessPoints: vi.fn(async () => mockedState.internalPoints),
}));

import {
  buildObjectAttendanceData,
  UNKNOWN_OBJECT_NAME,
} from './timesheet-object.service.js';

// Маршрутизирует SQL → нужную in-memory таблицу. Тесту проще задавать данные
// через mockedState.tables, чем расписывать mockResolvedValueOnce под каждый
// fetchObjectMappings/fetchRawEvents (порядок зависит от Promise.all внутри сервиса).
function routeQuery(sql: string): unknown[] {
  const s = sql.toLowerCase();
  if (s.includes('employee_skud_object_access')) {
    return mockedState.tables.employee_skud_object_access;
  }
  // resolveSchedulesBulk (определение remote-сотрудников) и датированная привязка —
  // в этих тестах нет remote-сотрудников, отдаём пусто.
  if (s.includes('employee_schedule_assignments')) {
    return [];
  }
  if (s.includes('employee_object_attribution')) {
    return [];
  }
  if (s.includes('skud_object_access_points')) {
    return mockedState.tables.skud_object_access_points;
  }
  if (s.includes('skud_objects')) {
    return mockedState.tables.skud_objects;
  }
  if (s.includes('skud_events')) {
    return mockedState.tables.skud_events;
  }
  throw new Error(`Unexpected SQL routing: ${sql}`);
}

describe('timesheet-object.service', () => {
  beforeEach(() => {
    pgQuery.mockReset();
    pgQueryOne.mockReset();
    pgExecute.mockReset();
    pgTx.mockReset();

    mockedState.internalPoints = new Set();
    mockedState.tables.skud_object_access_points = [
      { object_id: 'obj-a', access_point_name: 'КПП A' },
      { object_id: 'obj-b', access_point_name: 'КПП B' },
    ];
    mockedState.tables.skud_objects = [
      { id: 'obj-a', name: 'Объект A' },
      { id: 'obj-b', name: 'Объект B' },
    ];
    mockedState.tables.skud_events = [];
    mockedState.tables.employee_skud_object_access = [];

    pgQuery.mockImplementation(async (sql: string) => routeQuery(sql));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('groups repeated visits to the same object and exposes only multi-object employees for disclosure', async () => {
    mockedState.tables.skud_events = [
      { employee_id: 1, event_date: '2026-04-10', event_time: '09:00:00', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-10', event_time: '12:00:00', access_point: 'КПП A', direction: 'exit' },
      { employee_id: 1, event_date: '2026-04-10', event_time: '12:30:00', access_point: 'КПП B', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-10', event_time: '15:00:00', access_point: 'КПП B', direction: 'exit' },
      { employee_id: 1, event_date: '2026-04-10', event_time: '15:30:00', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-10', event_time: '18:00:00', access_point: 'КПП A', direction: 'exit' },
    ];

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-04-10',
      endDate: '2026-04-10',
      todayStr: '2026-04-10',
      adjustments: [],
    });

    expect(result.objectEntries).toEqual([
      expect.objectContaining({
        employee_id: 1,
        work_date: '2026-04-10',
        object_id: 'obj-a',
        object_name: 'Объект A',
        hours_worked: 5.5,
      }),
      expect.objectContaining({
        employee_id: 1,
        work_date: '2026-04-10',
        object_id: 'obj-b',
        object_name: 'Объект B',
        hours_worked: 2.5,
      }),
    ]);
    expect(result.employeeDistinctObjectKeys.get(1)).toEqual(new Set(['obj-a', 'obj-b']));
  });

  it('discards orphan entry on repeated entry without exit (strict closed-pairs policy)', async () => {
    // Повторный вход без промежуточного выхода: гэп 09:00→13:00 НЕ считается, орфан 09:00
    // затирается, учитывается только закрытая пара 13:00→17:00 = 4ч. До фикса считалось 8ч
    // (09:00→13:00 + 13:00→17:00). Паритет с buildRawFallbackSummary (миграция 161).
    mockedState.tables.skud_events = [
      { employee_id: 1, event_date: '2026-04-10', event_time: '09:00:00', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-10', event_time: '13:00:00', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-10', event_time: '17:00:00', access_point: 'КПП A', direction: 'exit' },
    ];

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-04-10',
      endDate: '2026-04-10',
      todayStr: '2026-04-10',
      adjustments: [],
    });

    expect(result.objectEntries).toEqual([
      expect.objectContaining({
        employee_id: 1,
        work_date: '2026-04-10',
        object_id: 'obj-a',
        object_name: 'Объект A',
        hours_worked: 4,
      }),
    ]);
  });

  it('marks unknown access points as synthetic object and keeps open current interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 11, 11, 30, 0));

    mockedState.tables.skud_object_access_points = [
      { object_id: 'obj-a', access_point_name: 'КПП A' },
    ];
    mockedState.tables.skud_objects = [{ id: 'obj-a', name: 'Объект A' }];
    mockedState.tables.skud_events = [
      { employee_id: 1, event_date: '2026-04-11', event_time: '06:00:00', access_point: 'КПП X', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-11', event_time: '08:00:00', access_point: 'КПП X', direction: 'exit' },
      { employee_id: 1, event_date: '2026-04-11', event_time: '09:00:00', access_point: 'КПП A', direction: 'entry' },
    ];

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-04-11',
      endDate: '2026-04-11',
      todayStr: '2026-04-11',
      adjustments: [],
    });

    expect(result.objectEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        object_name: 'Объект A',
        hours_worked: 2.5,
      }),
      expect.objectContaining({
        object_name: UNKNOWN_OBJECT_NAME,
        hours_worked: 2,
      }),
    ]));
    expect(result.objectEntries).toHaveLength(2);
  });

  it('overrides only the targeted object when manual object adjustment exists', async () => {
    mockedState.tables.skud_events = [
      { employee_id: 1, event_date: '2026-04-12', event_time: '09:00:00', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-12', event_time: '12:00:00', access_point: 'КПП A', direction: 'exit' },
      { employee_id: 1, event_date: '2026-04-12', event_time: '12:30:00', access_point: 'КПП B', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-12', event_time: '15:30:00', access_point: 'КПП B', direction: 'exit' },
    ];

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-04-12',
      endDate: '2026-04-12',
      todayStr: '2026-04-12',
      adjustments: [
        {
          id: 55,
          employee_id: 1,
          work_date: '2026-04-12',
          hours_override: 4,
          source_type: 'manual_object',
          source_id: 'obj-b',
          status: 'work',
          reason: 'Руководитель поправил часы',
          updated_at: '2026-04-12T12:00:00.000Z',
          metadata: {
            object_id: 'obj-b',
            object_name: 'Объект B',
          },
        },
      ],
    });

    expect(result.objectEntries).toEqual([
      expect.objectContaining({
        object_name: 'Объект A',
        hours_worked: 3,
        is_correction: false,
      }),
      expect.objectContaining({
        adjustment_id: 55,
        object_name: 'Объект B',
        base_hours_worked: 3,
        hours_worked: 4,
        is_correction: true,
      }),
    ]);
  });

  it('relocates a manual day-level correction onto the employee single assigned object', async () => {
    mockedState.tables.employee_skud_object_access = [{ employee_id: 1, skud_object_id: 'obj-a' }];

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-04-13',
      endDate: '2026-04-13',
      todayStr: '2026-04-13',
      adjustments: [
        {
          id: 77,
          employee_id: 1,
          work_date: '2026-04-13',
          hours_override: 8,
          source_type: 'manual',
          source_id: 'manual',
          status: 'work',
          reason: 'Дневная корректировка',
          updated_at: '2026-04-13T10:00:00.000Z',
          metadata: {},
        },
      ],
    });

    expect(result.objectEntries).toEqual([
      expect.objectContaining({
        adjustment_id: 77,
        employee_id: 1,
        work_date: '2026-04-13',
        object_id: 'obj-a',
        object_name: 'Объект A',
        hours_worked: 8,
        is_correction: true,
      }),
    ]);
    expect(result.legacyBlockedDays.size).toBe(0);
  });

  it('splits a manual day-level correction equally across multiple assigned objects', async () => {
    mockedState.tables.skud_objects = [
      { id: 'obj-a', name: 'Объект A' },
      { id: 'obj-b', name: 'Объект B' },
      { id: 'obj-c', name: 'Объект C' },
    ];
    mockedState.tables.employee_skud_object_access = [
      { employee_id: 1, skud_object_id: 'obj-a' },
      { employee_id: 1, skud_object_id: 'obj-b' },
      { employee_id: 1, skud_object_id: 'obj-c' },
    ];

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-04-13',
      endDate: '2026-04-13',
      todayStr: '2026-04-13',
      adjustments: [
        {
          id: 78,
          employee_id: 1,
          work_date: '2026-04-13',
          hours_override: 1,
          source_type: 'manual',
          source_id: 'manual',
          status: 'work',
          reason: 'Корректировка',
          updated_at: '2026-04-13T10:00:00.000Z',
          metadata: {},
        },
      ],
    });

    expect(result.objectEntries.map(entry => entry.object_name)).toEqual([
      'Объект A', 'Объект B', 'Объект C',
    ]);
    expect(result.objectEntries.map(entry => entry.hours_worked)).toEqual([0.34, 0.33, 0.33]);
    const total = result.objectEntries.reduce((sum, entry) => sum + entry.hours_worked, 0);
    expect(Math.round(total * 100) / 100).toBe(1);
    expect(result.objectEntries.every(entry => entry.is_correction)).toBe(true);
  });

  it('keeps a manual correction in the unknown object when the employee has no assignment', async () => {
    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-04-13',
      endDate: '2026-04-13',
      todayStr: '2026-04-13',
      adjustments: [
        {
          id: 79,
          employee_id: 1,
          work_date: '2026-04-13',
          hours_override: 8,
          source_type: 'manual',
          source_id: 'manual',
          status: 'work',
          reason: 'Корректировка',
          updated_at: '2026-04-13T10:00:00.000Z',
          metadata: {},
        },
      ],
    });

    expect(result.objectEntries).toEqual([
      expect.objectContaining({
        object_id: null,
        object_name: UNKNOWN_OBJECT_NAME,
        hours_worked: 8,
        is_correction: true,
      }),
    ]);
  });

  it('overrides same-day skud object intervals with the corrected assigned object (no double count)', async () => {
    mockedState.tables.skud_events = [
      { employee_id: 1, event_date: '2026-04-13', event_time: '09:00:00', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-13', event_time: '12:00:00', access_point: 'КПП A', direction: 'exit' },
      { employee_id: 1, event_date: '2026-04-13', event_time: '12:30:00', access_point: 'КПП B', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-13', event_time: '15:30:00', access_point: 'КПП B', direction: 'exit' },
    ];
    mockedState.tables.employee_skud_object_access = [{ employee_id: 1, skud_object_id: 'obj-a' }];

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-04-13',
      endDate: '2026-04-13',
      todayStr: '2026-04-13',
      adjustments: [
        {
          id: 80,
          employee_id: 1,
          work_date: '2026-04-13',
          hours_override: 8,
          source_type: 'manual',
          source_id: 'manual',
          status: 'work',
          reason: 'Корректировка',
          updated_at: '2026-04-13T10:00:00.000Z',
          metadata: {},
        },
      ],
    });

    expect(result.objectEntries).toEqual([
      expect.objectContaining({
        adjustment_id: 80,
        object_id: 'obj-a',
        object_name: 'Объект A',
        hours_worked: 8,
        is_correction: true,
      }),
    ]);
    expect(result.objectEntries).toHaveLength(1);
  });

  it('does not generate object entries for a non-work correction without worked hours', async () => {
    mockedState.tables.employee_skud_object_access = [{ employee_id: 1, skud_object_id: 'obj-a' }];

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-04-13',
      endDate: '2026-04-13',
      todayStr: '2026-04-13',
      adjustments: [
        {
          id: 81,
          employee_id: 1,
          work_date: '2026-04-13',
          hours_override: null,
          source_type: 'manual',
          source_id: 'manual',
          status: 'vacation',
          reason: 'Отпуск',
          updated_at: '2026-04-13T10:00:00.000Z',
          metadata: {},
        },
      ],
    });

    expect(result.objectEntries).toEqual([]);
    expect(result.legacyBlockedDays.size).toBe(0);
  });

  it('clears same-day skud intervals when a work day is zeroed out (status=work, hours_override=0)', async () => {
    mockedState.tables.employee_skud_object_access = [{ employee_id: 1, skud_object_id: 'obj-a' }];
    mockedState.tables.skud_events = [
      { employee_id: 1, event_date: '2026-05-17', event_time: '10:47:43', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-05-17', event_time: '11:50:08', access_point: 'КПП A', direction: 'exit' },
    ];

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-05-17',
      endDate: '2026-05-17',
      todayStr: '2026-05-17',
      adjustments: [
        {
          id: 3579,
          employee_id: 1,
          work_date: '2026-05-17',
          hours_override: 0,
          source_type: 'manual',
          source_id: 'manual',
          status: 'work',
          reason: 'не согласован рабочий день',
          updated_at: '2026-05-18T06:08:42.890Z',
          metadata: {},
        },
      ],
    });

    expect(result.objectEntries).toEqual([]);
  });

  it('clears same-day skud intervals for an absence correction with a stray skud swipe', async () => {
    mockedState.tables.employee_skud_object_access = [{ employee_id: 1, skud_object_id: 'obj-a' }];
    mockedState.tables.skud_events = [
      { employee_id: 1, event_date: '2026-04-13', event_time: '09:00:00', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-13', event_time: '10:00:00', access_point: 'КПП A', direction: 'exit' },
    ];

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-04-13',
      endDate: '2026-04-13',
      todayStr: '2026-04-13',
      adjustments: [
        {
          id: 82,
          employee_id: 1,
          work_date: '2026-04-13',
          hours_override: null,
          source_type: 'manual',
          source_id: 'manual',
          status: 'vacation',
          reason: 'Отпуск',
          updated_at: '2026-04-13T10:00:00.000Z',
          metadata: {},
        },
      ],
    });

    expect(result.objectEntries).toEqual([]);
  });
});
