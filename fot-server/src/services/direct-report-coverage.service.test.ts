import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Покрытие отделом: за какие дни табель сотрудника ведёт руководитель его отдела,
 * а не личный руководитель из employee_direct_reports.
 */

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));
vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

const { hasPageEditMock } = vi.hoisted(() => ({ hasPageEditMock: vi.fn(async () => true) }));
vi.mock('./access-control.service.js', () => ({ hasPageEdit: hasPageEditMock }));

import {
  isCoveredOn,
  loadCoverage,
  splitDirectReportsByCoverage,
  type IEmployeeCoverage,
} from './direct-report-coverage.service.js';

const EMP = 501;
const MANAGED = 'dept-with-head';
const FREE = 'dept-without-head';

interface IFixture {
  assignments?: Array<{ employee_id: number; dept_id: string; effective_from: string; effective_to: string | null }>;
  snapshot?: Array<{ id: number; org_department_id: string | null }>;
  heads?: Array<{ employee_id: number; department_id: string; role_code?: string; is_admin?: boolean }>;
}

const mockDb = (fixture: IFixture) => {
  pgQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM employee_assignments')) return fixture.assignments ?? [];
    if (sql.includes('FROM employees')) return fixture.snapshot ?? [];
    if (sql.includes('FROM employee_department_access')) {
      return (fixture.heads ?? []).map(row => ({
        role_code: 'manager', is_admin: false, ...row,
      }));
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  hasPageEditMock.mockResolvedValue(true);
});

describe('loadCoverage — snapshot-фолбэк', () => {
  it('нет истории назначений: отдел из snapshot с руководителем → покрыт', async () => {
    mockDb({
      snapshot: [{ id: EMP, org_department_id: MANAGED }],
      heads: [{ employee_id: 900, department_id: MANAGED }],
    });

    const coverage = await loadCoverage([EMP], '2026-09-01', '2026-09-15');

    expect(isCoveredOn(coverage.get(EMP), '2026-09-07')).toBe(true);
  });

  it('отдел без назначенного руководителя → не покрыт', async () => {
    mockDb({ snapshot: [{ id: EMP, org_department_id: FREE }], heads: [] });

    const coverage = await loadCoverage([EMP], '2026-09-01', '2026-09-15');

    expect(isCoveredOn(coverage.get(EMP), '2026-09-07')).toBe(false);
  });

  it('руководитель без права edit на /timesheet не покрывает: подать отдел он не сможет', async () => {
    hasPageEditMock.mockResolvedValue(false);
    mockDb({
      snapshot: [{ id: EMP, org_department_id: MANAGED }],
      heads: [{ employee_id: 900, department_id: MANAGED, role_code: 'otitb' }],
    });

    const coverage = await loadCoverage([EMP], '2026-09-01', '2026-09-15');

    expect(isCoveredOn(coverage.get(EMP), '2026-09-07')).toBe(false);
  });

  it('is_admin покрывает без обращения к role_page_access', async () => {
    hasPageEditMock.mockResolvedValue(false);
    mockDb({
      snapshot: [{ id: EMP, org_department_id: MANAGED }],
      heads: [{ employee_id: 900, department_id: MANAGED, role_code: 'admin', is_admin: true }],
    });

    const coverage = await loadCoverage([EMP], '2026-09-01', '2026-09-15');

    expect(isCoveredOn(coverage.get(EMP), '2026-09-07')).toBe(true);
    expect(hasPageEditMock).not.toHaveBeenCalled();
  });
});

describe('isCoveredOn — чистое правило', () => {
  const coverage = (over: Partial<IEmployeeCoverage> = {}): IEmployeeCoverage => ({
    intervals: [], snapshotCovered: false, ...over,
  });

  it('дата внутри покрытого интервала', () => {
    const own = coverage({
      intervals: [{ effectiveFrom: '2026-09-01', effectiveTo: '2026-09-05', covered: true }],
    });
    expect(isCoveredOn(own, '2026-09-03')).toBe(true);
    expect(isCoveredOn(own, '2026-09-06')).toBe(false);
  });

  it('дата вне всех интервалов → ответ по snapshot', () => {
    const own = coverage({
      intervals: [{ effectiveFrom: '2026-09-10', effectiveTo: null, covered: false }],
      snapshotCovered: true,
    });
    // 09-05 не покрыта ни одним интервалом → берём snapshot.
    expect(isCoveredOn(own, '2026-09-05')).toBe(true);
    // 09-12 покрыта интервалом без руководителя → snapshot не спрашиваем.
    expect(isCoveredOn(own, '2026-09-12')).toBe(false);
  });

  it('пересекающиеся назначения: достаточно одного покрытого', () => {
    const own = coverage({
      intervals: [
        { effectiveFrom: '2026-09-01', effectiveTo: null, covered: false },
        { effectiveFrom: '2026-09-01', effectiveTo: null, covered: true },
      ],
    });
    expect(isCoveredOn(own, '2026-09-03')).toBe(true);
  });
});

describe('splitDirectReportsByCoverage', () => {
  it('перевод внутри периода: частичное покрытие, дни не теряются', async () => {
    mockDb({
      assignments: [
        { employee_id: EMP, dept_id: MANAGED, effective_from: '2026-01-01', effective_to: '2026-09-05' },
        { employee_id: EMP, dept_id: FREE, effective_from: '2026-09-06', effective_to: null },
      ],
      snapshot: [{ id: EMP, org_department_id: FREE }],
      heads: [{ employee_id: 900, department_id: MANAGED }],
    });

    const split = await splitDirectReportsByCoverage([EMP], '2026-09-01', '2026-09-10');

    expect(split.partiallyCovered).toEqual([EMP]);
    expect(split.owned).toEqual([]);
    expect(split.fullyCovered).toEqual([]);
    expect(split.coveredDates.get(EMP)).toEqual([
      '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05',
    ]);
  });

  it('покрыт весь период → fullyCovered', async () => {
    mockDb({
      snapshot: [{ id: EMP, org_department_id: MANAGED }],
      heads: [{ employee_id: 900, department_id: MANAGED }],
    });

    const split = await splitDirectReportsByCoverage([EMP], '2026-09-01', '2026-09-03');

    expect(split.fullyCovered).toEqual([EMP]);
    expect(split.coveredDates.get(EMP)).toHaveLength(3);
  });

  it('ни одного покрытого дня → owned, дат не отдаём', async () => {
    mockDb({ snapshot: [{ id: EMP, org_department_id: FREE }], heads: [] });

    const split = await splitDirectReportsByCoverage([EMP], '2026-09-01', '2026-09-03');

    expect(split.owned).toEqual([EMP]);
    expect(split.coveredDates.has(EMP)).toBe(false);
  });

  it('пустой список — в БД не ходим', async () => {
    mockDb({});
    const split = await splitDirectReportsByCoverage([], '2026-09-01', '2026-09-03');
    expect(split.owned).toEqual([]);
    expect(pgQuery).not.toHaveBeenCalled();
  });
});
