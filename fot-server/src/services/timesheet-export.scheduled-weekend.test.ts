import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IProductionCalendarMonth, IResolvedSchedule } from '../types/index.js';

// Настоящие fetchTimesheetData*, квота, нарезка и построитель строк 1С; мокаются БД, сборка табеля и график сотрудника.
const h = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  assigned: vi.fn(),
  buildAttendance: vi.fn(),
  resolveSchedules: vi.fn(),
  loadCalendar: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({ query: h.pgQuery, queryOne: h.pgQueryOne }));
vi.mock('./schedule.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./schedule.service.js')>()),
  resolveSchedulesForPeriod: h.resolveSchedules,
  loadCalendarMonth: h.loadCalendar,
}));
vi.mock('./attendance.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./attendance.service.js')>()),
  buildAttendanceEntries: h.buildAttendance,
}));
vi.mock('./timesheet-department-assignments.service.js', () => ({
  listEmployeeIdsAssignedToDepartmentPeriod: h.assigned,
  resolveTimesheetDateRange: vi.fn(),
  resolveTimesheetPeriodRange: vi.fn((month: string, half: string) => {
    const [year, mon] = month.split('-').map(Number);
    const daysInMonth = new Date(year, mon, 0).getDate();
    return {
      year,
      month: mon,
      daysInMonth,
      startDate: `${month}-${half === 'H2' ? '16' : '01'}`,
      endDate: `${month}-${half === 'H1' ? '15' : String(daysInMonth)}`,
    };
  }),
}));

import {
  fetchTimesheetDataForDepartment,
  fetchTimesheetDataForEmployees,
  sliceTimesheetDataByEmployees,
  type IDepartmentTimesheetData,
} from './timesheet-export.service.js';
import { buildEmployeeRowsForOneC, buildObjectRowsForOneC } from './timesheet-excel.service.js';

const MONTH = '2026-09';

// График как на проде: цикл 5+2 на 10 ч, квота 2 субботы.
const QUOTA_SCHEDULE: IResolvedSchedule = {
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
  expected_saturdays_per_month: 2,
  expected_sundays_per_month: 0,
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
};

const CALENDAR: IProductionCalendarMonth = {
  year: 2026,
  month: 9,
  norm_days: 22,
  norm_hours: 176,
  holidays: [],
  mandatory_holidays: [],
  pre_holidays: [],
};

interface IDay {
  date: string;
  hours: number;
  approval?: 'approved' | 'auto_approved' | 'pending' | 'rejected' | null;
  status?: string;
  overridden?: boolean;
}

const attendanceOf = (employeeId: number, days: IDay[], objectEntries: unknown[] = []) => {
  const entries = days.map(day => ({
    id: day.approval ? 1 : null,
    employee_id: employeeId,
    work_date: day.date,
    status: day.status ?? 'work',
    hours_worked: day.hours,
    display_hours_worked: day.hours,
    base_hours_worked: day.hours,
    travel_segments_count: 0,
    is_correction: Boolean(day.approval),
    hours_overridden: Boolean(day.overridden),
    approval_status: day.approval ?? null,
    first_entry: '08:00:00',
    last_exit: '20:00:00',
  }));
  return {
    entries,
    objectEntries,
    byEmployeeDate: new Map([[employeeId, new Map(entries.map(entry => [entry.work_date, entry]))]]),
    objectEntriesByEmployeeDate: new Map(),
    skudMap: new Map(),
  };
};

const objectEntry = (date: string, objectKey: string, hours: number) => ({
  adjustment_id: null,
  employee_id: 1,
  work_date: date,
  object_key: objectKey,
  object_id: objectKey,
  object_name: objectKey,
  hours_worked: hours,
  display_hours_worked: hours,
  base_hours_worked: hours,
  is_correction: false,
});

// Ответы БД: сырые выходы СКУД и строки корректировок задают плановые субботы.
const dbRows = (skudDates: string[], adjustedDates: string[]) => async (sql: string): Promise<unknown[]> => {
  if (sql.includes('FROM employees')) {
    return [{
      id: 1,
      full_name: 'Квотный К.',
      position_id: null,
      org_department_id: null,
      sigur_employee_id: null,
      employment_status: 'active',
      dismissal_date: null,
      excluded_from_timesheet_date: null,
    }];
  }
  if (sql.includes('FROM skud_daily_summary')) return skudDates.map(date => ({ employee_id: 1, date }));
  if (sql.includes('FROM attendance_adjustments')) return adjustedDates.map(work_date => ({ employee_id: 1, work_date }));
  return [];
};

const scheduleFor = async (employees: Array<{ id: number }>, startDate: string, endDate: string) => {
  const daily = new Map<string, IResolvedSchedule>();
  const lastDay = Number(endDate.slice(-2));
  for (let day = Number(startDate.slice(-2)); day <= lastDay; day++) {
    daily.set(`${MONTH}-${String(day).padStart(2, '0')}`, QUOTA_SCHEDULE);
  }
  return new Map(employees.map(employee => [employee.id, daily]));
};

const useDb = (skudDates: string[], adjustedDates: string[]): void => {
  h.pgQuery.mockImplementation(dbRows(skudDates, adjustedDates));
};

const dayHours = (data: IDepartmentTimesheetData, day: number): number | undefined => (
  buildEmployeeRowsForOneC(data)[0].dayValues.get(day)?.hours
);

beforeEach(() => {
  vi.clearAllMocks();
  h.pgQueryOne.mockResolvedValue({ name: 'Отдел' });
  h.assigned.mockResolvedValue([1]);
  h.loadCalendar.mockResolvedValue(CALENDAR);
  h.resolveSchedules.mockImplementation(scheduleFor);
});

// Оба способа загрузки обязаны заполнять наборы одинаково.
const FETCHERS: Array<[string, () => Promise<IDepartmentTimesheetData>]> = [
  ['fetchTimesheetDataForEmployees', () => fetchTimesheetDataForEmployees(MONTH, [1], 'Сводный 1С', 'FULL', 'actual', true)],
  ['fetchTimesheetDataForDepartment', () => fetchTimesheetDataForDepartment(MONTH, 'D1', 'FULL', 'actual', true)],
];

describe.each(FETCHERS)('%s — выходные в квоте графика', (_name, fetchData) => {
  it('сырая суббота в квоте → до графика; часы в dataMap те же (API и версии не меняются)', async () => {
    useDb(['2026-09-05'], []);
    h.buildAttendance.mockResolvedValue(attendanceOf(1, [{ date: '2026-09-05', hours: 16.45 }]));

    const data = await fetchData();

    expect(data.scheduledWeekendDays?.has('1|2026-09-05')).toBe(true);
    expect(data.dataMap.get(1)?.get('2026-09-05')?.hours).toBe(16.45);
    expect(dayHours(data, 5)).toBe(10);
  });

  it('согласованная суббота на свободном месте режется, сверх квоты — факт', async () => {
    useDb(['2026-09-05', '2026-09-12', '2026-09-19'], ['2026-09-12', '2026-09-19']);
    h.buildAttendance.mockResolvedValue(attendanceOf(1, [
      { date: '2026-09-05', hours: 12.2 },
      { date: '2026-09-12', hours: 12.3, approval: 'auto_approved' },
      { date: '2026-09-19', hours: 12.4, approval: 'approved' },
    ]));

    const data = await fetchData();

    expect(dayHours(data, 5)).toBe(10);
    expect(dayHours(data, 12)).toBe(10);
    expect(dayHours(data, 19)).toBe(12);
    // Плановые субботы этой правкой не расширяются: на них держатся листок и основа «Зарплаты».
    expect([...(data.plannedWeekendDays ?? [])]).toEqual(['1|2026-09-05']);
  });

  it('заявка без факта не занимает место настоящей субботы', async () => {
    useDb(['2026-09-12'], ['2026-09-05', '2026-09-12', '2026-09-19']);
    h.buildAttendance.mockResolvedValue(attendanceOf(1, [
      { date: '2026-09-05', hours: 0, approval: 'approved' },
      { date: '2026-09-12', hours: 12.3, approval: 'approved' },
      { date: '2026-09-19', hours: 12.4, approval: 'approved' },
    ]));

    const data = await fetchData();

    expect(data.scheduledWeekendDays?.has('1|2026-09-05')).toBe(false);
    expect(dayHours(data, 12)).toBe(10);
    expect(dayHours(data, 19)).toBe(10);
  });

  it('pending и rejected квоту не занимают и часов не получают', async () => {
    useDb(['2026-09-05', '2026-09-12'], ['2026-09-05', '2026-09-12']);
    h.buildAttendance.mockResolvedValue(attendanceOf(1, [
      { date: '2026-09-05', hours: 12, approval: 'pending' },
      { date: '2026-09-12', hours: 12, approval: 'rejected' },
    ]));

    const data = await fetchData();

    expect(data.scheduledWeekendDays?.size).toBe(0);
    expect(dayHours(data, 5) ?? 0).toBe(0);
  });

  it('воскресенье при квоте на субботы остаётся фактом и не занимает её', async () => {
    useDb(['2026-09-06', '2026-09-12'], ['2026-09-06', '2026-09-12']);
    h.buildAttendance.mockResolvedValue(attendanceOf(1, [
      { date: '2026-09-06', hours: 12.1, approval: 'approved' },
      { date: '2026-09-12', hours: 12.3, approval: 'approved' },
    ]));

    const data = await fetchData();

    expect(dayHours(data, 6)).toBe(12);
    expect(dayHours(data, 12)).toBe(10);
  });

  it('ручная правка занимает место, но часы не режутся', async () => {
    useDb([], ['2026-09-05', '2026-09-12', '2026-09-19']);
    h.buildAttendance.mockResolvedValue(attendanceOf(1, [
      { date: '2026-09-05', hours: 11, approval: 'auto_approved', status: 'manual', overridden: true },
      { date: '2026-09-12', hours: 11, approval: 'auto_approved', status: 'manual', overridden: true },
      { date: '2026-09-19', hours: 12.4, approval: 'approved' },
    ]));

    const data = await fetchData();

    expect(dayHours(data, 5)).toBe(11);
    expect(dayHours(data, 12)).toBe(11);
    expect(dayHours(data, 19)).toBe(12);
  });

  it('несколько объектов: лимиты посчитаны, нарезка их сохраняет', async () => {
    useDb(['2026-09-05'], []);
    h.buildAttendance.mockResolvedValue(attendanceOf(1, [{ date: '2026-09-05', hours: 13 }], [
      objectEntry('2026-09-05', 'obj-a', 6),
      objectEntry('2026-09-05', 'obj-b', 7),
    ]));

    const data = await fetchData();
    const slice = sliceTimesheetDataByEmployees(data, [1], 'Отдел А', 'dept-a');

    expect(slice.scheduledWeekendObjectLimits?.get('1|2026-09-05|obj-a')).toBe(5);
    expect(slice.scheduledWeekendObjectLimits?.get('1|2026-09-05|obj-b')).toBe(5);
    expect(buildObjectRowsForOneC(slice, { object_key: 'obj-b', object_id: 'obj-b', object_name: 'obj-b' })[0].totalHours).toBe(5);
    // Файл по одному объекту: чужие объектные записи отфильтрованы, доля та же.
    const onlyB = { ...slice, objectEntries: slice.objectEntries.filter(entry => entry.object_key === 'obj-b') };
    expect(buildObjectRowsForOneC(onlyB, { object_key: 'obj-b', object_id: 'obj-b', object_name: 'obj-b' })[0].totalHours).toBe(5);
  });

  it('несколько объектов с ручной правкой не делятся', async () => {
    useDb([], ['2026-09-05']);
    h.buildAttendance.mockResolvedValue(attendanceOf(1, [
      { date: '2026-09-05', hours: 13, approval: 'approved', status: 'manual', overridden: true },
    ], [
      objectEntry('2026-09-05', 'obj-a', 6),
      objectEntry('2026-09-05', 'obj-b', 7),
    ]));

    const data = await fetchData();

    expect(data.scheduledWeekendObjectLimits?.size).toBe(0);
  });

  it('полный месяц: табель второй раз не собирается', async () => {
    useDb(['2026-09-05'], ['2026-09-12']);
    h.buildAttendance.mockResolvedValue(attendanceOf(1, [
      { date: '2026-09-05', hours: 12 },
      { date: '2026-09-12', hours: 12, approval: 'approved' },
    ]));

    await fetchData();

    expect(h.buildAttendance).toHaveBeenCalledTimes(1);
  });
});

describe('праздник без вычета обеда: лимиты объектов', () => {
  const NOVEMBER = '2026-11';
  const HOLIDAY_SATURDAY = '2026-11-07';

  const useNovember = (holidays: string[]): void => {
    h.loadCalendar.mockResolvedValue({ ...CALENDAR, month: 11, holidays });
    h.resolveSchedules.mockImplementation(async (employees: Array<{ id: number }>) => {
      const daily = new Map<string, IResolvedSchedule>();
      for (let day = 1; day <= 30; day++) {
        daily.set(`${NOVEMBER}-${String(day).padStart(2, '0')}`, { ...QUOTA_SCHEDULE, respects_holidays: false });
      }
      return new Map(employees.map(employee => [employee.id, daily]));
    });
    useDb([HOLIDAY_SATURDAY], []);
    h.buildAttendance.mockResolvedValue(attendanceOf(1, [{ date: HOLIDAY_SATURDAY, hours: 13 }], [
      objectEntry(HOLIDAY_SATURDAY, 'obj-a', 6),
      objectEntry(HOLIDAY_SATURDAY, 'obj-b', 7),
    ]));
  };

  const limitsTotal = (data: IDepartmentTimesheetData): number => (
    (data.scheduledWeekendObjectLimits?.get(`1|${HOLIDAY_SATURDAY}|obj-a`) ?? 0)
    + (data.scheduledWeekendObjectLimits?.get(`1|${HOLIDAY_SATURDAY}|obj-b`) ?? 0)
  );

  it('в праздник сумма лимитов — смена с обедом', async () => {
    useNovember([HOLIDAY_SATURDAY]);
    const data = await fetchTimesheetDataForEmployees(NOVEMBER, [1], 'Сводный 1С', 'FULL', 'actual', true);
    expect(limitsTotal(data)).toBe(11);
  });

  it('в обычную субботу сумма лимитов — смена', async () => {
    useNovember([]);
    const data = await fetchTimesheetDataForEmployees(NOVEMBER, [1], 'Сводный 1С', 'FULL', 'actual', true);
    expect(limitsTotal(data)).toBe(10);
  });
});

describe('выгрузка части месяца — квота считается по всему месяцу', () => {
  const MONTH_DAYS: IDay[] = [
    { date: '2026-09-05', hours: 12.2, approval: 'auto_approved' },
    { date: '2026-09-12', hours: 12.3, approval: 'auto_approved' },
    { date: '2026-09-19', hours: 12.4, approval: 'approved' },
  ];

  // Первая сборка — период выгрузки, вторая — весь месяц.
  const mockPeriodThenMonth = (periodDays: IDay[]): void => {
    h.buildAttendance
      .mockResolvedValueOnce(attendanceOf(1, periodDays))
      .mockResolvedValueOnce(attendanceOf(1, MONTH_DAYS));
  };

  it('третья суббота во второй половине остаётся фактом: первые две заняли квоту в первой', async () => {
    useDb([], ['2026-09-05', '2026-09-12', '2026-09-19']);
    mockPeriodThenMonth([{ date: '2026-09-19', hours: 12.4, approval: 'approved' }]);

    const data = await fetchTimesheetDataForEmployees(MONTH, [1], 'Сводный 1С', 'H2', 'actual', true);

    expect(data.scheduledWeekendDays?.has('1|2026-09-19')).toBe(false);
    expect(dayHours(data, 19)).toBe(12);
  });

  it('те же дни в первой половине режутся', async () => {
    useDb([], ['2026-09-05', '2026-09-12', '2026-09-19']);
    mockPeriodThenMonth(MONTH_DAYS.slice(0, 2));

    const data = await fetchTimesheetDataForDepartment(MONTH, 'D1', 'H1', 'actual', true);

    expect(dayHours(data, 5)).toBe(10);
    expect(dayHours(data, 12)).toBe(10);
  });

  it('все новые чтения идут через переданный exec, за весь месяц и только по нужным людям', async () => {
    const execQuery = vi.fn(async (sql: string) => ({
      rows: await dbRows([], ['2026-09-05', '2026-09-12', '2026-09-19'])(sql),
    }));
    const exec = { query: execQuery } as never;
    mockPeriodThenMonth([{ date: '2026-09-19', hours: 12.4, approval: 'approved' }]);

    await fetchTimesheetDataForEmployees(MONTH, [1], 'Версия табеля', 'H2', 'actual', true, { exec });

    expect(h.resolveSchedules).toHaveBeenLastCalledWith([{ id: 1 }], '2026-09-01', '2026-09-30', exec);
    const monthCall = h.buildAttendance.mock.calls[1][0];
    expect(monthCall).toMatchObject({
      startDate: '2026-09-01',
      endDate: '2026-09-30',
      persistTravelSegments: false,
      synthesizeObjectOnlyDays: true,
    });
    expect(monthCall.exec).toBe(exec);
    expect(h.pgQuery).not.toHaveBeenCalled();
  });

  it('нет согласованных выходов в периоде → табель за месяц не собирается', async () => {
    useDb(['2026-09-19'], []);
    h.buildAttendance.mockResolvedValue(attendanceOf(1, [{ date: '2026-09-19', hours: 12.4 }]));

    await fetchTimesheetDataForEmployees(MONTH, [1], 'Сводный 1С', 'H2', 'actual', true);

    expect(h.buildAttendance).toHaveBeenCalledTimes(1);
  });
});

// Полный путь: includeExportDayHours → dataMap → buildObjectRowsForOneC.
describe('строка по объекту следует правилу выходных с 01.10.2026', () => {
  const OBJECT = { object_key: 'obj-a', object_id: 'obj-a', object_name: 'obj-a' };

  const scheduleOfMonth = (month: string, schedule: IResolvedSchedule | null) => async (
    employees: Array<{ id: number }>,
    startDate: string,
    endDate: string,
  ) => {
    const daily = new Map<string, IResolvedSchedule>();
    if (schedule) {
      for (let day = Number(startDate.slice(-2)); day <= Number(endDate.slice(-2)); day++) {
        daily.set(`${month}-${String(day).padStart(2, '0')}`, schedule);
      }
    }
    return new Map(employees.map(employee => [employee.id, daily]));
  };

  const loadMonth = async (
    month: string,
    days: IDay[],
    adjustedDates: string[] = [],
    schedule: IResolvedSchedule | null = QUOTA_SCHEDULE,
  ): Promise<IDepartmentTimesheetData> => {
    h.resolveSchedules.mockImplementation(scheduleOfMonth(month, schedule));
    useDb(days.filter(day => !day.approval).map(day => day.date), adjustedDates);
    h.buildAttendance.mockResolvedValue(
      attendanceOf(1, days, days.map(day => objectEntry(day.date, 'obj-a', day.hours))),
    );
    return fetchTimesheetDataForEmployees(month, [1], 'Сводный 1С', 'FULL', 'actual', true);
  };

  const objectRow = (data: IDepartmentTimesheetData) => buildObjectRowsForOneC(data, OBJECT)[0];

  it('обязательные субботы остаются, суббота сверх квоты и воскресенье без корректировки обнуляются', async () => {
    const row = objectRow(await loadMonth('2026-10', [
      { date: '2026-10-03', hours: 10.2 },
      { date: '2026-10-05', hours: 10.7 },
      { date: '2026-10-10', hours: 9.7 },
      { date: '2026-10-11', hours: 10.6 },
      { date: '2026-10-17', hours: 10.2 },
      { date: '2026-10-25', hours: 10.3 },
    ]));

    expect(row.dayValues.get(3)?.hours).toBe(10);
    expect(row.dayValues.get(5)?.hours).toBe(10);
    expect(row.dayValues.get(10)?.hours).toBe(10);
    for (const day of [11, 17, 25]) {
      expect(row.dayValues.get(day)).toEqual({ hours: 0, isUnderwork: false, isWeekend: true });
    }
    expect(row.totalHours).toBe(30);
    expect(row.workedDays).toBe(3);
  });

  it('выход approved и auto_approved остаётся, pending обнуляется', async () => {
    const row = objectRow(await loadMonth('2026-10', [
      { date: '2026-10-03', hours: 10 },
      { date: '2026-10-10', hours: 10 },
      { date: '2026-10-11', hours: 9, approval: 'approved' },
      { date: '2026-10-17', hours: 12, approval: 'auto_approved' },
      { date: '2026-10-24', hours: 12, approval: 'approved' },
      { date: '2026-10-31', hours: 12, approval: 'pending' },
    ], ['2026-10-11', '2026-10-17', '2026-10-24', '2026-10-31']));

    expect(row.dayValues.get(11)?.hours).toBe(9);
    expect(row.dayValues.get(17)?.hours).toBe(12);
    expect(row.dayValues.get(24)?.hours).toBe(12);
    expect(row.dayValues.get(31)?.hours ?? 0).toBe(0);
    expect(row.totalHours).toBe(53);
  });

  it('графика нет, выходной определить нельзя: часы остаются', async () => {
    const row = objectRow(await loadMonth('2026-10', [{ date: '2026-10-11', hours: 9.6 }], [], null));

    expect(row.dayValues.get(11)?.hours).toBe(10);
    expect(row.hasFilteredWeekendHours).toBe(false);
  });

  it('будний нерабочий день по сменному графику обнуляется, рабочий остаётся', async () => {
    // Цикл с началом в пятницу: среда и четверг нерабочие.
    const shift: IResolvedSchedule = { ...QUOTA_SCHEDULE, expected_saturdays_per_month: 0, anchor_date: '2026-05-01' };

    const row = objectRow(await loadMonth('2026-10', [
      { date: '2026-10-08', hours: 10.5 },
      { date: '2026-10-09', hours: 10.5 },
    ], [], shift));

    expect(row.dayValues.get(8)?.hours ?? 0).toBe(0);
    expect(row.dayValues.get(9)?.hours).toBe(10);
    expect(row.totalHours).toBe(10);
  });

  it('сентябрь: лишний выходной остаётся в строке по объекту, в общей строке ноль, как раньше', async () => {
    const data = await loadMonth(MONTH, [{ date: '2026-09-13', hours: 9.6 }]);

    expect(objectRow(data).dayValues.get(13)?.hours).toBe(10);
    expect(dayHours(data, 13) ?? 0).toBe(0);
  });
});
