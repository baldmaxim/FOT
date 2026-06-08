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
