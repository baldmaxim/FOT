import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

// Гейт excludeZeroActivity: /export-mass пробрасывает опцию ТОЛЬКО при
// export_as_1c=true («Как в 1С»), /export-mass-unified — всегда.

const h = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  fetchDept: vi.fn(),
  fetchEmps: vi.fn(),
  supervisorsBulk: vi.fn(),
  buildUnified: vi.fn(),
  segments: vi.fn(async () => new Map()),
  candidates: vi.fn(),
  record: vi.fn(),
  classifyDept: vi.fn(),
  classifyObj: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({ query: h.pgQuery, queryOne: vi.fn() }));
vi.mock('exceljs', () => ({ default: { Workbook: class Workbook {} } }));
vi.mock('archiver', () => ({
  default: vi.fn(() => ({
    pipe: vi.fn(),
    append: vi.fn(),
    finalize: vi.fn(async () => undefined),
  })),
}));
vi.mock('../services/data-scope.service.js', () => ({
  resolveRequestDataScope: vi.fn(async () => 'all'),
  resolveScopedDepartmentIds: vi.fn(async (_req: unknown, ids: string[]) => ids),
  resolveWritableScopedDepartmentIds: vi.fn(async (_req: unknown, ids: string[]) => ids),
}));
vi.mock('../services/timesheet-export.service.js', () => ({
  fetchTimesheetDataForDepartment: h.fetchDept,
  fetchTimesheetDataForEmployees: h.fetchEmps,
  sliceTimesheetDataByEmployees: vi.fn((bulk: unknown) => bulk),
}));
vi.mock('../services/timesheet-department-assignments.service.js', () => ({
  listScopedMembersByDepartment: vi.fn(async () => new Map([[1, 'D1']])),
  listScopedMembershipCandidates: h.candidates,
  resolveTransferSegmentsInPeriod: h.segments,
  resolveTimesheetDateRange: vi.fn(),
  resolveTimesheetPeriodRange: vi.fn(() => ({
    year: 2026,
    month: 7,
    daysInMonth: 31,
    startDate: '2026-07-01',
    endDate: '2026-07-31',
  })),
}));
vi.mock('../services/timesheet-excel.service.js', () => ({
  build1CObjectTimesheetWorkbook: vi.fn(async () => ({})),
  build1CTimesheetWorkbook: vi.fn(async () => ({})),
  buildObjectTimesheetSheet: vi.fn(),
  buildTimesheetSheet: vi.fn(),
  listObjectExportTargets: vi.fn(() => []),
  sanitizeSheetName: vi.fn((name: string) => name),
  writeTimesheetWorkbookBuffer: vi.fn(async () => Buffer.from('xlsx')),
}));
vi.mock('../services/timesheet-1c-unified.service.js', () => ({
  buildUnified1CWorkbookWithRows: h.buildUnified,
}));
vi.mock('../services/timesheet-objects-export.service.js', () => ({
  createObjectsExportTrace: vi.fn(() => ({ marker: 'objects-trace' })),
  fetchTimesheetDataForObjectIds: vi.fn(async () => []),
}));
vi.mock('../services/timesheet-1c-export-log.service.js', () => ({
  recordUnified1CExport: h.record,
  classifyDepartmentCandidates: h.classifyDept,
  classifyObjectCandidates: h.classifyObj,
}));
vi.mock('./timesheet-assigned-export.controller.js', () => ({
  listBrigadeSupervisorEmployeeIdsForDepartments: h.supervisorsBulk,
}));

import {
  exportTimesheetMass,
  exportTimesheetMassUnified,
  exportTimesheetObjectsUnified,
} from './timesheet-mass-export.controller.js';

const deptData = {
  departmentName: 'бр. Тестовая',
  departmentId: 'D1',
  isBrigade: true,
  employees: [],
  entries: [],
  objectEntries: [],
  dataMap: new Map(),
  schedulesMap: new Map(),
  dailySchedulesMap: new Map(),
  calendarMonth: null,
  skudMap: new Map(),
  posMap: new Map(),
  year: 2026,
  mon: 7,
  daysInMonth: 31,
  exportHalf: 'FULL',
  exportDays: [1],
  showActualHours: true,
  cutoffByEmployeeId: new Map(),
};

const UNIFIED_ROWS = [{ oneCRow: { employeeId: 1 } }];

function makeReq(body: Record<string, unknown>): AuthenticatedRequest {
  return {
    params: {},
    query: {},
    body: { month: '2026-07', department_ids: ['D1'], ...body },
    user: { id: 'admin', is_admin: true },
  } as unknown as AuthenticatedRequest;
}

function makeRes(): Response {
  return {
    headersSent: false,
    setHeader: vi.fn(),
    end: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.pgQuery.mockResolvedValue([{ id: 'D1', name: 'бр. Тестовая' }]);
  h.fetchDept.mockResolvedValue(deptData);
  h.fetchEmps.mockResolvedValue(deptData);
  h.supervisorsBulk.mockResolvedValue(new Set([9]));
  h.buildUnified.mockResolvedValue({ workbook: {}, rows: UNIFIED_ROWS });
  h.candidates.mockResolvedValue([{ employeeId: 1, departmentId: 'D1', source: 'assignment' }]);
  h.record.mockResolvedValue('export-id');
  h.classifyDept.mockReturnValue([{ employee_id: 1, drop_stage: null }]);
  h.classifyObj.mockReturnValue([{ employee_id: 5, drop_stage: 'zero_activity' }]);
});

describe('exportTimesheetMass — опция excludeZeroActivity только при «Как в 1С»', () => {
  it('export_as_1c=true → options с фильтром и exempt-начальниками', async () => {
    await exportTimesheetMass(makeReq({ export_as_1c: true }), makeRes());

    expect(h.supervisorsBulk).toHaveBeenCalledWith(['D1']);
    expect(h.fetchDept).toHaveBeenCalledTimes(1);
    const options = h.fetchDept.mock.calls[0][5];
    expect(options).toEqual({
      excludeZeroActivity: true,
      exemptEmployeeIds: new Set([9]),
    });
  });

  it('без «Как в 1С» (Факт/урезанный) → options не передаются, состав полный', async () => {
    await exportTimesheetMass(makeReq({}), makeRes());

    expect(h.fetchDept).toHaveBeenCalledTimes(1);
    expect(h.fetchDept.mock.calls[0][5]).toBeUndefined();
    expect(h.supervisorsBulk).not.toHaveBeenCalled();
  });

  it('export_as_1c=true + presentation=manager → фильтр всё равно активен', async () => {
    await exportTimesheetMass(makeReq({ export_as_1c: true, presentation: 'manager' }), makeRes());

    const options = h.fetchDept.mock.calls[0][5];
    expect(options?.excludeZeroActivity).toBe(true);
  });
});

describe('exportTimesheetMassUnified — фильтр всегда активен', () => {
  it('bulk-вызов получает excludeZeroActivity + объединение начальников выбранных отделов', async () => {
    await exportTimesheetMassUnified(makeReq({}), makeRes());

    expect(h.supervisorsBulk).toHaveBeenCalledWith(['D1']);
    expect(h.fetchEmps).toHaveBeenCalledTimes(1);
    const call = h.fetchEmps.mock.calls[0];
    expect(call[1]).toEqual([1]); // членство выбранных отделов
    expect(call[6]).toEqual({
      excludeZeroActivity: true,
      exemptEmployeeIds: new Set([9]),
      trace: { ineligibleIds: [], zeroActivityIds: [] },
    });
  });
});

describe('журнал выгрузок «Единый файл для 1С»', () => {
  it('«По отделам»: журнал пишется до заголовков ответа — с периодом, отделами и кандидатами', async () => {
    const res = makeRes();
    await exportTimesheetMassUnified(makeReq({}), res);

    expect(h.candidates).toHaveBeenCalledWith(['D1'], '2026-07-01', '2026-07-31');
    expect(h.classifyDept).toHaveBeenCalledWith(expect.objectContaining({
      candidates: [{ employeeId: 1, departmentId: 'D1', source: 'assignment' }],
      memberByEmp: new Map([[1, 'D1']]),
      rowEmployeeIds: new Set([1]),
      roster: { ineligibleIds: [], zeroActivityIds: [] },
    }));
    expect(h.record).toHaveBeenCalledTimes(1);
    const [, userId, entry] = h.record.mock.calls[0];
    expect(userId).toBe('admin');
    expect(entry).toMatchObject({
      source: 'hr_departments',
      month: '2026-07',
      periodStart: '2026-07-01',
      periodEnd: '2026-07-31',
      departmentIds: ['D1'],
      rows: UNIFIED_ROWS,
      candidates: [{ employee_id: 1, drop_stage: null }],
    });
    expect(entry.fileName).toMatch(/^Единый_1С_Июль_2026/);
    expect(Buffer.isBuffer(entry.buffer)).toBe(true);

    const setHeader = vi.mocked(res.setHeader);
    expect(h.record.mock.invocationCallOrder[0]).toBeLessThan(setHeader.mock.invocationCallOrder[0]);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('«По объектам»: журнал с объектами, фильтром отделов и снимком отбора', async () => {
    const res = makeRes();
    await exportTimesheetObjectsUnified(makeReq({ object_ids: ['O1', 'O2', 'O1'] }), res);

    expect(h.classifyObj).toHaveBeenCalledWith({
      trace: { marker: 'objects-trace' },
      rowEmployeeIds: new Set([1]),
    });
    const [, , entry] = h.record.mock.calls[0];
    expect(entry).toMatchObject({
      source: 'hr_objects',
      month: '2026-07',
      periodStart: '2026-07-01',
      periodEnd: '2026-07-31',
      objectIds: ['O1', 'O2'],
      departmentFilterIds: ['D1'],
      candidates: [{ employee_id: 5, drop_stage: 'zero_activity' }],
    });
    expect(h.record.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(res.setHeader).mock.invocationCallOrder[0]);
  });

  it.each([
    ['«По отделам»', () => exportTimesheetMassUnified],
    ['«По объектам»', () => exportTimesheetObjectsUnified],
  ])('%s: журнал не записался → 500, файл и заголовки не отдаются', async (_label, handler) => {
    h.record.mockRejectedValue(new Error('db down'));
    const res = makeRes();
    await handler()(makeReq({ object_ids: ['O1'] }), res);

    expect(res.setHeader).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('exportTimesheetObjectsUnified — закреплённые за объектами попадают в файл', () => {
  it('в сборку уходит политика с запрошенными объектами (без дублей)', async () => {
    await exportTimesheetObjectsUnified(makeReq({ object_ids: ['O1', 'O2', 'O1'] }), makeRes());

    expect(h.buildUnified).toHaveBeenCalledTimes(1);
    expect(h.buildUnified.mock.calls[0][3]).toEqual({ pinnedObjectIds: new Set(['O1', 'O2']) });
  });
});
