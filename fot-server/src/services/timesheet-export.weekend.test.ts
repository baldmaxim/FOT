import { describe, it, expect, vi, beforeEach } from 'vitest';

// Изолируем чистый критерий includeExportDayHours: мокаем все внешние модули
// timesheet-export.service, оставляя под контролем только isWorkingDay.
const h = vi.hoisted(() => ({ isWorkingDay: vi.fn() }));

vi.mock('../config/postgres.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock('./schedule.service.js', () => ({
  isWorkingDay: h.isWorkingDay,
  loadCalendarMonth: vi.fn(),
  resolveSchedulesForPeriod: vi.fn(),
}));
vi.mock('./attendance.service.js', () => ({ buildAttendanceEntries: vi.fn() }));
vi.mock('./timesheet-mandatory-weekend.service.js', () => ({ computeMandatoryExemptions: vi.fn() }));
vi.mock('./timesheet-department-assignments.service.js', () => ({
  listEmployeeIdsAssignedToDepartmentPeriod: vi.fn(),
  resolveTimesheetDateRange: vi.fn(),
  resolveTimesheetPeriodRange: vi.fn(),
}));

import { includeExportDayHours } from './timesheet-export.service.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const entry = (approval: unknown): any => ({ approval_status: approval, status: 'work' });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sched: any = { work_days: [1, 2, 3, 4, 5] };
const SAT = '2026-05-02'; // суббота
const MON = '2026-05-04'; // понедельник

describe('includeExportDayHours — фильтр выходных для выгрузки', () => {
  beforeEach(() => vi.clearAllMocks());

  it('рабочий день по графику → включаем независимо от согласования', () => {
    h.isWorkingDay.mockReturnValue(true);
    expect(includeExportDayHours(entry('pending'), sched, 1, MON, null, new Set())).toBe(true);
  });

  it('выходной + approved → включаем', () => {
    h.isWorkingDay.mockReturnValue(false);
    expect(includeExportDayHours(entry('approved'), sched, 1, SAT, null, new Set())).toBe(true);
  });

  it('выходной + auto_approved → включаем', () => {
    h.isWorkingDay.mockReturnValue(false);
    expect(includeExportDayHours(entry('auto_approved'), sched, 1, SAT, null, new Set())).toBe(true);
  });

  it('выходной + pending → исключаем (0 часов)', () => {
    h.isWorkingDay.mockReturnValue(false);
    expect(includeExportDayHours(entry('pending'), sched, 1, SAT, null, new Set())).toBe(false);
  });

  it('выходной + rejected → исключаем', () => {
    h.isWorkingDay.mockReturnValue(false);
    expect(includeExportDayHours(entry('rejected'), sched, 1, SAT, null, new Set())).toBe(false);
  });

  it('выходной, сырой СКУД (approval=null) не в exemptions → исключаем', () => {
    h.isWorkingDay.mockReturnValue(false);
    expect(includeExportDayHours(entry(null), sched, 1, SAT, null, new Set())).toBe(false);
  });

  it('выходной, сырой СКУД в exemptions (плановая суббота) → включаем', () => {
    h.isWorkingDay.mockReturnValue(false);
    expect(includeExportDayHours(entry(null), sched, 1, SAT, null, new Set([`1|${SAT}`]))).toBe(true);
  });

  it('exemption другого сотрудника не влияет', () => {
    h.isWorkingDay.mockReturnValue(false);
    expect(includeExportDayHours(entry(null), sched, 1, SAT, null, new Set([`2|${SAT}`]))).toBe(false);
  });

  it('нет графика → не фильтруем (включаем), isWorkingDay не вызывается', () => {
    expect(includeExportDayHours(entry(null), undefined, 1, SAT, null, new Set())).toBe(true);
    expect(h.isWorkingDay).not.toHaveBeenCalled();
  });
});
