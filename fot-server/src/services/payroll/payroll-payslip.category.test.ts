import { beforeEach, describe, expect, it, vi } from 'vitest';

// Листок: категория месяца — по табелю (месячный резолвер), а не staff_category из условий оплаты.
const pg = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock('../../config/postgres.js', () => ({
  query: pg.query,
  queryOne: pg.queryOne,
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

// Сентябрь 2026: «5+2» без плановых суббот — 22 будних; отработано 20 будних и согласованная суббота 5-го.
const septemberDates = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
const fiveTwo = {
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
vi.mock('../timesheet-export.service.js', () => ({
  fetchTimesheetDataForEmployees: vi.fn(async () => ({
    year: 2026,
    mon: 9,
    daysInMonth: 30,
    calendarMonth: null,
    dailySchedulesMap: new Map([[42, new Map(septemberDates.map(date => [date, fiveTwo]))]]),
    plannedWeekendDays: new Set(),
  })),
}));
vi.mock('../timesheet-excel.service.js', () => ({
  buildEmployeeRowsForOneC: vi.fn(() => [{
    employeeId: 42,
    workedDayNumbers: [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 28],
  }]),
}));

const terms = vi.hoisted(() => ({ getTermsForPeriod: vi.fn() }));
vi.mock('./payroll-terms.service.js', () => terms);

const attribution = vi.hoisted(() => ({
  loadMonthBreakdown: vi.fn(async () => new Map()),
  attributeMonths: vi.fn(),
  monthPairKey: (employeeId: number, month: string) => `${employeeId}|${month}`,
}));
vi.mock('./payroll-month-attribution.service.js', () => attribution);

const category = vi.hoisted(() => ({ resolveMonthStaffCategories: vi.fn() }));
vi.mock('./payroll-staff-category.js', () => category);

// Объект «Свода» по часам — только для строки «Свода»: листок его не вызывает.
const summaryObject = vi.hoisted(() => ({ resolveSummaryObjects: vi.fn() }));
vi.mock('./payroll-summary-object.service.js', () => summaryObject);

import type { AuthenticatedRequest } from '../../types/index.js';
import { getPayslipInfo } from './payroll-payslip.service.js';

const req = { user: { id: 'user-1' } } as unknown as AuthenticatedRequest;

describe('getPayslipInfo — категория месяца по табелю', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pg.queryOne.mockImplementation(async (sql: string) => (sql.includes('FROM employees')
      ? { hire_date: null, org_department_id: 'dept-auto', employment_status: 'active' }
      : null));
    // Закрытых подач нет — листок по живому табелю; ставки месяца — пакетным запросом.
    pg.query.mockImplementation(async (sql: string) => (sql.includes('payroll_rate_value')
      ? [{ employee_id: 42, travel_rate: '2730.00', dormitory_allowance_rate: null, travel_stopped: false, housing: [] }]
      : []));
    // В условиях — «Офис»: прежний листок дал бы проезд.
    terms.getTermsForPeriod.mockResolvedValue(new Map([[42, [{
      effective_from: '2026-09-01', effective_to: null, calc_type: 'salary', monthly_salary: '100000.00',
      hourly_rate: null, staff_category: 'office',
    }]]]));
    attribution.attributeMonths.mockResolvedValue(new Map([['42|2026-09', {
      object: { key: 'obj-khimki', name: 'ЖК Химки' },
      departmentId: 'dept-auto',
      mode: { mode: 'skud', pinnedObjectId: null, source: 'employee_explicit', setBy: 'auto' },
    }]]));
  });

  it('месячный резолвер дал «Рабочие» — проезда нет, хотя в условиях «Офис»', async () => {
    category.resolveMonthStaffCategories.mockResolvedValue(['worker']);

    const info = await getPayslipInfo(42, '2026-09', req);

    expect(category.resolveMonthStaffCategories).toHaveBeenCalledWith([{
      employeeId: 42,
      monthStart: '2026-09-01',
      officeObject: false,
      departmentId: 'dept-auto',
      mode: { mode: 'skud', pinnedObjectId: null, source: 'employee_explicit', setBy: 'auto' },
    }]);
    expect(attribution.attributeMonths).toHaveBeenCalledWith(
      [{ employeeId: 42, month: '2026-09' }],
      expect.any(Map),
      new Map([[42, { hire_date: null, org_department_id: 'dept-auto', employment_status: 'active' }]]),
    );
    expect(info.rate_allowances).toEqual([]);
  });

  it('месячный резолвер дал «Офис» — проезд по ставке месяца: 20 рабочих + 1 выходной из 22 дней', async () => {
    category.resolveMonthStaffCategories.mockResolvedValue(['office']);

    const info = await getPayslipInfo(42, '2026-09', req);

    expect(info.worked_days).toEqual({ workday: 20, dayoff: 1 });
    // Выход в выходной считается: 2 730 × 21 / 22 = 2 605,91 → 2 606.
    expect(info.rate_allowances).toEqual([{ code: 'travel', amount: '2606.00', days: { worked: 21, norm: 22 }, rate: '2730.00' }]);
  });

  it('объект месяца «Не определён» — категория по нему, объект «Свода» по часам листок не считает', async () => {
    attribution.attributeMonths.mockResolvedValue(new Map([['42|2026-09', {
      object: { key: 'unknown', name: 'Не определён' },
      departmentId: 'dept-auto',
      mode: { mode: 'skud', pinnedObjectId: null, source: 'legacy_default' },
    }]]));
    category.resolveMonthStaffCategories.mockResolvedValue(['worker']);

    const info = await getPayslipInfo(42, '2026-09', req);

    expect(category.resolveMonthStaffCategories.mock.calls[0][0][0]).toMatchObject({ officeObject: false });
    expect(summaryObject.resolveSummaryObjects).not.toHaveBeenCalled();
    expect(info.rate_allowances).toEqual([]);
  });
});
