import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

// Экспорт единого файла 1С по отделу со страницы «Табель»: скоуп, ветка табельщицы
// на «ЛИНИЯ-Общестрой», строгий период и объектный view-фильтр.

const h = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  scopedDeptIds: vi.fn(),
  collectDeptIds: vi.fn(),
  members: vi.fn(),
  deptByEmp: vi.fn(),
  scope: vi.fn(),
  scopedDeptId: vi.fn(),
  filterVisible: vi.fn(),
  isTimekeeper: vi.fn(),
  liPresence: vi.fn(),
  buildBuffer: vi.fn(),
  supervisors: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({ query: h.pgQuery, queryOne: vi.fn() }));
vi.mock('../services/data-scope.service.js', () => ({ resolveScopedDepartmentIds: h.scopedDeptIds }));
vi.mock('../services/skud-shared.service.js', () => ({ collectDeptIds: h.collectDeptIds }));
vi.mock('../services/timesheet-department-assignments.service.js', () => ({
  listScopedMembersByDepartment: h.members,
  resolveDepartmentIdsForEmployeesInPeriod: h.deptByEmp,
}));
vi.mock('../services/timesheet-scope.service.js', () => ({
  resolveTimesheetScope: h.scope,
  resolveTimesheetScopedDepartmentId: h.scopedDeptId,
  filterEmployeeIdsByTimesheetScope: h.filterVisible,
}));
vi.mock('../services/timekeeper-scope.service.js', () => ({
  isTimekeeper: h.isTimekeeper,
  resolveTimekeeperLiObshestroyPresenceIds: h.liPresence,
  LI_OBSHESTROY_DEPARTMENT_ID: '0b24809e-5f04-45e1-bbe2-8a82990d6bdd',
}));
vi.mock('../services/timesheet-unified-export.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/timesheet-unified-export.service.js')>()),
  buildUnified1CBuffer: h.buildBuffer,
}));
vi.mock('./timesheet-assigned-export.controller.js', () => ({
  listBrigadeSupervisorEmployeeIdsForDepartments: h.supervisors,
}));

import { exportTimesheetDepartmentUnified } from './timesheet-department-export.controller.js';

const DEPT = '11111111-2222-3333-4444-555555555555';
const LI = '0b24809e-5f04-45e1-bbe2-8a82990d6bdd';

function makeReq(body: Record<string, unknown> = {}, user: Record<string, unknown> = {}): AuthenticatedRequest {
  return {
    params: {},
    query: {},
    body: { department_id: DEPT, month: '2026-07', from: '2026-07-01', to: '2026-07-31', ...body },
    user: { id: 'u1', is_admin: true, role_code: 'admin', ...user },
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
  h.pgQuery.mockResolvedValue([{ name: 'бр. Тестовая' }]);
  h.scope.mockResolvedValue('all');
  h.scopedDeptId.mockImplementation(async (_req: unknown, id: string) => id);
  h.collectDeptIds.mockResolvedValue([DEPT, 'child-1']);
  h.scopedDeptIds.mockImplementation(async (_req: unknown, ids: string[]) => ids);
  h.members.mockResolvedValue(new Map([[1, DEPT], [2, 'child-1']]));
  h.deptByEmp.mockResolvedValue(new Map([[7, DEPT]]));
  h.filterVisible.mockImplementation(async (_req: unknown, ids: number[]) => ids);
  h.isTimekeeper.mockReturnValue(false);
  h.liPresence.mockResolvedValue(new Set([7]));
  h.supervisors.mockResolvedValue(new Set([9]));
  h.buildBuffer.mockResolvedValue(Buffer.from('xlsx'));
});

describe('exportTimesheetDepartmentUnified — доступ и период', () => {
  it('невалидный UUID отдела → 400, резолвер не вызывается (иначе подменит первым доступным)', async () => {
    const res = makeRes();
    await exportTimesheetDepartmentUnified(makeReq({ department_id: 'не-uuid' }), res);

    expect(res.statusCode).toBe(400);
    expect(h.scopedDeptId).not.toHaveBeenCalled();
    expect(h.buildBuffer).not.toHaveBeenCalled();
  });

  it('резолвер вернул другой отдел → 403', async () => {
    h.scopedDeptId.mockResolvedValue('99999999-2222-3333-4444-555555555555');
    const res = makeRes();
    await exportTimesheetDepartmentUnified(makeReq(), res);

    expect(res.statusCode).toBe(403);
    expect(h.buildBuffer).not.toHaveBeenCalled();
  });

  it('невалидный период → 400 без отката на полный месяц', async () => {
    const res = makeRes();
    await exportTimesheetDepartmentUnified(makeReq({ from: '2026-07-31', to: '2026-07-01' }), res);

    expect(res.statusCode).toBe(400);
    expect(h.buildBuffer).not.toHaveBeenCalled();
  });

  it('месяц вне окна у department-scope → 403', async () => {
    h.scope.mockResolvedValue('department');
    const res = makeRes();
    await exportTimesheetDepartmentUnified(
      makeReq(
        { month: '2020-01', from: '2020-01-01', to: '2020-01-31' },
        { is_admin: false, role_code: 'site_supervisor', timesheet_months_back: 1, timesheet_months_forward: 1 },
      ),
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(h.buildBuffer).not.toHaveBeenCalled();
  });

  it('scoped-админ (isTimesheetWindowExempt) окном месяцев не ограничен', async () => {
    h.scope.mockResolvedValue('department');
    const res = makeRes();
    await exportTimesheetDepartmentUnified(
      makeReq({ month: '2020-01', from: '2020-01-01', to: '2020-01-31' }, { is_admin: true }),
      res,
    );

    expect(h.buildBuffer).toHaveBeenCalledTimes(1);
  });
});

describe('exportTimesheetDepartmentUnified — состав', () => {
  it('поддерево раскрывается и повторно пересекается со скоупом', async () => {
    await exportTimesheetDepartmentUnified(makeReq(), makeRes());

    expect(h.collectDeptIds).toHaveBeenCalledWith(DEPT);
    expect(h.scopedDeptIds).toHaveBeenCalledWith(expect.anything(), [DEPT, 'child-1']);
    expect(h.members).toHaveBeenCalledWith([DEPT, 'child-1'], '2026-07-01', '2026-07-31');
    expect(h.buildBuffer.mock.calls[0][0].memberByEmp).toEqual(new Map([[1, DEPT], [2, 'child-1']]));
  });

  it('поддерево целиком вне скоупа → 403', async () => {
    h.scopedDeptIds.mockResolvedValue([]);
    const res = makeRes();
    await exportTimesheetDepartmentUnified(makeReq(), res);

    expect(res.statusCode).toBe(403);
    expect(h.buildBuffer).not.toHaveBeenCalled();
  });

  it('табельщица на «ЛИНИЯ-Общестрой»: состав по присутствию, а не весь отдел', async () => {
    h.isTimekeeper.mockReturnValue(true);
    await exportTimesheetDepartmentUnified(makeReq({ department_id: LI }), makeRes());

    expect(h.liPresence).toHaveBeenCalledWith(expect.anything(), '2026-07-01', '2026-07-31');
    expect(h.members).not.toHaveBeenCalled();
    expect(h.deptByEmp).toHaveBeenCalledWith([7], '2026-07-01', '2026-07-31');
    expect(h.buildBuffer.mock.calls[0][0].memberByEmp).toEqual(new Map([[7, DEPT]]));
    expect(h.buildBuffer.mock.calls[0][0].exemptEmployeeIds).toEqual(new Set());
  });

  it('object/view-фильтр реально урезает карту перед сборкой', async () => {
    h.filterVisible.mockResolvedValue([1]);
    await exportTimesheetDepartmentUnified(makeReq(), makeRes());

    expect(h.buildBuffer.mock.calls[0][0].memberByEmp).toEqual(new Map([[1, DEPT]]));
  });

  it('после фильтра никого не осталось → 422, пустой файл не отдаётся', async () => {
    h.filterVisible.mockResolvedValue([]);
    const res = makeRes();
    await exportTimesheetDepartmentUnified(makeReq(), res);

    expect(res.statusCode).toBe(422);
    expect(h.buildBuffer).not.toHaveBeenCalled();
  });

  it('exempt — начальники раскрытых бригад', async () => {
    await exportTimesheetDepartmentUnified(makeReq(), makeRes());

    expect(h.supervisors).toHaveBeenCalledWith([DEPT, 'child-1']);
    expect(h.buildBuffer.mock.calls[0][0].exemptEmployeeIds).toEqual(new Set([9]));
  });
});
