import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /api/timesheet/corrections — флаг can_edit обязан совпадать с поведением записи.
 * PUT /api/timesheet/:id тип источника не ограничивает, поэтому админ и кадровый админ
 * (canManageAsHrAdmin: глобальный скоуп + edit табеля) видят карандаш у любой строки
 * открытого периода. Остальным — только ручные правки и «согласованный выход».
 */

const h = vi.hoisted(() => ({
  hrAdminManage: vi.fn(async () => false),
  adjustments: vi.fn(),
  locks: vi.fn(async () => new Map()),
}));

vi.mock('../config/postgres.js', async (importActual) => ({
  ...(await importActual<typeof import('../config/postgres.js')>()),
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  execute: vi.fn(async () => 0),
}));
vi.mock('../services/access-control.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/access-control.service.js')>()),
  canManageAsHrAdmin: h.hrAdminManage,
}));
vi.mock('../services/timesheet-scope.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/timesheet-scope.service.js')>()),
  resolveTimesheetScope: vi.fn(async () => 'all'),
  roleAllowsTimesheet: vi.fn(async () => true),
}));
vi.mock('../services/data-scope.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/data-scope.service.js')>()),
  resolveTimesheetEditableEmployeeIds: vi.fn(async () => 'all'),
}));
vi.mock('../services/timesheet-department-assignments.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/timesheet-department-assignments.service.js')>()),
  listEmployeeIdsAssignedToDepartmentPeriod: vi.fn(async () => [247]),
}));
vi.mock('../services/attendance.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/attendance.service.js')>()),
  loadAttendanceAdjustmentsWithAuthors: h.adjustments,
}));
vi.mock('../services/correction-attachments.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/correction-attachments.service.js')>()),
  countCorrectionAttachments: vi.fn(async () => new Map()),
}));
vi.mock('../services/timesheet-lock.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/timesheet-lock.service.js')>()),
  findApprovalLocksForEmployeeDates: h.locks,
}));
vi.mock('../services/audit.service.js', () => ({
  AUDIT_ACTIONS: {},
  auditService: { logFromRequest: vi.fn(async () => undefined) },
}));
vi.mock('../services/r2.service.js', () => ({
  r2Service: { isEnabledAsync: vi.fn(async () => false), deleteObject: vi.fn(async () => undefined) },
}));
vi.mock('../services/skud-realtime.service.js', () => ({
  notifySkudRealtimeChanged: vi.fn(),
  invalidateSkudRealtimeCaches: vi.fn(),
}));

import { timesheetController } from './timesheet.controller.js';
import type { AuthenticatedRequest } from '../types/index.js';

const ROW_BASE = {
  employee_id: 247, employee_full_name: 'Тестов Т. Т.', work_date: '2026-09-10',
  hours_override: 8, reason: null, approval_comment: null, author_name: null,
  created_by: 'u', created_at: '2026-09-10', updated_at: '2026-09-10',
  approved_at: null, approver_name: null, source_id: null,
};

const req = (roleCode: string): AuthenticatedRequest => ({
  query: { start_date: '2026-09-01', end_date: '2026-09-15', department_id: 'D1' },
  params: {},
  body: {},
  user: { id: 'u-1', role_code: roleCode, is_admin: false, employee_id: 148 },
} as unknown as AuthenticatedRequest);

const makeRes = () => {
  const res = { _status: 200, _json: undefined as unknown } as {
    _status: number; _json: unknown; status: (c: number) => unknown; json: (p: unknown) => unknown;
  };
  res.status = (code: number) => { res._status = code; return res; };
  res.json = (payload: unknown) => { res._json = payload; return res; };
  return res as unknown as { _status: number; _json: unknown } & Parameters<
    typeof timesheetController.listCorrections
  >[1];
};

const canEditBySource = (json: unknown) => Object.fromEntries(
  (json as { data: Array<{ source_type: string; can_edit: boolean }> }).data
    .map(row => [row.source_type, row.can_edit]),
);

beforeEach(() => {
  vi.clearAllMocks();
  h.hrAdminManage.mockResolvedValue(false);
  h.locks.mockResolvedValue(new Map());
  h.adjustments.mockResolvedValue([
    { ...ROW_BASE, id: 1, source_type: 'manual', status: 'manual' },
    { ...ROW_BASE, id: 2, source_type: 'leave_request', status: 'vacation' },
  ]);
});

describe('listCorrections: can_edit', () => {
  it('кадровый админ правит любую строку открытого периода — как админ', async () => {
    h.hrAdminManage.mockResolvedValue(true);
    const res = makeRes();

    await timesheetController.listCorrections(req('hr_admin'), res);

    expect(h.hrAdminManage).toHaveBeenCalledWith(expect.anything(), '/timesheet');
    expect(canEditBySource(res._json)).toEqual({ manual: true, leave_request: true });
  });

  it('без права «как админ» — только ручные правки', async () => {
    const res = makeRes();

    await timesheetController.listCorrections(req('manager'), res);

    expect(canEditBySource(res._json)).toEqual({ manual: true, leave_request: false });
  });

  it('закрытый период не правит никто, и кадровый админ тоже', async () => {
    h.hrAdminManage.mockResolvedValue(true);
    h.locks.mockResolvedValue(new Map([['247|2026-09-10', { id: 5 }]]));
    const res = makeRes();

    await timesheetController.listCorrections(req('hr_admin'), res);

    expect(canEditBySource(res._json)).toEqual({ manual: false, leave_request: false });
  });
});
