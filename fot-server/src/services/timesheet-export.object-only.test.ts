import { beforeEach, describe, expect, it, vi } from 'vitest';

// Контракт экспортного слоя для дней, существующих ТОЛЬКО как объектная корректировка
// (нет прохода СКУД, нет day-level записи). Проверяем две вещи:
//   1) обе fetch-функции просят синтез таких дней и передают отсечку по todayStr;
//   2) синтезированный день проходит фильтр выходных на общих основаниях
//      (includeExportDayHours) и корректно ложится в dataMap.
// Сам синтез покрыт в attendance.service.test.ts — здесь buildAttendanceEntries мокается.

const h = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  assigned: vi.fn(),
  buildAttendance: vi.fn(),
  isWorkingDay: vi.fn(() => false),
  resolveSchedules: vi.fn(),
  mandatoryExemptions: vi.fn(() => new Set<string>()),
}));

vi.mock('../config/postgres.js', () => ({ query: h.pgQuery, queryOne: h.pgQueryOne }));

vi.mock('./schedule.service.js', () => ({
  isWorkingDay: h.isWorkingDay,
  loadCalendarMonth: vi.fn(async () => null),
  resolveSchedulesForPeriod: h.resolveSchedules,
  getScheduleForDate: vi.fn(() => undefined),
  getShiftDurationHours: vi.fn(() => 8),
  isPreHoliday: vi.fn(() => false),
  needsSkudCheck: vi.fn(() => false),
}));

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
  computeMandatoryExemptions: h.mandatoryExemptions,
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
} from './timesheet-export.service.js';

const MONTH = '2026-08';
// 08.08.2026 — суббота, кейс Алесиной: 8 ч объектной правкой, прохода СКУД нет.
const SATURDAY = '2026-08-08';
const EMP_ID = 8926;

const employeeRow = {
  id: EMP_ID,
  full_name: 'Алесина С. М.',
  position_id: null,
  org_department_id: 'D1',
  sigur_employee_id: null,
  employment_status: 'active',
  dismissal_date: null,
  excluded_from_timesheet_date: null,
};

// Запись, синтезированная attendance.service из объектной корректировки:
// своих часов 8, is_correction, hours_overridden, статус согласования от правки.
const synthesizedObjectOnlyEntry = (approvalStatus: string) => ({
  id: 1090038,
  employee_id: EMP_ID,
  work_date: SATURDAY,
  status: 'work',
  hours_worked: 8,
  display_hours_worked: 8,
  base_hours_worked: 8,
  travel_segments_count: 0,
  is_correction: true,
  hours_overridden: true,
  approval_status: approvalStatus,
  first_entry: null,
  last_exit: null,
});

const attendanceResult = (entry: ReturnType<typeof synthesizedObjectOnlyEntry>) => ({
  entries: [entry],
  objectEntries: [{
    employee_id: EMP_ID,
    work_date: SATURDAY,
    hours_worked: 8,
    object_id: 'obj-wave',
    is_correction: true,
  }],
  byEmployeeDate: new Map([[EMP_ID, new Map([[SATURDAY, entry]])]]),
  objectEntriesByEmployeeDate: new Map(),
  skudMap: new Map(),
});

// Личный график 5/2: суббота — выходной, поэтому включается includeExportDayHours.
const scheduleStub = { id: 'sch-1', work_days: [1, 2, 3, 4, 5], work_hours: 8 };

beforeEach(() => {
  vi.clearAllMocks();
  h.isWorkingDay.mockReturnValue(false);
  h.mandatoryExemptions.mockReturnValue(new Set<string>());
  h.pgQueryOne.mockResolvedValue({ name: 'Отдел табельного учёта' });
  h.pgQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM employees')) return [employeeRow];
    // Кандидаты квоты плановых суббот: без строк computeExportWeekendExemptions
    // выходит раньше и до computeMandatoryExemptions не доходит.
    if (sql.includes('FROM skud_daily_summary')) return [{ employee_id: EMP_ID, date: SATURDAY }];
    return [];
  });
  h.assigned.mockResolvedValue([EMP_ID]);
  h.resolveSchedules.mockResolvedValue(
    new Map([[EMP_ID, new Map([[SATURDAY, scheduleStub]])]]),
  );
  h.buildAttendance.mockResolvedValue(attendanceResult(synthesizedObjectOnlyEntry('auto_approved')));
});

const dayOf = (data: { dataMap: Map<number, Map<string, unknown>> }) =>
  data.dataMap.get(EMP_ID)?.get(SATURDAY) as {
    status: string; hours: number; corrected?: boolean;
    hoursOverridden?: boolean; hoursDropped?: boolean;
  } | undefined;

describe('экспорт просит синтез object-only дней с отсечкой по сегодняшнему дню', () => {
  it('fetchTimesheetDataForDepartment передаёт флаг и отсечку', async () => {
    await fetchTimesheetDataForDepartment(MONTH, 'D1');
    const params = h.buildAttendance.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.synthesizeObjectOnlyDays).toBe(true);
    expect(params.synthesizeObjectOnlyDaysUpTo).toBe(params.todayStr);
    expect(typeof params.synthesizeObjectOnlyDaysUpTo).toBe('string');
  });

  it('fetchTimesheetDataForEmployees передаёт флаг и отсечку', async () => {
    await fetchTimesheetDataForEmployees(MONTH, [EMP_ID], 'Сводный 1С');
    const params = h.buildAttendance.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.synthesizeObjectOnlyDays).toBe(true);
    expect(params.synthesizeObjectOnlyDaysUpTo).toBe(params.todayStr);
  });
});

describe('object-only день в dataMap проходит фильтр выходных', () => {
  it('согласованная объектная правка в субботу → часы сохраняются', async () => {
    const data = await fetchTimesheetDataForEmployees(MONTH, [EMP_ID], 'Сводный 1С');
    expect(dayOf(data)).toMatchObject({
      status: 'work',
      hours: 8,
      corrected: true,
      hoursOverridden: true,
      hoursDropped: false,
    });
  });

  it('несогласованная (pending) правка в субботу → часы обнуляются и помечаются', async () => {
    h.buildAttendance.mockResolvedValue(attendanceResult(synthesizedObjectOnlyEntry('pending')));
    const data = await fetchTimesheetDataForEmployees(MONTH, [EMP_ID], 'Сводный 1С');
    expect(dayOf(data)).toMatchObject({ hours: 0, hoursDropped: true, corrected: true });
  });

  it('отклонённая (rejected) правка в субботу → часы обнуляются', async () => {
    h.buildAttendance.mockResolvedValue(attendanceResult(synthesizedObjectOnlyEntry('rejected')));
    const data = await fetchTimesheetDataForEmployees(MONTH, [EMP_ID], 'Сводный 1С');
    expect(dayOf(data)).toMatchObject({ hours: 0, hoursDropped: true });
  });

  it('несогласованная правка, но суббота плановая по квоте графика → часы сохраняются', async () => {
    h.buildAttendance.mockResolvedValue(attendanceResult(synthesizedObjectOnlyEntry('pending')));
    h.mandatoryExemptions.mockReturnValue(new Set([`${EMP_ID}|${SATURDAY}`]));
    const data = await fetchTimesheetDataForEmployees(MONTH, [EMP_ID], 'Сводный 1С');
    expect(dayOf(data)).toMatchObject({ hours: 8, hoursDropped: false });
  });

  it('рабочий день по личному графику фильтром не трогается даже без согласования', async () => {
    h.isWorkingDay.mockReturnValue(true);
    h.buildAttendance.mockResolvedValue(attendanceResult(synthesizedObjectOnlyEntry('pending')));
    const data = await fetchTimesheetDataForEmployees(MONTH, [EMP_ID], 'Сводный 1С');
    expect(dayOf(data)).toMatchObject({ hours: 8, hoursDropped: false });
  });
});
