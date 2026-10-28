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

import { performance } from 'node:perf_hooks';

import { emptySummaryTiming, loadPayrollSummary, summaryServerTiming } from './payroll-summary.service.js';

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
    expect(summaryObject.resolveSummaryObjects.mock.calls[0][0]).toBe(BASE);
  });

  it('объекта по часам нет — строка «Не определён», как раньше', async () => {
    summaryObject.resolveSummaryObjects.mockResolvedValue(new Map());

    const summary = await loadPayrollSummary({ scope: { contractorRootId: null, departmentIds: null }, monthStarts: ['2026-08-01'] });

    expect(summary.rows.map(row => [row.object_key, row.object_name, row.category])).toEqual([['unknown', 'Не определён', 'itr']]);
  });
});

describe('замер «Свода» по шагам', () => {
  it('шаги и счётчики заполняются; в лог — только дольше 2 с', async () => {
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const run = async (hoursMs: number) => {
      summaryObject.resolveSummaryObjects.mockImplementation(async (_base: unknown, _now: unknown, stats?: {
        unknown: number; byMode: number; hoursEmployees: number; hoursMs: number;
      }) => {
        clock += hoursMs;
        if (stats) Object.assign(stats, { unknown: 1, byMode: 0, hoursEmployees: 1, hoursMs });
        return new Map();
      });
      const timing = emptySummaryTiming();
      await loadPayrollSummary({ scope: { contractorRootId: null, departmentIds: null }, monthStarts: ['2026-08-01'], timing });
      return timing;
    };

    const fast = await run(500);
    expect(fast).toMatchObject({ paidRows: 1, pairs: 1, unknown: 1, hoursEmployees: 1, objectsMs: 500, totalMs: 500 });
    expect(log).not.toHaveBeenCalled();

    const slow = await run(4000);
    expect(slow.totalMs).toBe(4000);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(
      /^\[payroll-summary\] 2026-08: суммы 1С 0 мс \(1 строк\), охват 0 мс \(1 пар\), .*объект по часам 4000 мс .*по часам 1 чел\. за 4000 мс\).*всего 4000 мс$/,
    );
    expect(summaryServerTiming(slow)).toContain('summary_objects;dur=4000.0;desc="1/0/1"');
    expect(summaryServerTiming(slow)).toContain('summary_total;dur=4000.0');
    now.mockRestore();
    log.mockRestore();
  });
});
