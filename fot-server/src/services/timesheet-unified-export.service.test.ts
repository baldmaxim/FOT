import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  fetchEmps: vi.fn(),
  slice: vi.fn(),
  buildWorkbook: vi.fn(),
  writeBuffer: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({ query: h.pgQuery, queryOne: vi.fn() }));
vi.mock('./timesheet-export.service.js', () => ({
  fetchTimesheetDataForEmployees: h.fetchEmps,
  sliceTimesheetDataByEmployees: h.slice,
}));
vi.mock('./timesheet-1c-unified.service.js', () => ({ buildUnified1CWorkbook: h.buildWorkbook }));
vi.mock('./timesheet-excel.service.js', () => ({ writeTimesheetWorkbookBuffer: h.writeBuffer }));

import { buildUnified1CBuffer, parseStrictExportPeriod } from './timesheet-unified-export.service.js';

beforeEach(() => {
  vi.clearAllMocks();
  h.pgQuery.mockResolvedValue([{ id: 'D1', name: 'бр. Первая' }]);
  h.fetchEmps.mockResolvedValue({ bulk: true });
  h.slice.mockImplementation((_bulk: unknown, ids: number[], name: string, deptId: string | null) => ({ ids, name, deptId }));
  h.buildWorkbook.mockResolvedValue({});
  h.writeBuffer.mockResolvedValue(Buffer.from('xlsx'));
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
  const period = { month: '2026-07', rangeArg: { startDate: '2026-07-01', endDate: '2026-07-31' } as const };

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
    expect(h.slice.mock.calls[0].slice(1)).toEqual([[1, 3], 'бр. Первая', 'D1']);
    expect(h.slice.mock.calls[1].slice(1)).toEqual([[2], 'бр. Вторая', 'D2']);
  });

  it('сотрудники без отдела попадают в бакет «Без названия», null в SQL не уходит', async () => {
    h.pgQuery.mockResolvedValue([{ id: 'D1', name: 'бр. Первая' }]);
    await buildUnified1CBuffer({
      ...period,
      memberByEmp: new Map([[1, 'D1'], [2, null]]),
      exemptEmployeeIds: new Set(),
    });

    expect(h.pgQuery.mock.calls[0][1]).toEqual([['D1']]);
    expect(h.slice.mock.calls[1].slice(1)).toEqual([[2], 'Без названия', null]);
  });

  it('отдел отсутствует в org_departments → «Без названия»', async () => {
    h.pgQuery.mockResolvedValue([]);
    await buildUnified1CBuffer({
      ...period,
      memberByEmp: new Map([[1, 'D-ghost']]),
      exemptEmployeeIds: new Set(),
    });

    expect(h.slice.mock.calls[0].slice(1)).toEqual([[1], 'Без названия', 'D-ghost']);
  });

  it('mon/year выводятся из month, а не приходят снаружи', async () => {
    await buildUnified1CBuffer({
      month: '2026-02',
      rangeArg: { startDate: '2026-02-01', endDate: '2026-02-28' },
      memberByEmp: new Map([[1, 'D1']]),
      exemptEmployeeIds: new Set(),
    });

    expect(h.buildWorkbook).toHaveBeenCalledWith(2, 2026, expect.any(Array));
  });
});
