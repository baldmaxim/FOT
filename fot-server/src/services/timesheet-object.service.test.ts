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
  // Ночной гейт окна (миграция 168): резолв графика мокается ниже. true → у сотрудника
  // ночная смена (пара может пересекать полночь); false → дневная (окно режется полночью).
  isNightShift: false,
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

// Подменяем только getInternalAccessPoints; остальное берём из настоящего модуля,
// иначе теряется PRESENCE_FAILURE_TYPE_IDS (whitelist типов отказов живёт там же).
vi.mock('./skud-shared.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./skud-shared.service.js')>();
  return {
    ...actual,
    getInternalAccessPoints: vi.fn(async () => mockedState.internalPoints),
  };
});

// Ночной гейт окна (миграция 168) резолвит график на дату. Мокаем только
// resolveSchedulesForPeriod, отдавая дневной/ночной график по флагу mockedState.isNightShift;
// isNightShiftDay (реальный из actual) применяется в сервисе к этому графику.
vi.mock('./schedule.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./schedule.service.js')>();
  const daySched = { pattern_type: 'custom', cycle_days: null, day_overrides: null,
    work_start: '09:00:00', work_end: '18:00:00', work_hours: 8, lunch_minutes: 0 };
  const nightSched = { ...daySched, work_start: '20:00:00', work_end: '08:00:00' };
  return {
    ...actual,
    resolveSchedulesForPeriod: vi.fn(async (
      employees: { id: number }[],
      startDate: string,
      endDate: string,
    ) => {
      const sched = (mockedState.isNightShift ? nightSched : daySched) as unknown as
        ReturnType<typeof actual.resolveSchedule> extends Promise<infer R> ? R : never;
      const result = new Map<number, Map<string, typeof sched>>();
      for (const e of employees) {
        const dayMap = new Map<string, typeof sched>();
        let ts = Date.parse(`${startDate}T00:00:00Z`);
        const endTs = Date.parse(`${endDate}T00:00:00Z`);
        while (ts <= endTs) {
          dayMap.set(new Date(ts).toISOString().slice(0, 10), sched);
          ts += 86_400_000;
        }
        result.set(e.id, dayMap);
      }
      return result;
    }),
  };
});

import {
  buildObjectAttendanceData,
  PRESENCE_FAILURE_TYPE_IDS,
  allocationsEqual,
  canonicalizeAllocations,
  hasObjectAllocations,
  readObjectAllocations,
  resolveDayAllocationSuggestion,
  resolveDayObjectDetailed,
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
    mockedState.isNightShift = false;
    mockedState.tables.skud_object_access_points = [
      { object_id: 'obj-a', access_point_name: 'КПП A' },
      { object_id: 'obj-b', access_point_name: 'КПП B' },
    ];
    mockedState.tables.skud_objects = [
      { id: 'obj-a', name: 'Объект A' },
      { id: 'obj-b', name: 'Объект B' },
      { id: 'obj-c', name: 'Объект C' },
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

  it('pairs a night shift across midnight and attributes it to the shift start day', async () => {
    // Ночная смена: вход 19:00 (день N) → выход 06:00 (день N+1), один объект. Окно смены
    // 32ч (миграция 161) парит через полночь; до фикса пара 22:30→06:00 терялась (закрытие
    // лежало в бакете следующего дня) и день показывал только 3ч вместо 10.5ч.
    // Ночной гейт (168) пропускает overnight только при ночном графике.
    mockedState.isNightShift = true;
    mockedState.tables.skud_events = [
      { employee_id: 1, event_date: '2026-04-10', event_time: '19:00:00', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-10', event_time: '22:00:00', access_point: 'КПП A', direction: 'exit' },
      { employee_id: 1, event_date: '2026-04-10', event_time: '22:30:00', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-11', event_time: '06:00:00', access_point: 'КПП A', direction: 'exit' },
    ];

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-04-10',
      endDate: '2026-04-10',
      todayStr: '2026-04-15',
      adjustments: [],
    });

    // (22:00−19:00) + (06:00+1д−22:30) = 3ч + 7.5ч = 10.5ч, привязано к дню начала 10-го.
    expect(result.objectEntries).toEqual([
      expect.objectContaining({
        employee_id: 1,
        work_date: '2026-04-10',
        object_id: 'obj-a',
        hours_worked: 10.5,
      }),
    ]);
  });

  it('splits a multi-object night shift across midnight onto the start day', async () => {
    // Вход A вечером → выход A → вход B → выход B утром следующего дня. Часы разносятся
    // по объектам, оба интервала привязаны к дню начала смены; утренний выход-только день
    // (без входа) собственной записи не порождает. Ночной гейт (168): ночной график.
    mockedState.isNightShift = true;
    mockedState.tables.skud_events = [
      { employee_id: 1, event_date: '2026-04-10', event_time: '20:00:00', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-10', event_time: '23:00:00', access_point: 'КПП A', direction: 'exit' },
      { employee_id: 1, event_date: '2026-04-10', event_time: '23:30:00', access_point: 'КПП B', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-11', event_time: '05:30:00', access_point: 'КПП B', direction: 'exit' },
    ];

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-04-10',
      endDate: '2026-04-11',
      todayStr: '2026-04-15',
      adjustments: [],
    });

    expect(result.objectEntries).toEqual([
      expect.objectContaining({ work_date: '2026-04-10', object_id: 'obj-a', hours_worked: 3 }),
      expect.objectContaining({ work_date: '2026-04-10', object_id: 'obj-b', hours_worked: 6 }),
    ]);
    expect(result.objectEntries.some(entry => entry.work_date === '2026-04-11')).toBe(false);
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

  it('keeps the open external entry when later entries are at a different point (does not reset)', async () => {
    // Кейс Биркиной без классификации: внешний вход @КПП A, далее входы по ДРУГОЙ точке
    // @КПП B (неразмеченная внутренняя дверь), выход @КПП A. Открытый вход @A НЕ
    // сбрасывается входами @B → пара 09:00→16:00 = 7ч на объекте A. До фикса «последний
    // вход побеждает» брал @B 09:05 → пара 09:05→16:00 на чужом объекте. Миграция 163.
    mockedState.tables.skud_events = [
      { employee_id: 1, event_date: '2026-04-14', event_time: '09:00:00', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-14', event_time: '09:05:00', access_point: 'КПП B', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-14', event_time: '11:30:00', access_point: 'КПП B', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-14', event_time: '16:00:00', access_point: 'КПП A', direction: 'exit' },
    ];

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-04-14',
      endDate: '2026-04-14',
      todayStr: '2026-04-14',
      adjustments: [],
    });

    expect(result.objectEntries).toEqual([
      expect.objectContaining({
        employee_id: 1,
        work_date: '2026-04-14',
        object_id: 'obj-a',
        object_name: 'Объект A',
        hours_worked: 7,
      }),
    ]);
    expect(result.objectEntries).toHaveLength(1);
  });

  it('resets the open entry on repeated swipe of the SAME point (keeps last, parity with 161)', async () => {
    // Повторный пробив ТОЙ ЖЕ точки КПП A: открытый вход затирается поздним → пара
    // 13:00→17:00 = 4ч (вход 09:00 отброшен). Поведение строгой политики 161 сохранено.
    mockedState.tables.skud_events = [
      { employee_id: 1, event_date: '2026-04-14', event_time: '09:00:00', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-14', event_time: '13:00:00', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-14', event_time: '17:00:00', access_point: 'КПП A', direction: 'exit' },
    ];

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-04-14',
      endDate: '2026-04-14',
      todayStr: '2026-04-14',
      adjustments: [],
    });

    expect(result.objectEntries).toEqual([
      expect.objectContaining({ object_id: 'obj-a', hours_worked: 4 }),
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

  it('authoritative object correction clears same-day uncorrected skud objects (Ортиков: К13+К14 одного ЖК)', async () => {
    // Кейс бр.Ортиков: сотрудник отмечается на двух точках одного ЖК (КПП A/Объект A и
    // КПП B/Объект B). Руководитель/табельщица ставит явную объектную правку 4ч на Объект B.
    // Правка авторитетна для дня → неоткорректированный СКУД-Объект A снимается, дневной итог
    // = часы правки (4ч). Иначе итог = A(3)+B(4) ≈ норма графика, и «Как в 1С» схлопывает правку.
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
        adjustment_id: 55,
        object_name: 'Объект B',
        base_hours_worked: 3,
        hours_worked: 4,
        is_correction: true,
      }),
    ]);
  });

  it('явное распределение по объектам перекрывает приписку и раскладывает часы', async () => {
    // Приписка ведёт на obj-a, но табельщица указала распределение 7 + 4 — оно сильнее
    // любых сигналов: именно человек знает, где сотрудник работал в этот день.
    mockedState.tables.employee_skud_object_access = [{ employee_id: 1, skud_object_id: 'obj-a' }];

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-04-13',
      endDate: '2026-04-13',
      todayStr: '2026-04-13',
      adjustments: [
        {
          id: 91,
          employee_id: 1,
          work_date: '2026-04-13',
          hours_override: 11,
          source_type: 'manual',
          source_id: 'manual',
          status: 'manual',
          reason: 'Работал на двух объектах',
          updated_at: '2026-04-13T10:00:00.000Z',
          metadata: {
            object_allocations: [
              { object_id: 'obj-b', object_name: 'Объект B', hours: 7 },
              { object_id: 'obj-c', object_name: 'Объект C', hours: 4 },
            ],
            allocation_source: 'manual_choice',
          },
        },
      ],
    });

    const byObject = new Map(result.objectEntries.map(entry => [entry.object_id, entry.hours_worked]));
    expect(byObject.get('obj-b')).toBe(7);
    expect(byObject.get('obj-c')).toBe(4);
    expect(byObject.has('obj-a')).toBe(false);
    // Сумма долей точно равна часам корректировки — день не задваивается.
    expect(result.objectEntries.reduce((sum, entry) => sum + entry.hours_worked, 0)).toBe(11);
  });

  it('битые аллокации трактуются как их отсутствие: работает прежний фолбэк', async () => {
    mockedState.tables.employee_skud_object_access = [{ employee_id: 1, skud_object_id: 'obj-a' }];

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-04-13',
      endDate: '2026-04-13',
      todayStr: '2026-04-13',
      adjustments: [
        {
          id: 92,
          employee_id: 1,
          work_date: '2026-04-13',
          hours_override: 8,
          source_type: 'manual',
          source_id: 'manual',
          status: 'manual',
          reason: 'Битая metadata',
          updated_at: '2026-04-13T10:00:00.000Z',
          metadata: { object_allocations: 'сломано' as unknown as [] },
        },
      ],
    });

    expect(result.objectEntries).toEqual([
      expect.objectContaining({ object_id: 'obj-a', hours_worked: 8 }),
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

  it('treats a migrated day-level correction as authoritative day total (clears multi-object skud, no double count)', async () => {
    // Регрессия (Примавера К13/К14): СКУД распределён на ДВА объекта, плюс мигрированная
    // из day-level правка на obj-a. Без фикса obj-b СКУД (3ч) оставался и складывался с
    // правкой (8ч) → 11ч задвоения. Ожидаем единый итог = правка, СКУД дня очищен.
    // Приписка сотрудника (obj-b) ≠ объект миграции (obj-a) — как у Бабышева; перераспределение
    // day-level идёт на приписанный объект.
    mockedState.tables.skud_events = [
      { employee_id: 1, event_date: '2026-04-14', event_time: '09:00:00', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-14', event_time: '12:00:00', access_point: 'КПП A', direction: 'exit' },
      { employee_id: 1, event_date: '2026-04-14', event_time: '12:30:00', access_point: 'КПП B', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-14', event_time: '15:30:00', access_point: 'КПП B', direction: 'exit' },
    ];
    mockedState.tables.employee_skud_object_access = [{ employee_id: 1, skud_object_id: 'obj-b' }];

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-04-14',
      endDate: '2026-04-14',
      todayStr: '2026-04-14',
      adjustments: [
        {
          id: 90,
          employee_id: 1,
          work_date: '2026-04-14',
          hours_override: 8,
          source_type: 'manual_object',
          source_id: 'obj-a',
          status: 'manual',
          reason: 'контроль работ за пределами скуд',
          updated_at: '2026-04-14T10:00:00.000Z',
          metadata: {
            object_id: 'obj-a',
            object_name: 'Объект A',
            migrated_from_day_level: true,
          },
        },
      ],
    });

    expect(result.objectEntries).toEqual([
      expect.objectContaining({
        adjustment_id: 90,
        object_id: 'obj-b',
        object_name: 'Объект B',
        hours_worked: 8,
        is_correction: true,
      }),
    ]);
    expect(result.objectEntries).toHaveLength(1);
  });

  it('keeps a migrated day-level correction on its migrated object when employee has no assignment/skud', async () => {
    // Сотрудник без приписки и без СКУД в этот день: мигрированная правка остаётся на
    // объекте, выбранном миграцией (metadata.object_id), а не уходит в «Не определён».
    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-04-14',
      endDate: '2026-04-14',
      todayStr: '2026-04-14',
      adjustments: [
        {
          id: 91,
          employee_id: 1,
          work_date: '2026-04-14',
          hours_override: 8,
          source_type: 'manual_object',
          source_id: 'obj-b',
          status: 'manual',
          reason: 'работа за пределами скуд',
          updated_at: '2026-04-14T10:00:00.000Z',
          metadata: {
            object_id: 'obj-b',
            object_name: 'Объект B',
            migrated_from_day_level: true,
          },
        },
      ],
    });

    expect(result.objectEntries).toEqual([
      expect.objectContaining({
        adjustment_id: 91,
        object_id: 'obj-b',
        object_name: 'Объект B',
        hours_worked: 8,
        is_correction: true,
      }),
    ]);
  });

  it('routes a day correction to the single real-skud object, not across all assignments (Кулагин)', async () => {
    // Руководитель приписан к 3 ЖК (доступ), но физически отметился только на obj-a.
    // Мигрированная day-level правка должна лечь целиком на реальный объект дня (obj-a),
    // а не размазаться по 3 приписке (фантомные строки на obj-b/obj-c).
    mockedState.tables.skud_events = [
      { employee_id: 1, event_date: '2026-04-15', event_time: '09:00:00', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-15', event_time: '12:00:00', access_point: 'КПП A', direction: 'exit' },
    ];
    mockedState.tables.employee_skud_object_access = [
      { employee_id: 1, skud_object_id: 'obj-a' },
      { employee_id: 1, skud_object_id: 'obj-b' },
      { employee_id: 1, skud_object_id: 'obj-c' },
    ];

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-04-15',
      endDate: '2026-04-15',
      todayStr: '2026-04-15',
      adjustments: [
        {
          id: 92,
          employee_id: 1,
          work_date: '2026-04-15',
          hours_override: 10,
          source_type: 'manual_object',
          source_id: 'obj-a',
          status: 'work',
          reason: 'контроль работ',
          updated_at: '2026-04-15T10:00:00.000Z',
          metadata: { object_id: 'obj-a', object_name: 'Объект A', migrated_from_day_level: true },
        },
      ],
    });

    expect(result.objectEntries).toEqual([
      expect.objectContaining({ adjustment_id: 92, object_id: 'obj-a', hours_worked: 10, is_correction: true }),
    ]);
    expect(result.objectEntries).toHaveLength(1);
  });

  it('splits a day correction across the real-skud objects proportionally to minutes (Жабунин)', async () => {
    // Сотрудник реально ходил на 2 объекта (obj-a 3ч, obj-b 1ч) и приписан к ним же.
    // Мигрированная day-level правка (8ч) делится пропорц. минутам присутствия: 6ч/2ч.
    mockedState.tables.skud_events = [
      { employee_id: 1, event_date: '2026-04-16', event_time: '09:00:00', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-16', event_time: '12:00:00', access_point: 'КПП A', direction: 'exit' },
      { employee_id: 1, event_date: '2026-04-16', event_time: '13:00:00', access_point: 'КПП B', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-16', event_time: '14:00:00', access_point: 'КПП B', direction: 'exit' },
    ];
    mockedState.tables.employee_skud_object_access = [
      { employee_id: 1, skud_object_id: 'obj-a' },
      { employee_id: 1, skud_object_id: 'obj-b' },
    ];

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-04-16',
      endDate: '2026-04-16',
      todayStr: '2026-04-16',
      adjustments: [
        {
          id: 93,
          employee_id: 1,
          work_date: '2026-04-16',
          hours_override: 8,
          source_type: 'manual_object',
          source_id: 'obj-a',
          status: 'work',
          reason: 'контроль работ',
          updated_at: '2026-04-16T10:00:00.000Z',
          metadata: { object_id: 'obj-a', object_name: 'Объект A', migrated_from_day_level: true },
        },
      ],
    });

    expect(result.objectEntries).toHaveLength(2);
    expect(result.objectEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ object_id: 'obj-a', hours_worked: 6, is_correction: true }),
      expect.objectContaining({ object_id: 'obj-b', hours_worked: 2, is_correction: true }),
    ]));
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

  it('day shift: discards a phantom evening entry closed by next-morning exit (night gate, 168)', async () => {
    // Кейс Улмасов 1836 / 15.05.2026 (дневной график). Днём нормальная смена 09:00→18:00
    // (пары 3ч + 4ч = 7ч). Затем фантомный повторный вход 18:01 без выхода в тот же день,
    // закрывается выходом СЛЕДУЮЩЕГО утра 07:00. До фикса окно +32ч ловило 07:00 → пара
    // 18:01→07:00 ≈ 13ч прибавлялась (итог ~20ч). Ночной гейт режет окно полночью →
    // вечерний вход остаётся orphan, день = 7ч.
    mockedState.tables.skud_events = [
      { employee_id: 1, event_date: '2026-04-10', event_time: '09:00:00', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-10', event_time: '12:00:00', access_point: 'КПП A', direction: 'exit' },
      { employee_id: 1, event_date: '2026-04-10', event_time: '14:00:00', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-10', event_time: '18:00:00', access_point: 'КПП A', direction: 'exit' },
      { employee_id: 1, event_date: '2026-04-10', event_time: '18:01:00', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-11', event_time: '07:00:00', access_point: 'КПП A', direction: 'exit' },
    ];

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-04-10',
      endDate: '2026-04-10',
      todayStr: '2026-04-15',
      adjustments: [],
    });

    expect(result.objectEntries).toEqual([
      expect.objectContaining({ work_date: '2026-04-10', object_id: 'obj-a', hours_worked: 7 }),
    ]);
    expect(result.objectEntries.some(e => e.work_date === '2026-04-11')).toBe(false);
  });

  it('day shift: exit at exactly 00:00 next day is excluded by the window boundary (strict <)', async () => {
    // Граница: дневная смена 09:00→17:00 (8ч) + фантомный вход 23:00, закрытие ровно в 00:00
    // следующего дня. Окно режется по 00:00 (строгое <) → выход 00:00 исключён, вход 23:00
    // orphan. День = 8ч, без переноса через полночь.
    mockedState.tables.skud_events = [
      { employee_id: 1, event_date: '2026-04-10', event_time: '09:00:00', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-10', event_time: '17:00:00', access_point: 'КПП A', direction: 'exit' },
      { employee_id: 1, event_date: '2026-04-10', event_time: '23:00:00', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-04-11', event_time: '00:00:00', access_point: 'КПП A', direction: 'exit' },
    ];

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-04-10',
      endDate: '2026-04-10',
      todayStr: '2026-04-15',
      adjustments: [],
    });

    expect(result.objectEntries).toEqual([
      expect.objectContaining({ work_date: '2026-04-10', object_id: 'obj-a', hours_worked: 8 }),
    ]);
  });

  it('паритет: согласованная remote-корректировка с часами распределяется по приписке (== день-уровень)', async () => {
    // Удалённый выход в выходной без СКУД: корректировка remote с явными часами и
    // согласованием должна дать те же часы в разрезе «по объектам», что и день-уровень.
    mockedState.tables.employee_skud_object_access = [{ employee_id: 1, skud_object_id: 'obj-a' }];
    mockedState.tables.skud_events = [];

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-06-06',
      endDate: '2026-06-06',
      todayStr: '2026-06-08',
      adjustments: [
        {
          id: 90,
          employee_id: 1,
          work_date: '2026-06-06',
          hours_override: 8,
          source_type: 'manual',
          source_id: 'manual',
          status: 'remote',
          reason: 'Удалённая работа в выходной',
          updated_at: '2026-06-06T10:00:00.000Z',
          approval_status: 'approved',
          metadata: {},
        },
      ],
    });

    expect(result.objectEntries).toEqual([
      expect.objectContaining({
        adjustment_id: 90,
        work_date: '2026-06-06',
        object_id: 'obj-a',
        hours_worked: 8,
        is_correction: true,
      }),
    ]);
  });

  it('remote-корректировка на согласовании (pending) не даёт объектных часов', async () => {
    mockedState.tables.employee_skud_object_access = [{ employee_id: 1, skud_object_id: 'obj-a' }];
    mockedState.tables.skud_events = [];

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-06-06',
      endDate: '2026-06-06',
      todayStr: '2026-06-08',
      adjustments: [
        {
          id: 91,
          employee_id: 1,
          work_date: '2026-06-06',
          hours_override: 8,
          source_type: 'manual',
          source_id: 'manual',
          status: 'remote',
          reason: 'Удалённая работа в выходной',
          updated_at: '2026-06-06T10:00:00.000Z',
          approval_status: 'pending',
          metadata: {},
        },
      ],
    });

    expect(result.objectEntries).toEqual([]);
  });

  it('raw-fallback: break_minutes = сумма гэпов между закрытыми парами (кейс Кальсиной 16.06)', async () => {
    // 5 закрытых пар «Офис», перерывы 10/6/48/6 мин. Сумма пар ≈ 479 мин, перерыв ≈ 71 мин.
    // До фикса fallback не считал break → потребитель вычитал весь час обеда (479−60=419=6ч59м).
    mockedState.tables.skud_events = [
      { employee_id: 1, event_date: '2026-06-16', event_time: '08:21:37', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-06-16', event_time: '08:39:20', access_point: 'КПП A', direction: 'exit' },
      { employee_id: 1, event_date: '2026-06-16', event_time: '08:49:46', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-06-16', event_time: '11:18:09', access_point: 'КПП A', direction: 'exit' },
      { employee_id: 1, event_date: '2026-06-16', event_time: '11:24:08', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-06-16', event_time: '12:59:15', access_point: 'КПП A', direction: 'exit' },
      { employee_id: 1, event_date: '2026-06-16', event_time: '13:47:46', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-06-16', event_time: '16:03:34', access_point: 'КПП A', direction: 'exit' },
      { employee_id: 1, event_date: '2026-06-16', event_time: '16:09:23', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-06-16', event_time: '17:31:42', access_point: 'КПП A', direction: 'exit' },
    ];

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-06-16',
      endDate: '2026-06-16',
      todayStr: '2026-06-17',
      adjustments: [],
    });

    const summary = result.rawFallbackSummaries.get(1)?.get('2026-06-16');
    expect(summary).toBeTruthy();
    expect(summary?.total_minutes).toBe(479);
    expect(summary?.break_minutes).toBe(71);
  });

  it('raw-fallback: незакрытый orphan-вход в прошлом дне НЕ добавляет перерыв', async () => {
    // Гэп начисляется только при закрытии следующей пары (паритет с SQL, миграция 168).
    // Висячий вход 11:00 без выхода не закрывает пару → break = 0, а не 60.
    mockedState.tables.skud_events = [
      { employee_id: 1, event_date: '2026-06-16', event_time: '09:00:00', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-06-16', event_time: '10:00:00', access_point: 'КПП A', direction: 'exit' },
      { employee_id: 1, event_date: '2026-06-16', event_time: '11:00:00', access_point: 'КПП A', direction: 'entry' },
    ];

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-06-16',
      endDate: '2026-06-16',
      todayStr: '2026-06-17',
      adjustments: [],
    });

    const summary = result.rawFallbackSummaries.get(1)?.get('2026-06-16');
    expect(summary?.total_minutes).toBe(60);
    expect(summary?.break_minutes).toBe(0);
  });

  it('raw-fallback: live-сегодня учитывает перерыв перед открытым интервалом', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 16, 12, 0, 0)); // 16 июня 12:00 (локально)

    mockedState.tables.skud_events = [
      { employee_id: 1, event_date: '2026-06-16', event_time: '09:00:00', access_point: 'КПП A', direction: 'entry' },
      { employee_id: 1, event_date: '2026-06-16', event_time: '10:00:00', access_point: 'КПП A', direction: 'exit' },
      { employee_id: 1, event_date: '2026-06-16', event_time: '10:30:00', access_point: 'КПП A', direction: 'entry' },
    ];

    const result = await buildObjectAttendanceData({
      employeeIds: [1],
      startDate: '2026-06-16',
      endDate: '2026-06-16',
      todayStr: '2026-06-16',
      adjustments: [],
    });

    const summary = result.rawFallbackSummaries.get(1)?.get('2026-06-16');
    // total = (10:00−09:00) + (now 12:00 − 10:30) = 60 + 90 = 150 мин
    expect(summary?.total_minutes).toBe(150);
    // перерыв 10:00→10:30 = 30 мин (открытый интервал трактуется как пара)
    expect(summary?.break_minutes).toBe(30);
  });
});

// ───────────────── подбор объекта дня для корректировки ─────────────────
// Резолвер бьёт по трём разным агрегатам, поэтому у него своя маршрутизация SQL:
// общий routeQuery выше отдаёт «сырые» таблицы, а здесь запросы уже сгруппированы
// (object_id + object_name + event_count).
const resolverState = vi.hoisted(() => ({
  sameDayVotes: [] as Array<{ object_id: string; object_name: string; event_count: number }>,
  failureVotes: [] as Array<{ object_id: string; object_name: string; event_count: number }>,
  historyVotes: [] as Array<{ object_id: string; object_name: string; event_count: number }>,
  failureQueryParams: null as unknown[] | null,
}));

function routeResolverQuery(sql: string, params?: unknown[]): unknown[] {
  const s = sql.toLowerCase();
  if (s.includes('skud_event_failures')) {
    resolverState.failureQueryParams = params ?? null;
    return resolverState.failureVotes;
  }
  if (s.includes("interval '90 days'")) return resolverState.historyVotes;
  if (s.includes('skud_events')) return resolverState.sameDayVotes;
  throw new Error(`Unexpected SQL routing: ${sql}`);
}

describe('resolveDayObjectDetailed', () => {
  beforeEach(() => {
    pgQuery.mockReset();
    resolverState.sameDayVotes = [];
    resolverState.failureVotes = [];
    resolverState.historyVotes = [];
    resolverState.failureQueryParams = null;
    pgQuery.mockImplementation(async (sql: string, params?: unknown[]) => routeResolverQuery(sql, params));
  });

  // scheduleType задаём явно: иначе резолвер полезет за графиком (шаг «удалёнщик»),
  // а resolveSchedule в этом файле не замокан.
  const resolve = (overrides: Record<string, unknown> = {}) => resolveDayObjectDetailed({
    employeeId: 1,
    workDate: '2026-08-16',
    scheduleType: 'standard',
    ...overrides,
  });

  it('отказ доступа побеждает 90-дневную историю: кейс Журакулова 16.08', async () => {
    // Проходов в этот день нет, отказы — на ЗилАрте, а в истории лидирует Дом 56
    // (478 событий, последнее месяц назад). Должен победить ЗилАрт.
    resolverState.failureVotes = [{ object_id: 'obj-zil', object_name: 'ЖК Зил 18,19,27', event_count: 2 }];
    resolverState.historyVotes = [{ object_id: 'obj-dom56', object_name: 'ЖК Дом 56', event_count: 478 }];

    expect(await resolve()).toEqual({
      kind: 'resolved',
      object_id: 'obj-zil',
      object_name: 'ЖК Зил 18,19,27',
      source: 'failure_day',
    });
  });

  it('успешный проход приоритетнее отказа', async () => {
    resolverState.sameDayVotes = [{ object_id: 'obj-b', object_name: 'Объект B', event_count: 4 }];
    resolverState.failureVotes = [{ object_id: 'obj-a', object_name: 'Объект A', event_count: 9 }];

    expect(await resolve()).toEqual({
      kind: 'resolved',
      object_id: 'obj-b',
      object_name: 'Объект B',
      source: 'skud_day',
    });
  });

  it('ничья по отказам терминальна: ambiguous, без падения в историю', async () => {
    resolverState.failureVotes = [
      { object_id: 'obj-a', object_name: 'Объект A', event_count: 3 },
      { object_id: 'obj-b', object_name: 'Объект B', event_count: 3 },
    ];
    resolverState.historyVotes = [{ object_id: 'obj-c', object_name: 'Объект C', event_count: 100 }];

    expect(await resolve()).toEqual({
      kind: 'ambiguous',
      candidates: [
        { object_id: 'obj-a', object_name: 'Объект A' },
        { object_id: 'obj-b', object_name: 'Объект B' },
      ],
    });
  });

  it('лидер с отрывом выигрывает, несмотря на второй объект с отказами', async () => {
    resolverState.failureVotes = [
      { object_id: 'obj-a', object_name: 'Объект A', event_count: 5 },
      { object_id: 'obj-b', object_name: 'Объект B', event_count: 1 },
    ];

    expect(await resolve()).toMatchObject({ kind: 'resolved', object_id: 'obj-a', source: 'failure_day' });
  });

  it('запрашивает только типы присутствия человека (whitelist 7 и 24)', async () => {
    await resolve();
    // apOnlineStatus (12) и прочий служебный мусор в выборку попасть не должен:
    // в skud_event_failures пишется всё, кроме PASS_DETECTED.
    expect(resolverState.failureQueryParams?.[2]).toEqual([...PRESENCE_FAILURE_TYPE_IDS]);
  });

  it('нет ни проходов, ни отказов — остаётся история за 90 дней', async () => {
    resolverState.historyVotes = [{ object_id: 'obj-c', object_name: 'Объект C', event_count: 12 }];

    expect(await resolve()).toEqual({
      kind: 'resolved',
      object_id: 'obj-c',
      object_name: 'Объект C',
      source: 'history_90d',
    });
  });

  it('нет вообще никаких сигналов — none', async () => {
    expect(await resolve()).toEqual({ kind: 'none' });
  });

});


describe('object allocations helpers', () => {
  it('мусор в metadata не роняет чтение: возвращается пустой список', () => {
    expect(readObjectAllocations(null)).toEqual([]);
    expect(readObjectAllocations({ object_allocations: 'нет' })).toEqual([]);
    expect(readObjectAllocations({ object_allocations: [{ object_id: '', hours: 5 }] })).toEqual([]);
    expect(readObjectAllocations({ object_allocations: [{ object_id: 'obj-a', hours: 0 }] })).toEqual([]);
    expect(hasObjectAllocations({ object_allocations: [{ object_id: 'obj-a', hours: 3 }] })).toBe(true);
  });

  it('перестановка строк не считается изменением', () => {
    const left = [
      { object_id: 'obj-b', object_name: 'B', hours: 4 },
      { object_id: 'obj-a', object_name: 'A', hours: 7 },
    ];
    const right = [
      { object_id: 'obj-a', object_name: 'Другое имя', hours: 7 },
      { object_id: 'obj-b', object_name: 'B', hours: 4 },
    ];
    expect(allocationsEqual(left, right)).toBe(true);
    expect(canonicalizeAllocations(left).map(item => item.object_id)).toEqual(['obj-a', 'obj-b']);
  });

  it('другие часы — это изменение', () => {
    expect(allocationsEqual(
      [{ object_id: 'obj-a', object_name: 'A', hours: 7 }],
      [{ object_id: 'obj-a', object_name: 'A', hours: 8 }],
    )).toBe(false);
  });
});

// ───────────── подсказка распределения для модалки ─────────────
const suggestionState = vi.hoisted(() => ({
  events: [] as Array<{ event_time: string; direction: string; access_point: string; object_id: string; object_name: string }>,
  failures: [] as Array<{ object_id: string; object_name: string; event_count: number }>,
}));

describe('resolveDayAllocationSuggestion', () => {
  beforeEach(() => {
    pgQuery.mockReset();
    suggestionState.events = [];
    suggestionState.failures = [];
    mockedState.internalPoints = new Set();
    pgQuery.mockImplementation(async (sql: string) => {
      const text = sql.toLowerCase();
      if (text.includes('from skud_events se')) return suggestionState.events;
      if (text.includes('skud_event_failures')) return suggestionState.failures;
      return [];
    });
  });

  const suggest = () => resolveDayAllocationSuggestion({
    employeeId: 1,
    workDate: '2026-09-01',
    scheduleType: 'standard',
  });

  it('кейс Сайфуллаева: один непарный выход — объект предложен, но подтверждение обязательно', async () => {
    suggestionState.events = [
      { event_time: '18:49:53', direction: 'exit', access_point: 'Борисовские пруды', object_id: 'obj-wave', object_name: 'ЖК Wave' },
    ];

    const result = await suggest();

    expect(result.distribution).toEqual([{ object_id: 'obj-wave', object_name: 'ЖК Wave', minutes: 0 }]);
    expect(result.resolution_source).toBe('skud_day_unpaired');
    expect(result.requires_allocation).toBe(true);
    expect(result.ambiguous).toBe(false);
  });

  it('полные пары на двух объектах — распределение по фактическим минутам', async () => {
    suggestionState.events = [
      { event_time: '08:00:00', direction: 'entry', access_point: 'КПП A', object_id: 'obj-a', object_name: 'Объект A' },
      { event_time: '12:00:00', direction: 'exit', access_point: 'КПП A', object_id: 'obj-a', object_name: 'Объект A' },
      { event_time: '13:00:00', direction: 'entry', access_point: 'КПП B', object_id: 'obj-b', object_name: 'Объект B' },
      { event_time: '18:00:00', direction: 'exit', access_point: 'КПП B', object_id: 'obj-b', object_name: 'Объект B' },
    ];

    const result = await suggest();

    expect(result.distribution).toEqual([
      { object_id: 'obj-a', object_name: 'Объект A', minutes: 240 },
      { object_id: 'obj-b', object_name: 'Объект B', minutes: 300 },
    ]);
    expect(result.requires_allocation).toBe(false);
  });

  it('вход на одном объекте, выход на другом — пару не строим, решает человек', async () => {
    suggestionState.events = [
      { event_time: '08:00:00', direction: 'entry', access_point: 'КПП A', object_id: 'obj-a', object_name: 'Объект A' },
      { event_time: '18:00:00', direction: 'exit', access_point: 'КПП B', object_id: 'obj-b', object_name: 'Объект B' },
    ];

    const result = await suggest();

    expect(result.ambiguous).toBe(true);
    expect(result.requires_allocation).toBe(true);
    expect(result.distribution).toEqual([]);
    expect(result.candidates.map(item => item.object_id).sort()).toEqual(['obj-a', 'obj-b']);
  });

  it('успешных событий нет — объект берётся из отказов доступа', async () => {
    suggestionState.failures = [{ object_id: 'obj-wave', object_name: 'ЖК Wave', event_count: 2 }];

    const result = await suggest();

    expect(result.distribution).toEqual([{ object_id: 'obj-wave', object_name: 'ЖК Wave', minutes: 0 }]);
    expect(result.resolution_source).toBe('failure_day');
    expect(result.requires_allocation).toBe(true);
  });
});
