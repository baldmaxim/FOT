import { beforeEach, describe, expect, it, vi } from 'vitest';

// Настоящие fetchTimesheetDataForDepartment / fetchTimesheetDataForEmployees /
// sliceTimesheetDataByEmployees + настоящий hasRealActivity; мокается только
// тяжёлое окружение (БД, графики, buildAttendanceEntries).

const h = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  assigned: vi.fn(),
  buildAttendance: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({ query: h.pgQuery, queryOne: h.pgQueryOne }));

vi.mock('./schedule.service.js', () => ({
  isWorkingDay: vi.fn(() => false),
  loadCalendarMonth: vi.fn(async () => null),
  resolveSchedulesForPeriod: vi.fn(async () => new Map()),
  getScheduleForDate: vi.fn(() => undefined),
  getShiftDurationHours: vi.fn(() => 9),
  isPreHoliday: vi.fn(() => false),
  needsSkudCheck: vi.fn(() => false),
}));

// attendance.service — настоящий (hasRealActivity — часть проверяемой логики).
vi.mock('./attendance.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./attendance.service.js')>()),
  buildAttendanceEntries: h.buildAttendance,
}));
vi.mock('./skud-travel.service.js', () => ({
  getTravelHoursSummaryForRange: vi.fn(async () => new Map()),
}));
vi.mock('./timesheet-object.service.js', () => ({
  buildObjectAttendanceData: vi.fn(),
  isMigratedDayLevelAdjustment: vi.fn(() => false),
  OBJECT_ADJUSTMENT_SOURCE_TYPE: 'manual_object',
}));

vi.mock('./timesheet-mandatory-weekend.service.js', () => ({
  computeMandatoryExemptions: vi.fn(() => new Set()),
}));

vi.mock('./timesheet-department-assignments.service.js', () => ({
  listEmployeeIdsAssignedToDepartmentPeriod: h.assigned,
  resolveTimesheetDateRange: vi.fn(),
  resolveTimesheetPeriodRange: vi.fn((month: string) => {
    const [y, m] = month.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    return {
      year: y,
      month: m,
      daysInMonth,
      startDate: `${month}-01`,
      endDate: `${month}-${String(daysInMonth).padStart(2, '0')}`,
    };
  }),
}));

import {
  fetchTimesheetDataForDepartment,
  fetchTimesheetDataForEmployees,
  sliceTimesheetDataByEmployees,
} from './timesheet-export.service.js';

const MONTH = '2026-07';

const employeeRow = (id: number, name: string) => ({
  id,
  full_name: name,
  position_id: null,
  org_department_id: null,
  sigur_employee_id: null,
  employment_status: 'active',
  dismissal_date: null,
  excluded_from_timesheet_date: null,
});

const ALL_ROWS = [
  employeeRow(1, 'СКУД С.'),
  employeeRow(2, 'Отпускник О.'),
  employeeRow(3, 'Объектный О.'),
  employeeRow(4, 'Пустой П.'),
  employeeRow(5, 'Начальник Н.'),
];

// СКУД-присутствие / отпуск (adjustment, id != null) / синтетическая заглушка.
const skudEntry = (employeeId: number) => ({
  id: null,
  employee_id: employeeId,
  work_date: `${MONTH}-01`,
  status: 'work',
  hours_worked: 8,
  display_hours_worked: 8,
  base_hours_worked: 8,
  travel_segments_count: 0,
  is_correction: false,
  first_entry: '08:00:00',
  last_exit: '17:00:00',
});
const vacationEntry = (employeeId: number) => ({
  id: 77,
  employee_id: employeeId,
  work_date: `${MONTH}-01`,
  status: 'vacation',
  hours_worked: 0,
  display_hours_worked: 0,
  base_hours_worked: 0,
  travel_segments_count: 0,
  is_correction: false,
  first_entry: null,
  last_exit: null,
});
const emptyStubEntry = (employeeId: number) => ({
  id: null,
  employee_id: employeeId,
  work_date: `${MONTH}-01`,
  status: 'absent',
  hours_worked: 0,
  display_hours_worked: 0,
  base_hours_worked: 0,
  travel_segments_count: 0,
  is_correction: false,
  first_entry: null,
  last_exit: null,
});

const attendanceResult = (
  entries: unknown[],
  objectEntries: unknown[] = [],
) => ({
  entries,
  objectEntries,
  byEmployeeDate: new Map(),
  objectEntriesByEmployeeDate: new Map(),
  skudMap: new Map(),
});

beforeEach(() => {
  vi.clearAllMocks();
  h.pgQueryOne.mockResolvedValue({ name: 'бр. Тестовая' });
  h.pgQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM employees')) {
      const ids = new Set((params?.[0] as number[]) ?? []);
      return ALL_ROWS.filter(r => ids.has(r.id));
    }
    return [];
  });
  h.assigned.mockResolvedValue([1, 2, 3, 4, 5]);
  // emp1 — СКУД; emp2 — только отпуск; emp3 — только объектная корректировка
  // (в entries лишь заглушка, сигнал — в objectEntries); emp4 — «пустой»;
  // emp5 — начальник участка, записей нет вовсе.
  h.buildAttendance.mockResolvedValue(attendanceResult(
    [skudEntry(1), vacationEntry(2), emptyStubEntry(3), emptyStubEntry(4)],
    [{ employee_id: 3, work_date: `${MONTH}-02`, hours_worked: 4, object_id: 'obj-1' }],
  ));
});

const employeeIdsOf = (data: { employees: Array<{ id: number }> }): number[] =>
  data.employees.map(e => e.id).sort((a, b) => a - b);

describe('fetchTimesheetDataForDepartment — excludeZeroActivity (1С-выгрузки)', () => {
  it('без options состав полный (поведение не меняется)', async () => {
    const data = await fetchTimesheetDataForDepartment(MONTH, 'D1');
    expect(employeeIdsOf(data)).toEqual([1, 2, 3, 4, 5]);
  });

  it('«пустой» выпадает; СКУД, отпуск, объектная корректировка и exempt-начальник остаются', async () => {
    const data = await fetchTimesheetDataForDepartment(MONTH, 'D1', 'FULL', 'actual', false, {
      excludeZeroActivity: true,
      exemptEmployeeIds: new Set([5]),
    });
    expect(employeeIdsOf(data)).toEqual([1, 2, 3, 5]);
    // Производные структуры срезаны той же нарезкой.
    expect(data.entries.some(e => e.employee_id === 4)).toBe(false);
    expect(data.objectEntries.some(e => e.employee_id === 3)).toBe(true);
  });

  it('начальник участка без активности НЕ exempt → выпадает (exempt не расширяет ростер, а сохраняет)', async () => {
    const data = await fetchTimesheetDataForDepartment(MONTH, 'D1', 'FULL', 'actual', false, {
      excludeZeroActivity: true,
    });
    expect(employeeIdsOf(data)).toEqual([1, 2, 3]);
  });

  it('полностью пустой отдел → пустой состав без ошибок', async () => {
    h.assigned.mockResolvedValue([4]);
    h.buildAttendance.mockResolvedValue(attendanceResult([emptyStubEntry(4)]));
    const data = await fetchTimesheetDataForDepartment(MONTH, 'D1', 'FULL', 'actual', false, {
      excludeZeroActivity: true,
    });
    expect(data.employees).toEqual([]);
    expect(data.entries).toEqual([]);
  });
});

describe('fetchTimesheetDataForEmployees (bulk unified) + нарезка по отделам', () => {
  it('неактивный начальник из exemptEmployeeIds переживает bulk-фильтр и попадает в срез своей бригады', async () => {
    h.buildAttendance.mockResolvedValue(attendanceResult(
      [skudEntry(1), emptyStubEntry(4)],
    ));
    const bulk = await fetchTimesheetDataForEmployees(
      MONTH, [1, 4, 5], 'Сводный 1С', 'FULL', 'actual', true,
      { excludeZeroActivity: true, exemptEmployeeIds: new Set([5]) },
    );
    // emp4 (пустой) исключён ещё в bulk, начальник 5 сохранён.
    expect(employeeIdsOf(bulk)).toEqual([1, 5]);

    const sliceA = sliceTimesheetDataByEmployees(bulk, [4, 5], 'бр. А', 'dept-a');
    expect(employeeIdsOf(sliceA)).toEqual([5]);

    const sliceB = sliceTimesheetDataByEmployees(bulk, [1], 'Отдел Б', 'dept-b');
    expect(employeeIdsOf(sliceB)).toEqual([1]);
  });

  it('все выбранные отделы пустые → пустой bulk и пустые срезы (unified-файл без строк)', async () => {
    h.buildAttendance.mockResolvedValue(attendanceResult([emptyStubEntry(4)]));
    const bulk = await fetchTimesheetDataForEmployees(
      MONTH, [4], 'Сводный 1С', 'FULL', 'actual', true,
      { excludeZeroActivity: true },
    );
    expect(bulk.employees).toEqual([]);

    const slice = sliceTimesheetDataByEmployees(bulk, [4], 'бр. А', 'dept-a');
    expect(slice.employees).toEqual([]);
    expect(slice.entries).toEqual([]);
  });
});
