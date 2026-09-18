import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  fetchEmps: vi.fn(),
  slice: vi.fn(),
  buildWorkbook: vi.fn(),
  writeBuffer: vi.fn(),
  segments: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({ query: h.pgQuery, queryOne: vi.fn() }));
vi.mock('./timesheet-export.service.js', () => ({
  fetchTimesheetDataForEmployees: h.fetchEmps,
  sliceTimesheetDataByEmployees: h.slice,
}));
vi.mock('./timesheet-1c-unified.service.js', () => ({ buildUnified1CWorkbook: h.buildWorkbook }));
vi.mock('./timesheet-excel.service.js', () => ({ writeTimesheetWorkbookBuffer: h.writeBuffer }));
vi.mock('./timesheet-department-assignments.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./timesheet-department-assignments.service.js')>();
  return {
    resolveTimesheetDateRange: actual.resolveTimesheetDateRange,
    resolveTimesheetPeriodRange: actual.resolveTimesheetPeriodRange,
    resolveTransferSegmentsInPeriod: h.segments,
    buildTransferSegments: actual.buildTransferSegments,
  };
});

import { buildTransferSegments } from './timesheet-department-assignments.service.js';
import {
  buildUnified1CBuffer,
  groupEmployeesByDepartment,
  parseStrictExportPeriod,
} from './timesheet-unified-export.service.js';

beforeEach(() => {
  vi.clearAllMocks();
  h.pgQuery.mockResolvedValue([{ id: 'D1', name: 'бр. Первая' }]);
  h.fetchEmps.mockResolvedValue({ bulk: true });
  h.slice.mockImplementation((_bulk: unknown, ids: number[], name: string, deptId: string | null) => ({ ids, name, deptId }));
  h.buildWorkbook.mockResolvedValue({});
  h.writeBuffer.mockResolvedValue(Buffer.from('xlsx'));
  h.segments.mockResolvedValue(new Map());
});

describe('parseStrictExportPeriod', () => {
  const ok = { month: '2026-07', from: '2026-07-01', to: '2026-07-15' };

  it('корректный период разбирается, суффикс отражает половину месяца', () => {
    const result = parseStrictExportPeriod(ok);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.period).toMatchObject({
      year: 2026, mon: 7, startDate: '2026-07-01', endDate: '2026-07-15', segmentSuffix: '_1-15',
    });
  });

  it('полный месяц → пустой суффикс', () => {
    const result = parseStrictExportPeriod({ month: '2026-07', from: '2026-07-01', to: '2026-07-31' });
    expect(result.ok && result.period.segmentSuffix).toBe('');
  });

  it.each([
    ['без from/to', { month: '2026-07' }],
    ['обратный порядок дат', { month: '2026-07', from: '2026-07-15', to: '2026-07-01' }],
    ['дата вне месяца', { month: '2026-07', from: '2026-06-01', to: '2026-07-15' }],
    ['несуществующая дата', { month: '2026-02', from: '2026-02-01', to: '2026-02-30' }],
    ['битый month', { month: '2026-13', from: '2026-13-01', to: '2026-13-15' }],
  ])('%s → ошибка, а не полный месяц', (_label, body) => {
    expect(parseStrictExportPeriod(body).ok).toBe(false);
  });
});

describe('buildUnified1CBuffer', () => {
  const period = {
    month: '2026-07',
    rangeArg: { startDate: '2026-07-01', endDate: '2026-07-31' } as const,
    scopeDeptIds: ['D1', 'D2'],
    personOriginEmployeeIds: new Set<number>(),
  };

  it('группирует сотрудников по отделам и делает ОДИН bulk-прогон', async () => {
    h.pgQuery.mockResolvedValue([{ id: 'D1', name: 'бр. Первая' }, { id: 'D2', name: 'бр. Вторая' }]);
    await buildUnified1CBuffer({
      ...period,
      memberByEmp: new Map([[1, 'D1'], [2, 'D2'], [3, 'D1']]),
      exemptEmployeeIds: new Set([9]),
    });

    expect(h.fetchEmps).toHaveBeenCalledTimes(1);
    const call = h.fetchEmps.mock.calls[0];
    expect(call[1]).toEqual([1, 2, 3]);
    expect(call[4]).toBe('actual');
    expect(call[5]).toBe(true);
    expect(call[6]).toEqual({ excludeZeroActivity: true, exemptEmployeeIds: new Set([9]) });

    expect(h.slice).toHaveBeenCalledTimes(2);
    expect(h.slice.mock.calls[0].slice(1)).toEqual([[1, 3], 'бр. Первая', 'D1', undefined]);
    expect(h.slice.mock.calls[1].slice(1)).toEqual([[2], 'бр. Вторая', 'D2', undefined]);
    expect(h.segments).toHaveBeenCalledWith([1, 2, 3], '2026-07-01', '2026-07-31');
  });

  it('сотрудники без отдела попадают в бакет «Без названия», null в SQL не уходит', async () => {
    h.pgQuery.mockResolvedValue([{ id: 'D1', name: 'бр. Первая' }]);
    await buildUnified1CBuffer({
      ...period,
      memberByEmp: new Map([[1, 'D1'], [2, null]]),
      exemptEmployeeIds: new Set(),
    });

    expect(h.pgQuery.mock.calls[0][1]).toEqual([['D1']]);
    expect(h.slice.mock.calls[1].slice(1)).toEqual([[2], 'Без названия', null, undefined]);
  });

  it('отдел отсутствует в org_departments → «Без названия»', async () => {
    h.pgQuery.mockResolvedValue([]);
    await buildUnified1CBuffer({
      ...period,
      memberByEmp: new Map([[1, 'D-ghost']]),
      exemptEmployeeIds: new Set(),
    });

    expect(h.slice.mock.calls[0].slice(1)).toEqual([[1], 'Без названия', 'D-ghost', undefined]);
  });

  it('mon/year выводятся из month, а не приходят снаружи', async () => {
    await buildUnified1CBuffer({
      month: '2026-02',
      rangeArg: { startDate: '2026-02-01', endDate: '2026-02-28' },
      memberByEmp: new Map([[1, 'D1']]),
      exemptEmployeeIds: new Set(),
      scopeDeptIds: ['D1'],
      personOriginEmployeeIds: new Set(),
    });

    expect(h.buildWorkbook).toHaveBeenCalledWith(2, 2026, expect.any(Array));
  });

  it('перевод внутри периода: срез получает окно дней отдела из набора выгрузки', async () => {
    h.pgQuery.mockResolvedValue([{ id: 'A', name: 'бр.А' }]);
    h.segments.mockResolvedValue(new Map([[5, [
      { deptId: 'A', from: null, toExclusive: '2026-07-15' },
      { deptId: 'B', from: '2026-07-15', toExclusive: null },
    ]]]));
    await buildUnified1CBuffer({
      ...period,
      memberByEmp: new Map([[5, 'A']]),
      exemptEmployeeIds: new Set(),
      scopeDeptIds: ['A'],
    });

    expect(h.slice).toHaveBeenCalledTimes(1);
    expect(h.slice.mock.calls[0].slice(1)).toEqual([
      [5], 'бр.А', 'A', new Map([[5, [{ from: null, toExclusive: '2026-07-15' }]]]),
    ]);
  });

  it('повторная сборка при тех же данных даёт те же срезы', async () => {
    h.segments.mockResolvedValue(new Map([[5, [
      { deptId: 'A', from: null, toExclusive: '2026-07-15' },
      { deptId: 'B', from: '2026-07-15', toExclusive: null },
    ]]]));
    const params = {
      ...period,
      memberByEmp: new Map<number, string | null>([[5, 'A'], [6, 'B']]),
      exemptEmployeeIds: new Set<number>(),
      scopeDeptIds: ['A', 'B'],
    };
    await buildUnified1CBuffer(params);
    const first = h.slice.mock.calls.map(call => call.slice(1));
    h.slice.mockClear();
    await buildUnified1CBuffer(params);
    expect(h.slice.mock.calls.map(call => call.slice(1))).toEqual(first);
  });
});

describe('groupEmployeesByDepartment', () => {
  const ABA = [
    { deptId: 'A', from: null, toExclusive: '2026-07-10' },
    { deptId: 'B', from: '2026-07-10', toExclusive: '2026-07-20' },
    { deptId: 'A', from: '2026-07-20', toExclusive: null },
  ];

  const allDaysOf = (buckets: ReturnType<typeof groupEmployeesByDepartment>, empId: number): string[] => {
    const days: string[] = [];
    for (let d = 1; d <= 31; d++) {
      const iso = `2026-07-${String(d).padStart(2, '0')}`;
      for (const bucket of buckets) {
        if (!bucket.employeeIds.includes(empId)) continue;
        const windows = bucket.windows.get(empId);
        const inside = !windows || windows.some(w => (w.from == null || iso >= w.from) && (w.toExclusive == null || iso < w.toExclusive));
        if (inside) days.push(`${bucket.deptId}:${iso}`);
      }
    }
    return days;
  };

  it('без перевода — отдел из memberByEmp, без окон', () => {
    const buckets = groupEmployeesByDepartment(new Map([[1, 'A']]), new Map(), ['A'], new Set());
    expect(buckets).toEqual([{ deptId: 'A', employeeIds: [1], windows: new Map() }]);
  });

  it('A→B→A при scope {A}: одна запись в A с двумя интервалами, дни B не попадают', () => {
    const buckets = groupEmployeesByDepartment(new Map([[1, 'A']]), new Map([[1, ABA]]), ['A'], new Set());
    expect(buckets).toHaveLength(1);
    expect(buckets[0].deptId).toBe('A');
    expect(buckets[0].employeeIds).toEqual([1]);
    expect(buckets[0].windows.get(1)).toEqual([
      { from: null, toExclusive: '2026-07-10' },
      { from: '2026-07-20', toExclusive: null },
    ]);
  });

  it('scope {B}: только дни B', () => {
    const buckets = groupEmployeesByDepartment(new Map([[1, 'B']]), new Map([[1, ABA]]), ['B'], new Set());
    expect(buckets.map(b => b.deptId)).toEqual(['B']);
    expect(buckets[0].windows.get(1)).toEqual([{ from: '2026-07-10', toExclusive: '2026-07-20' }]);
  });

  it('A + B = A∪B: каждый день ровно в одном отделе, без потерь и задвоений', () => {
    const only = (scope: string[]) => allDaysOf(
      groupEmployeesByDepartment(new Map([[1, scope[0]]]), new Map([[1, ABA]]), scope, new Set()), 1,
    );
    const union = only(['A', 'B']);
    expect(union).toHaveLength(31);
    expect([...only(['A']), ...only(['B'])].sort()).toEqual([...union].sort());
  });

  it('«по человеку»: все сегменты остаются, каждый в своём отделе, вне зависимости от scope', () => {
    const buckets = groupEmployeesByDepartment(new Map([[1, 'A']]), new Map([[1, ABA]]), [], new Set([1]));
    expect(buckets.map(b => b.deptId)).toEqual(['A', 'B']);
    expect(allDaysOf(buckets, 1)).toHaveLength(31);
  });

  it('членство без сегментов в scope — сотрудник в файл не попадает', () => {
    const buckets = groupEmployeesByDepartment(new Map([[1, 'A']]), new Map([[1, ABA]]), ['C'], new Set());
    expect(buckets).toEqual([]);
  });

  it('сегмент без отдела у «по человеку» → бакет null («Без названия»)', () => {
    const buckets = groupEmployeesByDepartment(
      new Map([[1, 'A']]),
      new Map([[1, [{ deptId: null, from: null, toExclusive: '2026-07-05' }, { deptId: 'A', from: '2026-07-05', toExclusive: null }]]]),
      [],
      new Set([1]),
    );
    expect(buckets.map(b => b.deptId)).toEqual([null, 'A']);
  });

  describe('промежуток в архиве «Уволенные» (сегменты — настоящий buildTransferSegments)', () => {
    const START = '2026-07-01';
    const END = '2026-07-31';
    const ARCHIVE = 'archive';
    const assignment = (id: number, dept: string, from: string, to: string | null) => ({
      id, employee_id: 1, org_department_id: dept, effective_from: from, effective_to: to,
    });

    it('A → архив → A при scope {A}: окон нет, все 31 день в A (случай Садиева)', () => {
      const segments = buildTransferSegments([
        assignment(1, 'A', '2026-04-20', '2026-07-09'),
        assignment(2, ARCHIVE, '2026-07-10', '2026-07-10'),
        assignment(3, ARCHIVE, '2026-07-11', '2026-07-11'),
        assignment(4, 'A', '2026-07-12', null),
      ], START, END, ARCHIVE);
      const buckets = groupEmployeesByDepartment(new Map([[1, 'A']]), segments, ['A'], new Set());
      expect(buckets).toEqual([{ deptId: 'A', employeeIds: [1], windows: new Map() }]);
      expect(allDaysOf(buckets, 1)).toHaveLength(31);
    });

    it('A → архив → B: {A} + {B} покрывают каждый день ровно один раз, бакета «Уволенные» нет', () => {
      const segments = buildTransferSegments([
        assignment(1, 'A', '2026-01-01', '2026-07-09'),
        assignment(2, ARCHIVE, '2026-07-10', '2026-07-14'),
        assignment(3, 'B', '2026-07-15', null),
      ], START, END, ARCHIVE);
      const only = (scope: string[]) => groupEmployeesByDepartment(new Map([[1, scope[0]]]), segments, scope, new Set());

      const inB = only(['B']);
      expect(inB.map(b => b.deptId)).toEqual(['B']);
      expect(inB[0].windows.get(1)).toEqual([{ from: '2026-07-15', toExclusive: null }]);

      const days = [...allDaysOf(only(['A']), 1), ...allDaysOf(inB, 1)];
      expect(days).toHaveLength(31);
      expect(days.filter(d => d.startsWith('A:'))).toHaveLength(14);
      expect(days.some(d => d.startsWith(`${ARCHIVE}:`))).toBe(false);
    });
  });
});
