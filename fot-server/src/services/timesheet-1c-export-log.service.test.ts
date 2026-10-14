import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Request } from 'express';

const h = vi.hoisted(() => ({ clientQuery: vi.fn() }));
vi.mock('../config/postgres.js', () => ({
  withTransaction: vi.fn(async (fn: (client: { query: typeof h.clientQuery }) => Promise<unknown>) =>
    fn({ query: h.clientQuery })),
}));

import {
  classifyDepartmentCandidates,
  classifyObjectCandidates,
  recordUnified1CExport,
  serializeUnifiedRowsForLog,
} from './timesheet-1c-export-log.service.js';
import type { IUnifiedRow } from './timesheet-1c-unified.service.js';
import type { IScopedMembershipCandidate } from './timesheet-department-assignments.service.js';
import { createObjectsExportTrace } from './timesheet-objects-export.service.js';

const D1 = '11111111-1111-4111-8111-111111111111';
const D2 = '22222222-2222-4222-8222-222222222222';

const candidate = (
  employeeId: number,
  over: Partial<IScopedMembershipCandidate> = {},
): IScopedMembershipCandidate => ({
  employeeId,
  departmentId: D1,
  source: 'assignment',
  notArchived: true,
  firedEligible: true,
  notExcluded: true,
  ...over,
});

const unifiedRow = (employeeId: number, over: Partial<IUnifiedRow> = {}): IUnifiedRow => ({
  oneCRow: {
    employeeId,
    fullName: `Сотрудник ${employeeId}`,
    dayValues: new Map([[1, { hours: 8, isUnderwork: false }]]),
    totalHours: 8,
    workedDays: 1,
  },
  departmentName: 'Отдел',
  objectAddress: 'ЖК Сад',
  managerName: 'Начальник',
  position: 'Монтажник',
  departmentId: D1,
  objectId: null,
  departmentNameSort: 'Отдел',
  departmentIdSort: D1,
  fullNameSort: `Сотрудник ${employeeId}`,
  employeeIdSort: employeeId,
  objectNameSort: '',
  objectKeySort: '',
  ...over,
});

describe('serializeUnifiedRowsForLog', () => {
  it('номер строки Excel от 4-й, не-uuid отдела/объекта → null, нулевые итоги → null', () => {
    const rows = serializeUnifiedRowsForLog([
      unifiedRow(1),
      unifiedRow(1, {
        departmentId: 'not-a-uuid',
        objectId: D2,
        managerName: undefined,
        position: undefined,
        oneCRow: {
          employeeId: 1,
          fullName: '+7 Прохоров',
          dayValues: new Map([
            [1, { hours: 0, isUnderwork: false, isWeekend: true }],
            [2, { hours: 0, label: 'Б', isUnderwork: false }],
            [3, { hours: 0, isUnderwork: false }],
            [40, { hours: 5, isUnderwork: false }],
          ]),
          totalHours: 0,
          workedDays: 0,
        },
      }),
    ]);

    expect(rows[0]).toMatchObject({ excel_row: 4, department_id: D1, days: { 1: 8 }, total_hours: 8, worked_days: 1 });
    expect(rows[1]).toEqual({
      excel_row: 5,
      employee_id: 1,
      full_name: "'+7 Прохоров",
      department_id: null,
      department_name: 'Отдел',
      object_id: D2,
      object_address: 'ЖК Сад',
      manager_name: '',
      position: '',
      // Пустой выходной и день вне 1..31 в файл не пишутся; 0 ч в будни — пишется.
      days: { 2: 'Б', 3: 0 },
      total_hours: null,
      worked_days: null,
    });
  });
});

describe('classifyDepartmentCandidates — этап отсева «По отделам»', () => {
  const base = {
    roster: { ineligibleIds: [] as number[], zeroActivityIds: [] as number[] },
    bucketedEmployeeIds: new Set<number>(),
    dataEmployeeIds: new Set<number>(),
    rowEmployeeIds: new Set<number>(),
  };

  it('уволенный, архивный и исключённый из табеля — по флагам, а не «нет в составе»', () => {
    const result = classifyDepartmentCandidates({
      ...base,
      candidates: [
        candidate(1, { firedEligible: false, source: 'dismissal' }),
        candidate(2, { notArchived: false, firedEligible: false }),
        candidate(3, { notExcluded: false }),
        candidate(4),
      ],
      memberByEmp: new Map(),
    });

    expect(result).toEqual([
      { employee_id: 1, department_id: D1, sources: ['dismissal'], drop_stage: 'fired' },
      { employee_id: 2, department_id: D1, sources: ['assignment'], drop_stage: 'archived' },
      { employee_id: 3, department_id: D1, sources: ['assignment'], drop_stage: 'excluded_from_timesheet' },
      // Допущен по флагам, но в составе выгрузки нет — расхождение запросов.
      { employee_id: 4, department_id: D1, sources: ['assignment'], drop_stage: 'not_in_membership' },
    ]);
  });

  it('этапы после членства: перевод, фильтр статуса, нет активности, пустая строка, в файле', () => {
    const members = new Map<number, string | null>([[10, D1], [11, D1], [12, D1], [13, D2], [14, D2]]);
    const result = classifyDepartmentCandidates({
      candidates: [10, 11, 12, 13, 14].map(id => candidate(id)),
      memberByEmp: members,
      bucketedEmployeeIds: new Set([11, 12, 13, 14]),
      roster: { ineligibleIds: [11], zeroActivityIds: [12] },
      dataEmployeeIds: new Set([13, 14]),
      rowEmployeeIds: new Set([14]),
    });

    expect(result.map(c => [c.employee_id, c.drop_stage])).toEqual([
      [10, 'transfer_out_of_scope'],
      [11, 'fired_or_archived'],
      [12, 'zero_activity'],
      [13, 'no_row'],
      [14, null],
    ]);
    // Отдел — из состава выгрузки.
    expect(result.find(c => c.employee_id === 13)?.department_id).toBe(D2);
  });

  it('состав выгрузки главнее флагов снимка; кто есть только в составе — источник membership', () => {
    const result = classifyDepartmentCandidates({
      candidates: [candidate(20, { firedEligible: false })],
      memberByEmp: new Map<number, string | null>([[20, D1], [21, D2]]),
      bucketedEmployeeIds: new Set([20, 21]),
      roster: { ineligibleIds: [], zeroActivityIds: [] },
      dataEmployeeIds: new Set([20, 21]),
      rowEmployeeIds: new Set([20, 21]),
    });

    expect(result).toEqual([
      { employee_id: 20, department_id: D1, sources: ['assignment'], drop_stage: null },
      { employee_id: 21, department_id: D2, sources: ['membership'], drop_stage: null },
    ]);
  });
});

describe('classifyObjectCandidates — этап отсева «По объектам»', () => {
  it('отсеянный фильтром активности остаётся в снимке; группа, фильтр отдела, руководитель', () => {
    const trace = createObjectsExportTrace();
    trace.sourcesByEmployee.set(1, new Set(['object_pinned', 'object_events']));
    trace.sourcesByEmployee.set(2, new Set(['object_events']));
    trace.sourcesByEmployee.set(3, new Set(['object_events']));
    trace.sourcesByEmployee.set(4, new Set(['department_manager']));
    trace.sourcesByEmployee.set(5, new Set(['object_events']));
    trace.sourcesByEmployee.set(6, new Set(['object_events']));
    // 2 не попал в группы (архивный / исключён из табеля).
    for (const id of [1, 3, 4, 5, 6]) trace.departmentByEmployee.set(id, id === 3 ? D2 : D1);
    trace.departmentFilteredIds.push(3);
    trace.roster.ineligibleIds.push(5);
    trace.roster.zeroActivityIds.push(6);

    const result = classifyObjectCandidates({ trace, rowEmployeeIds: new Set([1]) });

    expect(result).toEqual([
      { employee_id: 1, department_id: D1, sources: ['object_events', 'object_pinned'], drop_stage: null },
      { employee_id: 2, department_id: null, sources: ['object_events'], drop_stage: 'archived_or_excluded' },
      { employee_id: 3, department_id: D2, sources: ['object_events'], drop_stage: 'department_filter' },
      { employee_id: 4, department_id: D1, sources: ['department_manager'], drop_stage: 'no_row' },
      { employee_id: 5, department_id: D1, sources: ['object_events'], drop_stage: 'fired_or_archived' },
      { employee_id: 6, department_id: D1, sources: ['object_events'], drop_stage: 'zero_activity' },
    ]);
  });

  it('сотрудник из строк файла, которого нет в снимке, добавляется без этапа', () => {
    const result = classifyObjectCandidates({ trace: createObjectsExportTrace(), rowEmployeeIds: new Set([9]) });
    expect(result).toEqual([{ employee_id: 9, department_id: null, sources: [], drop_stage: null }]);
  });
});

describe('recordUnified1CExport', () => {
  const req = { ip: '10.0.0.1', socket: {}, headers: { 'user-agent': 'UA' } } as unknown as Request;
  const entry = {
    source: 'hr_departments' as const,
    month: '2026-10',
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    departmentIds: [D1, 'bad', D1],
    fileName: 'Единый_1С_Октябрь_2026.xlsx',
    buffer: Buffer.from('xlsx'),
    rows: [unifiedRow(1), unifiedRow(1, { objectId: D2 }), unifiedRow(2)],
    candidates: [{ employee_id: 1, department_id: D1, sources: ['assignment' as const], drop_stage: null }],
  };

  beforeEach(() => {
    h.clientQuery.mockReset();
    h.clientQuery.mockResolvedValueOnce({ rows: [{ id: 'export-1' }] }).mockResolvedValue({ rows: [] });
  });

  it('шапка, строки и кандидаты — в одной транзакции; месяц — первое число, sha256 файла', async () => {
    const id = await recordUnified1CExport(req, 'user-1', entry);

    expect(id).toBe('export-1');
    expect(h.clientQuery).toHaveBeenCalledTimes(3);
    const headerParams = h.clientQuery.mock.calls[0][1] as unknown[];
    expect(headerParams.slice(0, 8)).toEqual(['user-1', 'hr_departments', '2026-10-01', '2026-10-01', '2026-10-31', [D1], [], []]);
    expect(headerParams[9]).toBe(createHash('sha256').update('xlsx').digest('hex'));
    // file_bytes, row_count, employee_count (уникальные), candidate_count, ip, UA
    expect(headerParams.slice(10)).toEqual([4, 3, 2, 1, '10.0.0.1', 'UA']);

    expect(String(h.clientQuery.mock.calls[1][0])).toContain('INSERT INTO timesheet_1c_export_log_rows');
    const rowsJson = JSON.parse(h.clientQuery.mock.calls[1][1][1] as string);
    expect(rowsJson.map((r: { excel_row: number }) => r.excel_row)).toEqual([4, 5, 6]);
    expect(String(h.clientQuery.mock.calls[2][0])).toContain('INSERT INTO timesheet_1c_export_log_candidates');
  });

  it('пустые строки и кандидаты — только шапка', async () => {
    await recordUnified1CExport(req, 'user-1', { ...entry, rows: [], candidates: [] });
    expect(h.clientQuery).toHaveBeenCalledTimes(1);
  });

  it('некорректный месяц — ошибка до записи', async () => {
    await expect(recordUnified1CExport(req, 'user-1', { ...entry, month: '2026-10-01' })).rejects.toThrow('месяц');
    expect(h.clientQuery).not.toHaveBeenCalled();
  });
});
