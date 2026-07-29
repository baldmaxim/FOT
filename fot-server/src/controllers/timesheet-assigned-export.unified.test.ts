import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

// Экспорт единого файла 1С по участку: гейт режима, прямые подчинённые из
// employee_direct_reports (а не пустой user_employee_access), их периодный отдел
// и обязательная проверка доступа к добавляемым сверх бригад сотрудникам.

const h = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  scope: vi.fn(),
  filterVisible: vi.fn(),
  filterAdditional: vi.fn(),
  members: vi.fn(),
  deptByEmp: vi.fn(),
  directInPeriod: vi.fn(),
  collectDeptIds: vi.fn(),
  scopedDeptIds: vi.fn(),
  isTimekeeper: vi.fn(),
  buildBuffer: vi.fn(),
  hasPageView: vi.fn(),
  hasPageEdit: vi.fn(),
  requestScope: vi.fn(),
  managedDeptIds: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({ query: h.pgQuery, queryOne: vi.fn() }));
vi.mock('exceljs', () => ({ default: { Workbook: class Workbook {} } }));
vi.mock('archiver', () => ({ default: vi.fn() }));
vi.mock('../services/mailer.service.js', () => ({ mailerService: { send: vi.fn() } }));
vi.mock('../services/local-auth.service.js', () => ({ localAuthService: {} }));
vi.mock('../services/timesheet-export.service.js', () => ({
  fetchTimesheetDataForDepartment: vi.fn(),
  fetchTimesheetDataForEmployees: vi.fn(),
}));
vi.mock('../services/timesheet-excel.service.js', () => ({
  build1CObjectTimesheetWorkbook: vi.fn(),
  build1CTimesheetWorkbook: vi.fn(),
  buildObjectTimesheetSheet: vi.fn(),
  buildTimesheetSheet: vi.fn(),
  listObjectExportTargets: vi.fn(() => []),
  sanitizeSheetName: vi.fn((v: string) => v),
  writeTimesheetWorkbookBuffer: vi.fn(),
}));
vi.mock('../services/access-control.service.js', () => ({
  hasPageView: h.hasPageView,
  hasPageEdit: h.hasPageEdit,
}));
vi.mock('../services/data-scope.service.js', () => ({
  resolveRequestDataScope: h.requestScope,
  resolveManagedDepartmentIds: h.managedDeptIds,
  resolveScopedDepartmentIds: h.scopedDeptIds,
}));
vi.mock('../services/skud-shared.service.js', () => ({ collectDeptIds: h.collectDeptIds }));
vi.mock('../services/timekeeper-scope.service.js', () => ({ isTimekeeper: h.isTimekeeper }));
vi.mock('../services/employee-direct-reports.service.js', () => ({
  listDirectReportIdsInPeriod: h.directInPeriod,
}));
vi.mock('../services/timesheet-department-assignments.service.js', () => ({
  listScopedMembersByDepartment: h.members,
  resolveDepartmentIdsForEmployeesInPeriod: h.deptByEmp,
}));
vi.mock('../services/timesheet-scope.service.js', () => ({
  resolveTimesheetScope: h.scope,
  filterEmployeeIdsByTimesheetScope: h.filterVisible,
  filterAdditionalEmployeeIdsForTimesheetPeriod: h.filterAdditional,
}));
vi.mock('../services/timesheet-unified-export.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/timesheet-unified-export.service.js')>()),
  buildUnified1CBuffer: h.buildBuffer,
}));

import { exportTimesheetAssignedUnified } from './timesheet-assigned-export.controller.js';

const BRIGADE = 'aaaaaaaa-1111-2222-3333-444444444444';
const ASSIGNEE = 100;

function makeReq(body: Record<string, unknown> = {}, user: Record<string, unknown> = {}): AuthenticatedRequest {
  return {
    params: {},
    query: {},
    body: { assignee_employee_id: ASSIGNEE, month: '2026-07', from: '2026-07-01', to: '2026-07-31', ...body },
    user: { id: 'u1', is_admin: true, role_code: 'admin', employee_id: 500, ...user },
  } as unknown as AuthenticatedRequest;
}

function makeRes(): Response & { statusCode?: number } {
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn(),
    status: vi.fn(function (this: Response & { statusCode?: number }, code: number) {
      this.statusCode = code;
      return this;
    }),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & { statusCode?: number };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.scope.mockResolvedValue('all');
  h.requestScope.mockResolvedValue('all');
  h.managedDeptIds.mockResolvedValue([BRIGADE]);
  h.isTimekeeper.mockReturnValue(false);
  h.hasPageView.mockResolvedValue(true);
  h.hasPageEdit.mockResolvedValue(true);
  h.collectDeptIds.mockResolvedValue([BRIGADE]);
  h.scopedDeptIds.mockImplementation(async (_req: unknown, ids: string[]) => ids);
  h.members.mockResolvedValue(new Map([[1, BRIGADE]]));
  h.directInPeriod.mockResolvedValue([]);
  h.deptByEmp.mockResolvedValue(new Map());
  h.filterAdditional.mockImplementation(async (_req: unknown, ids: number[]) => ids);
  h.filterVisible.mockImplementation(async (_req: unknown, ids: number[]) => ids);
  h.buildBuffer.mockResolvedValue(Buffer.from('xlsx'));
  // collectAssignedEmployees: eda-строки (начальник + его бригада), затем uea-строки.
  h.pgQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('employee_department_access')) {
      return [{ employee_id: ASSIGNEE, department_id: BRIGADE, full_name: 'Киличов Шухрат Рахимович', email: null }];
    }
    return [];
  });
});

describe('exportTimesheetAssignedUnified — гейт режима', () => {
  it('без monitor/review и не табельщица → 403', async () => {
    h.hasPageView.mockResolvedValue(false);
    h.hasPageEdit.mockResolvedValue(false);
    const res = makeRes();
    await exportTimesheetAssignedUnified(
      makeReq({}, { is_admin: false, role_code: 'site_supervisor', employee_id: 500 }),
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(h.buildBuffer).not.toHaveBeenCalled();
  });

  it('нецелый assignee_employee_id → 400', async () => {
    const res = makeRes();
    await exportTimesheetAssignedUnified(makeReq({ assignee_employee_id: 'abc' }), res);

    expect(res.statusCode).toBe(400);
    expect(h.buildBuffer).not.toHaveBeenCalled();
  });

  it('начальник вне доступного списка → 403', async () => {
    h.pgQuery.mockResolvedValue([]);
    const res = makeRes();
    await exportTimesheetAssignedUnified(makeReq(), res);

    expect(res.statusCode).toBe(403);
    expect(h.buildBuffer).not.toHaveBeenCalled();
  });
});

describe('exportTimesheetAssignedUnified — состав участка', () => {
  it('бригады раскрываются до листьев и пересекаются со скоупом', async () => {
    h.collectDeptIds.mockResolvedValue([BRIGADE, 'child-1']);
    await exportTimesheetAssignedUnified(makeReq(), makeRes());

    expect(h.collectDeptIds).toHaveBeenCalledWith(BRIGADE);
    expect(h.scopedDeptIds).toHaveBeenCalledWith(expect.anything(), [BRIGADE, 'child-1']);
    expect(h.members).toHaveBeenCalledWith([BRIGADE, 'child-1'], '2026-07-01', '2026-07-31');
  });

  it('прямые подчинённые берутся периодным запросом и получают ИСТОРИЧЕСКИЙ отдел', async () => {
    h.directInPeriod.mockResolvedValue([42]);
    h.deptByEmp.mockResolvedValue(new Map([[42, 'old-dept']]));
    await exportTimesheetAssignedUnified(makeReq(), makeRes());

    expect(h.directInPeriod).toHaveBeenCalledWith(ASSIGNEE, '2026-07-01', '2026-07-31');
    expect(h.deptByEmp).toHaveBeenCalledWith([42], '2026-07-01', '2026-07-31');
    expect(h.buildBuffer.mock.calls[0][0].memberByEmp).toEqual(new Map([[1, BRIGADE], [42, 'old-dept']]));
  });

  it('прямой вне scope вызывающего в файл не попадает', async () => {
    h.directInPeriod.mockResolvedValue([42, 43]);
    h.filterAdditional.mockResolvedValue([42]);
    h.deptByEmp.mockResolvedValue(new Map([[42, 'D-42']]));
    await exportTimesheetAssignedUnified(makeReq(), makeRes());

    expect(h.filterAdditional).toHaveBeenCalledWith(expect.anything(), [42, 43], '2026-07-01', '2026-07-31');
    expect(h.buildBuffer.mock.calls[0][0].memberByEmp.has(43)).toBe(false);
  });

  it('прямой, уже входящий в бригаду, не дублируется и не переопределяет отдел', async () => {
    h.directInPeriod.mockResolvedValue([1]);
    await exportTimesheetAssignedUnified(makeReq(), makeRes());

    expect(h.filterAdditional).not.toHaveBeenCalled();
    expect(h.buildBuffer.mock.calls[0][0].memberByEmp).toEqual(new Map([[1, BRIGADE]]));
  });

  it('прямой без eligibility (нет ключа в периодной карте) отбрасывается', async () => {
    h.directInPeriod.mockResolvedValue([42]);
    h.deptByEmp.mockResolvedValue(new Map());
    await exportTimesheetAssignedUnified(makeReq(), makeRes());

    expect(h.buildBuffer.mock.calls[0][0].memberByEmp.has(42)).toBe(false);
  });

  it('object/view-фильтр применяется к ОБЪЕДИНЁННОМУ составу', async () => {
    h.directInPeriod.mockResolvedValue([42]);
    h.deptByEmp.mockResolvedValue(new Map([[42, 'D-42']]));
    h.filterVisible.mockResolvedValue([42]);
    await exportTimesheetAssignedUnified(makeReq(), makeRes());

    expect(h.filterVisible).toHaveBeenCalledWith(expect.anything(), [1, 42], expect.any(Set));
    expect(h.buildBuffer.mock.calls[0][0].memberByEmp).toEqual(new Map([[42, 'D-42']]));
  });

  it('пустой состав → 422', async () => {
    h.members.mockResolvedValue(new Map());
    const res = makeRes();
    await exportTimesheetAssignedUnified(makeReq(), res);

    expect(res.statusCode).toBe(422);
    expect(h.buildBuffer).not.toHaveBeenCalled();
  });
});

describe('exportTimesheetAssignedUnified — режим «Мои сотрудники»', () => {
  it('self-ветка не обращается к списку начальников и к их бригадам', async () => {
    h.directInPeriod.mockResolvedValue([42]);
    h.deptByEmp.mockResolvedValue(new Map([[42, 'D-42']]));
    await exportTimesheetAssignedUnified(
      makeReq({ assignee_employee_id: 500 }, { is_admin: false, role_code: 'manager', employee_id: 500 }),
      makeRes(),
    );

    expect(h.collectDeptIds).not.toHaveBeenCalled();
    expect(h.members).not.toHaveBeenCalled();
    expect(h.buildBuffer.mock.calls[0][0].memberByEmp).toEqual(new Map([[42, 'D-42']]));
    expect(h.buildBuffer.mock.calls[0][0].exemptEmployeeIds).toEqual(new Set());
  });

  it('self-ветка доступна без monitor/review', async () => {
    h.hasPageView.mockResolvedValue(false);
    h.hasPageEdit.mockResolvedValue(false);
    h.directInPeriod.mockResolvedValue([42]);
    h.deptByEmp.mockResolvedValue(new Map([[42, 'D-42']]));
    const res = makeRes();
    await exportTimesheetAssignedUnified(
      makeReq({ assignee_employee_id: 500 }, { is_admin: false, role_code: 'manager', employee_id: 500 }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(h.buildBuffer).toHaveBeenCalledTimes(1);
  });
});
