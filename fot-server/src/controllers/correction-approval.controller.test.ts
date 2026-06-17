import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const { pgQuery, pgQueryOne } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
}));
vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
}));

const { accessibleMock, editableMock, scopedMock } = vi.hoisted(() => ({
  accessibleMock: vi.fn(async (): Promise<'all' | string[]> => 'all'),
  editableMock: vi.fn(async (): Promise<'all' | string[]> => 'all'),
  scopedMock: vi.fn(async (_req: unknown, deptId: string | null) => deptId),
}));
vi.mock('../services/data-scope.service.js', () => ({
  resolveAccessibleDepartmentIds: accessibleMock,
  resolveEditableDepartmentIds: editableMock,
  resolveScopedDepartmentId: scopedMock,
}));

vi.mock('../services/employee-direct-reports.service.js', () => ({
  listDirectSubordinates: vi.fn(async () => []),
}));

vi.mock('../services/correction-approval-settings.service.js', () => ({
  correctionApprovalSettingsService: {
    getRequiredDepartmentIds: vi.fn(async () => new Set(['D1'])),
    setRequiredDepartmentIds: vi.fn(async (ids: string[]) => ids),
  },
}));

const { routeMock } = vi.hoisted(() => ({
  routeMock: vi.fn(async () => new Map<number, number[]>()),
}));
vi.mock('../services/approval-routing.service.js', () => ({
  resolveResponsibleEmployeeIdsForRows: routeMock,
}));

vi.mock('../services/audit.service.js', () => ({
  AUDIT_ACTIONS: {
    UPDATE_TIMESHEET_ENTRY: 'UPDATE_TIMESHEET_ENTRY',
    CORRECTION_APPROVAL_SETTINGS_CHANGED: 'CORRECTION_APPROVAL_SETTINGS_CHANGED',
  },
  auditService: { logFromRequest: vi.fn(async () => undefined) },
}));
vi.mock('./timesheet.controller.js', () => ({
  reapproveAdjustmentsForRange: vi.fn(async () => 0),
}));
vi.mock('../services/realtime-broadcast.service.js', () => ({ emitDomainChange: vi.fn() }));
vi.mock('../services/recipients.service.js', () => ({
  getLeaveRequestRecipients: vi.fn(async () => []),
  getUserIdsByEmployeeIds: vi.fn(async () => []),
}));

import { correctionApprovalController } from './correction-approval.controller.js';

function makeReq(employeeId: number): AuthenticatedRequest {
  return {
    params: {},
    query: { start_date: '2026-06-01', end_date: '2026-06-30' },
    body: {},
    user: {
      id: `user-${employeeId}`,
      email: 'u@example.com',
      position_type: 'admin',
      employee_id: employeeId,
      department_id: null,
      is_approved: true,
      two_factor_enabled: false,
      two_factor_verified: true,
    },
  } as unknown as AuthenticatedRequest;
}

function makeRes(): Response & { _status: number; _json: unknown } {
  const res = {
    _status: 200,
    _json: undefined as unknown,
    status(code: number) { this._status = code; return this; },
    json(payload: unknown) { this._json = payload; return this; },
  };
  return res as unknown as Response & { _status: number; _json: unknown };
}

function mockPendingQueries(): void {
  pgQuery
    .mockResolvedValueOnce([{
      id: 10,
      employee_id: 1,
      work_date: '2026-06-06',
      status: 'work',
      hours_override: null,
      reason: 'выходной',
      created_by: null,
      created_at: '2026-06-01T00:00:00Z',
    }])
    .mockResolvedValueOnce([{ id: 1, full_name: 'Сотрудник', org_department_id: 'D1' }]);
}

describe('correctionApprovalController.getPendingByDepartment routing visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessibleMock.mockResolvedValue('all');
    editableMock.mockResolvedValue('all');
  });

  it('admin/all не видит routed-строку, если он не назначенный ответственный', async () => {
    mockPendingQueries();
    routeMock.mockResolvedValueOnce(new Map([[10, [100]]]));
    const res = makeRes();

    await correctionApprovalController.getPendingByDepartment(makeReq(999), res);

    expect(res._status).toBe(200);
    expect((res._json as { data: unknown[] }).data).toEqual([]);
  });

  it('назначенный ответственный видит свою routed-строку', async () => {
    mockPendingQueries();
    routeMock.mockResolvedValueOnce(new Map([[10, [100]]]));
    pgQuery.mockResolvedValueOnce([{ id: 'D1', name: 'Цифровая трансформация' }]);
    const res = makeRes();

    await correctionApprovalController.getPendingByDepartment(makeReq(100), res);

    expect(res._status).toBe(200);
    const data = (res._json as { data: Array<{ items: Array<{ id: number }> }> }).data;
    expect(data).toHaveLength(1);
    expect(data[0].items.map(i => i.id)).toEqual([10]);
  });

  it('назначенный ответственный видит routed-строку даже без department-scope', async () => {
    accessibleMock.mockResolvedValueOnce([]);
    mockPendingQueries();
    routeMock.mockResolvedValueOnce(new Map([[10, [100]]]));
    pgQuery.mockResolvedValueOnce([{ id: 'D1', name: 'Цифровая трансформация' }]);
    const res = makeRes();

    await correctionApprovalController.getPendingByDepartment(makeReq(100), res);

    expect(res._status).toBe(200);
    const data = (res._json as { data: Array<{ items: Array<{ id: number }> }> }).data;
    expect(data).toHaveLength(1);
    expect(data[0].items.map(i => i.id)).toEqual([10]);
  });
});

function makeAdminReq(opts: { isAdmin?: boolean; mode?: 'pending' | 'history' } = {}): AuthenticatedRequest {
  return {
    params: {},
    query: {
      start_date: '2026-06-01',
      end_date: '2026-06-30',
      ...(opts.mode ? { mode: opts.mode } : {}),
    },
    body: {},
    user: {
      id: 'admin-user',
      email: 'a@example.com',
      position_type: 'admin',
      employee_id: 500,
      department_id: null,
      is_admin: opts.isAdmin ?? true,
      is_approved: true,
      two_factor_enabled: false,
      two_factor_verified: true,
    },
  } as unknown as AuthenticatedRequest;
}

// adjustments (с history-полями) + employees — общая база для getAllByResponsible.
function mockAllByResponsibleBase(): void {
  pgQuery
    .mockResolvedValueOnce([{
      id: 10,
      employee_id: 1,
      work_date: '2026-06-06',
      status: 'work',
      hours_override: null,
      reason: 'выходной',
      created_by: null,
      created_at: '2026-06-01T00:00:00Z',
      approval_status: 'pending',
      approved_by: null,
      approved_at: null,
      approval_comment: null,
    }])
    .mockResolvedValueOnce([{ id: 1, full_name: 'Сотрудник', org_department_id: 'D1' }]);
}

describe('correctionApprovalController.getAllByResponsible (админ-обзор по ответственным)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessibleMock.mockResolvedValue('all');
    editableMock.mockResolvedValue('all');
    routeMock.mockResolvedValue(new Map<number, number[]>());
  });

  it('не-админ → 403', async () => {
    const res = makeRes();
    await correctionApprovalController.getAllByResponsible(makeAdminReq({ isAdmin: false }), res);
    expect(res._status).toBe(403);
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('админ с пустым scope → 200 []', async () => {
    accessibleMock.mockResolvedValueOnce([]);
    const res = makeRes();
    await correctionApprovalController.getAllByResponsible(makeAdminReq(), res);
    expect(res._status).toBe(200);
    expect((res._json as { data: unknown[] }).data).toEqual([]);
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('группирует routed-строку под её ответственным', async () => {
    mockAllByResponsibleBase();
    routeMock.mockResolvedValueOnce(new Map([[10, [100]]]));
    pgQuery.mockResolvedValueOnce([{ id: 'D1', name: 'Отдел' }]);          // org_departments
    pgQuery.mockResolvedValueOnce([{ id: 100, full_name: 'Руководитель' }]); // имена ответственных
    const res = makeRes();

    await correctionApprovalController.getAllByResponsible(makeAdminReq(), res);

    expect(res._status).toBe(200);
    const data = (res._json as { data: Array<{
      responsible_employee_id: number | null;
      responsible_name: string | null;
      is_unassigned?: boolean;
      departments: Array<{ items: Array<{ id: number }> }>;
    }> }).data;
    expect(data).toHaveLength(1);
    expect(data[0].responsible_employee_id).toBe(100);
    expect(data[0].responsible_name).toBe('Руководитель');
    expect(data[0].is_unassigned).toBeFalsy();
    expect(data[0].departments[0].items.map(i => i.id)).toEqual([10]);
  });

  it('нерутированная строка → секция «Без назначенного ответственного»', async () => {
    mockAllByResponsibleBase();
    routeMock.mockResolvedValueOnce(new Map([[10, []]]));
    pgQuery.mockResolvedValueOnce([{ id: 'D1', name: 'Отдел' }]); // org_departments
    const res = makeRes();

    await correctionApprovalController.getAllByResponsible(makeAdminReq(), res);

    expect(res._status).toBe(200);
    const data = (res._json as { data: Array<{
      responsible_employee_id: number | null;
      is_unassigned?: boolean;
      departments: Array<{ items: Array<{ id: number }> }>;
    }> }).data;
    expect(data).toHaveLength(1);
    expect(data[0].responsible_employee_id).toBeNull();
    expect(data[0].is_unassigned).toBe(true);
    expect(data[0].departments[0].items.map(i => i.id)).toEqual([10]);
  });

  it('company-admin не получает строки вне своего scope', async () => {
    accessibleMock.mockResolvedValueOnce(['D2']); // сотрудник в D1 — вне scope
    mockAllByResponsibleBase();
    const res = makeRes();

    await correctionApprovalController.getAllByResponsible(makeAdminReq(), res);

    expect(res._status).toBe(200);
    expect((res._json as { data: unknown[] }).data).toEqual([]);
  });
});
