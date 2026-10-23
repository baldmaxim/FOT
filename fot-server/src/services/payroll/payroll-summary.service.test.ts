import { beforeEach, describe, expect, it, vi } from 'vitest';

// «Свод»: объект строки при базовом «Не определён» берётся по часам (payroll-summary-object.service), а
// категория — по базовому объекту месяца, как в расчётном листке.
const pg = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../config/postgres.js', () => ({ query: pg.query }));

const attribution = vi.hoisted(() => ({
  loadMonthBreakdown: vi.fn(async () => new Map()),
  attributeMonths: vi.fn(),
  monthPairKey: (employeeId: number, month: string) => `${employeeId}|${month}`,
}));
vi.mock('./payroll-month-attribution.service.js', () => attribution);

const category = vi.hoisted(() => ({ resolveMonthStaffCategories: vi.fn() }));
vi.mock('./payroll-staff-category.js', () => category);

const summaryObject = vi.hoisted(() => ({ resolveSummaryObjects: vi.fn() }));
vi.mock('./payroll-summary-object.service.js', () => summaryObject);

import { loadPayrollSummary } from './payroll-summary.service.js';

const BASE = new Map([['265|2026-08', {
  object: { key: 'unknown', name: 'Не определён' },
  departmentId: 'dep-1',
  mode: { mode: 'skud', pinnedObjectId: null, source: 'legacy_default' },
}]]);

beforeEach(() => {
  vi.clearAllMocks();
  pg.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM payroll_paid_amounts')) {
      return [{ employee_id: 265, month: '2026-08', item: 'contract', amount: '170000.00' }];
    }
    if (sql.includes('FROM employees')) {
      return [{ id: 265, full_name: 'Башкиров Глеб Олегович', org_department_id: 'dep-1', employment_status: 'active', position: 'инженер' }];
    }
    if (sql.includes('FROM org_departments')) return [{ id: 'dep-1', name: 'Отдел проектирования' }];
    return [];
  });
  attribution.attributeMonths.mockResolvedValue(BASE);
  category.resolveMonthStaffCategories.mockResolvedValue(['itr']);
});

describe('loadPayrollSummary — объект строки и категория', () => {
  it('базовый «Не определён», по часам — «Офис»: строка в «Офисе», категория прежняя (по базовому объекту)', async () => {
    summaryObject.resolveSummaryObjects.mockResolvedValue(new Map([['265|2026-08', { key: 'office', name: 'Офис' }]]));

    const summary = await loadPayrollSummary({ scope: { contractorRootId: null, departmentIds: null }, monthStarts: ['2026-08-01'] });

    expect(summary.rows).toEqual([expect.objectContaining({
      employee_id: 265,
      object_key: 'office',
      object_name: 'Офис',
      category: 'itr',
      amounts: { contract: '170000.00' },
    })]);
    expect(category.resolveMonthStaffCategories.mock.calls[0][0][0]).toMatchObject({ officeObject: false });
    expect(summaryObject.resolveSummaryObjects).toHaveBeenCalledWith(BASE);
  });

  it('объекта по часам нет — строка «Не определён», как раньше', async () => {
    summaryObject.resolveSummaryObjects.mockResolvedValue(new Map());

    const summary = await loadPayrollSummary({ scope: { contractorRootId: null, departmentIds: null }, monthStarts: ['2026-08-01'] });

    expect(summary.rows.map(row => [row.object_key, row.object_name, row.category])).toEqual([['unknown', 'Не определён', 'itr']]);
  });
});
