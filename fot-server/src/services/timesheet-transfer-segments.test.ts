import { beforeEach, describe, expect, it, vi } from 'vitest';

// Сегменты переводов внутри периода (единый файл 1С) и детерминизм периодных резолверов отдела.

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));
vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('./skud-shared.service.js', () => ({ collectDeptIds: vi.fn() }));

import {
  buildTransferSegments,
  listScopedMembersByDepartment,
  resolveDepartmentIdsForEmployeesInPeriod,
  resolveTransferSegmentsInPeriod,
  type IAssignmentPeriodRow,
} from './timesheet-department-assignments.service.js';

const START = '2026-09-01';
const END = '2026-09-30';

const row = (
  id: number,
  employee_id: number,
  org_department_id: string | null,
  effective_from: string,
  effective_to: string | null,
): IAssignmentPeriodRow => ({ id, employee_id, org_department_id, effective_from, effective_to });

beforeEach(() => {
  pgQuery.mockReset().mockResolvedValue([]);
});

describe('buildTransferSegments', () => {
  it('перевод со стыком (Пулатов: Зулфикаров по 14.09, Хайдаров с 15.09) → 2 сегмента', () => {
    const segments = buildTransferSegments([
      row(1, 2588, 'zulf', '2026-05-17', '2026-09-14'),
      row(2, 2588, 'hayd', '2026-09-15', null),
    ], START, END);

    expect(segments.get(2588)).toEqual([
      { deptId: 'zulf', from: null, toExclusive: '2026-09-15' },
      { deptId: 'hayd', from: '2026-09-15', toExclusive: null },
    ]);
  });

  it('поздний effective_from без стыка («грязное» назначение) → не делим', () => {
    const segments = buildTransferSegments([row(1, 7, 'A', '2026-09-10', null)], START, END);
    expect(segments.has(7)).toBe(false);
  });

  it('стык с тем же отделом (смена должности) → не делим', () => {
    const segments = buildTransferSegments([
      row(1, 7, 'A', '2026-01-01', '2026-09-09'),
      row(2, 7, 'A', '2026-09-10', null),
    ], START, END);
    expect(segments.has(7)).toBe(false);
  });

  it('перевод до начала периода → не делим (весь период в новом отделе)', () => {
    const segments = buildTransferSegments([
      row(1, 7, 'A', '2026-01-01', '2026-08-31'),
      row(2, 7, 'B', '2026-09-01', null),
    ], START, END);
    expect(segments.has(7)).toBe(false);
  });

  it('A→B→A → 3 сегмента, покрывают период без дыр и пересечений', () => {
    const segments = buildTransferSegments([
      row(1, 7, 'A', '2026-01-01', '2026-09-09'),
      row(2, 7, 'B', '2026-09-10', '2026-09-19'),
      row(3, 7, 'A', '2026-09-20', null),
    ], START, END)!.get(7)!;

    expect(segments).toEqual([
      { deptId: 'A', from: null, toExclusive: '2026-09-10' },
      { deptId: 'B', from: '2026-09-10', toExclusive: '2026-09-20' },
      { deptId: 'A', from: '2026-09-20', toExclusive: null },
    ]);
    for (let d = 1; d <= 30; d++) {
      const iso = `2026-09-${String(d).padStart(2, '0')}`;
      const hits = segments.filter(s => (s.from == null || iso >= s.from) && (s.toExclusive == null || iso < s.toExclusive));
      expect(hits).toHaveLength(1);
    }
  });

  it('переход из «без отдела» (NULL) — тоже перевод, сегмент с deptId null', () => {
    const segments = buildTransferSegments([
      row(1, 7, null, '2026-01-01', '2026-09-04'),
      row(2, 7, 'B', '2026-09-05', null),
    ], START, END);
    expect(segments.get(7)).toEqual([
      { deptId: null, from: null, toExclusive: '2026-09-05' },
      { deptId: 'B', from: '2026-09-05', toExclusive: null },
    ]);
  });

  it('порядок входных строк не влияет на результат', () => {
    const rows = [
      row(3, 7, 'A', '2026-09-20', null),
      row(1, 7, 'A', '2026-01-01', '2026-09-09'),
      row(2, 7, 'B', '2026-09-10', '2026-09-19'),
      row(5, 8, 'D', '2026-09-15', null),
      row(4, 8, 'C', '2026-01-01', '2026-09-14'),
    ];
    const forward = buildTransferSegments(rows, START, END);
    const reversed = buildTransferSegments([...rows].reverse(), START, END);
    expect([...reversed]).toEqual([...forward]);
  });
});

describe('resolveTransferSegmentsInPeriod', () => {
  it('читает назначения сотрудников с запасом на стык и детерминированным порядком', async () => {
    pgQuery.mockResolvedValue([
      row(1, 2588, 'zulf', '2026-05-17', '2026-09-14'),
      row(2, 2588, 'hayd', '2026-09-15', null),
    ]);

    const segments = await resolveTransferSegmentsInPeriod([2588, 2588, 0], START, END);

    const [sql, params] = pgQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FROM employee_assignments');
    expect(sql).toContain('ORDER BY employee_id, effective_from, id');
    expect(params).toEqual([[2588], START, END]);
    expect(segments.get(2588)).toHaveLength(2);
  });

  it('пустой список → без запроса', async () => {
    expect((await resolveTransferSegmentsInPeriod([], START, END)).size).toBe(0);
    expect(pgQuery).not.toHaveBeenCalled();
  });
});

describe('периодные резолверы отдела: стабильный выбор среди строк одного приоритета', () => {
  const TIE_BREAKER = 'ORDER BY s.employee_id, s.prio, s.eff_from DESC NULLS LAST, s.dept_id NULLS LAST';

  it('listScopedMembersByDepartment — побеждает самое позднее назначение, затем id отдела', async () => {
    await listScopedMembersByDepartment(['A', 'B'], START, END);
    const [sql] = pgQuery.mock.calls[0] as [string];
    expect(sql).toContain('a.effective_from AS eff_from');
    expect(sql).toContain(TIE_BREAKER);
  });

  it('resolveDepartmentIdsForEmployeesInPeriod — тот же tie-breaker', async () => {
    await resolveDepartmentIdsForEmployeesInPeriod([1], START, END);
    const [sql] = pgQuery.mock.calls[0] as [string];
    expect(sql).toContain('a.effective_from AS eff_from');
    expect(sql).toContain(TIE_BREAKER);
  });
});
