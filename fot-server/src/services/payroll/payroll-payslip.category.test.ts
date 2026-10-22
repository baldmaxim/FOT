import { beforeEach, describe, expect, it, vi } from 'vitest';

// Листок: категория месяца — по табелю (месячный резолвер), а не staff_category из условий оплаты.
const pg = vi.hoisted(() => ({ queryOne: vi.fn() }));
vi.mock('../../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: pg.queryOne,
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('../timesheet-export.service.js', () => ({
  fetchTimesheetDataForEmployees: vi.fn(async () => ({})),
}));
vi.mock('../timesheet-excel.service.js', () => ({
  buildEmployeeRowsForOneC: vi.fn(() => []),
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

import { getPayslipInfo } from './payroll-payslip.service.js';

describe('getPayslipInfo — категория месяца по табелю', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pg.queryOne.mockImplementation(async (sql: string) => (sql.includes('FROM employees')
      ? { hire_date: null, org_department_id: 'dept-auto', employment_status: 'active' }
      : { travel_rate: '2730.00', dormitory_allowance_rate: null, travel_stopped: false, housing: [] }));
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

    const info = await getPayslipInfo(42, '2026-09');

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

  it('месячный резолвер дал «Офис» — проезд по ставке месяца', async () => {
    category.resolveMonthStaffCategories.mockResolvedValue(['office']);

    const info = await getPayslipInfo(42, '2026-09');

    expect(info.rate_allowances).toEqual([{ code: 'travel', amount: '2730.00' }]);
  });
});
