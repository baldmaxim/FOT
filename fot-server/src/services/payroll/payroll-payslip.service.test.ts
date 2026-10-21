import { describe, expect, it, vi } from 'vitest';

import type { IResolvedSchedule } from '../../types/index.js';
import type { IDepartmentTimesheetData, IExportDayValue } from '../timesheet-export.service.js';

vi.mock('../../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

import { payslipPeriod, splitWorkedDays } from './payroll-payslip.service.js';

// «5+2» с двумя плановыми субботами в месяц — как у прорабов в июле 2026.
const schedule: IResolvedSchedule = {
  schedule_id: 'sched-1',
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
  expected_saturdays_per_month: 2,
  expected_sundays_per_month: 0,
  full_day_threshold_minutes: null,
  weekend_full_day_threshold_minutes: null,
  cycle_length: null,
  cycle_days: null,
  anchor_date: null,
  assignment_anchor_date: null,
  source: 'default',
};

const julyDates = Array.from({ length: 31 }, (_, i) => `2026-07-${String(i + 1).padStart(2, '0')}`);

const makeData = (
  days: Record<string, IExportDayValue>,
  over: Partial<IDepartmentTimesheetData> = {},
): IDepartmentTimesheetData => ({
  departmentName: 'Payroll',
  departmentId: null,
  isBrigade: false,
  employees: [{ id: 60, full_name: 'Прораб', position_id: null, org_department_id: 'dept-1', sigur_employee_id: 1 }],
  schedulesMap: new Map([[60, schedule]]),
  dailySchedulesMap: new Map([[60, new Map(julyDates.map(date => [date, schedule]))]]),
  calendarMonth: null,
  entries: [],
  dataMap: new Map([[60, new Map(Object.entries(days))]]),
  objectEntries: [],
  skudMap: new Map(),
  posMap: new Map(),
  year: 2026,
  mon: 7,
  daysInMonth: 31,
  exportHalf: 'FULL',
  exportDays: julyDates.map((_, i) => i + 1),
  showActualHours: true,
  plannedWeekendDays: new Set(),
  ...over,
});

const work = (hours: number): IExportDayValue => ({ status: 'work', hours });

describe('расчётный листок: дни табеля рабочие / выходные', () => {
  it('будни и плановая суббота — рабочие, согласованное воскресенье — выходной', () => {
    const data = makeData(
      {
        '2026-07-01': work(8), // ср
        '2026-07-02': work(8), // чт
        '2026-07-04': work(8), // сб, в квоте графика
        '2026-07-05': work(8), // вс, согласованный выход
      },
      { plannedWeekendDays: new Set(['60|2026-07-04']) },
    );

    expect(splitWorkedDays(data, 60)).toEqual({ workday: 3, dayoff: 1 });
  });

  it('обнулённый выходной, отпуск и «Н» не считаются; удалёнка без часов — рабочий', () => {
    const data = makeData({
      '2026-07-06': { status: 'remote', hours: 0 }, // пн, УУ
      '2026-07-07': { status: 'vacation', hours: 8 },
      '2026-07-08': { status: 'absent', hours: 0 },
      '2026-07-11': { status: 'work', hours: 0, hoursDropped: true }, // сб вне квоты
    });

    expect(splitWorkedDays(data, 60)).toEqual({ workday: 1, dayoff: 0 });
  });

  it('дни после увольнения не считаются', () => {
    const data = makeData(
      { '2026-07-01': work(8), '2026-07-21': work(8) },
      { cutoffByEmployeeId: new Map([[60, '2026-07-21']]) },
    );

    expect(splitWorkedDays(data, 60)).toEqual({ workday: 1, dayoff: 0 });
  });

  it('без графика на день — рабочий, как в выгрузке', () => {
    const data = makeData({ '2026-07-05': work(8) }, { dailySchedulesMap: new Map() });

    expect(splitWorkedDays(data, 60)).toEqual({ workday: 1, dayoff: 0 });
  });

  it('сотрудника нет в табеле — null', () => {
    expect(splitWorkedDays(makeData({}, { employees: [] }), 60)).toBeNull();
  });
});

describe('расчётный листок: период', () => {
  it('весь месяц', () => {
    expect(payslipPeriod('2026-07', '2024-03-01', null)).toEqual({ from: '2026-07-01', to: '2026-07-31' });
  });

  it('принят в середине месяца — с даты приёма', () => {
    expect(payslipPeriod('2026-07', '2026-07-15', null)).toEqual({ from: '2026-07-15', to: '2026-07-31' });
  });

  it('уволен — по день увольнения (cutoff — следующий день)', () => {
    expect(payslipPeriod('2026-07', null, '2026-07-21')).toEqual({ from: '2026-07-01', to: '2026-07-20' });
    expect(payslipPeriod('2026-02', null, '2026-03-01')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('уволен до месяца — периода нет', () => {
    expect(payslipPeriod('2026-07', null, '2026-07-01')).toBeNull();
  });

  it('дата приёма позже месяца не режет период: суммы из 1С за месяц есть — значит, работал', () => {
    expect(payslipPeriod('2026-07', '2026-08-03', null)).toEqual({ from: '2026-07-01', to: '2026-07-31' });
  });
});
