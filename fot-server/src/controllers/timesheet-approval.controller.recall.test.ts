import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Отзыв табеля: руководитель возвращает в черновик только ПОДАННЫЙ период.
 * Утверждённый отзывает лишь админ — иначе руководитель снимал бы утверждение HR
 * и правил закрытый табель, обходя гард закрытого периода.
 */

const { pgQuery, pgQueryOne } = vi.hoisted(() => ({ pgQuery: vi.fn(), pgQueryOne: vi.fn() }));
vi.mock('../config/postgres.js', async (importActual) => ({
  ...(await importActual<typeof import('../config/postgres.js')>()),
  query: pgQuery,
  queryOne: pgQueryOne,
}));

const { resolveScopedDeptMock } = vi.hoisted(() => ({
  resolveScopedDeptMock: vi.fn(async (_req: unknown, deptId: string | null) => deptId),
}));
vi.mock('../services/data-scope.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/data-scope.service.js')>()),
  resolveScopedDepartmentId: resolveScopedDeptMock,
}));

vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: vi.fn(async () => undefined) },
  AUDIT_ACTIONS: {},
}));
vi.mock('../services/realtime-broadcast.service.js', () => ({ emitDomainChange: vi.fn() }));
vi.mock('../services/notification.service.js', () => ({
  notificationService: { createMany: vi.fn(async () => undefined) },
}));
vi.mock('../services/push.service.js', () => ({
  pushService: { sendToUsers: vi.fn(async () => undefined) },
}));
vi.mock('../middleware/cacheResponse.js', () => ({ invalidateCaches: vi.fn() }));

import { timesheetApprovalController } from './timesheet-approval.controller.js';

const DEPT = '3ad4aa9f-d988-4c49-bc52-abb74ef74bd9';
const RANGE = { start_date: '2026-06-01', end_date: '2026-06-15' };

const makeRes = () => {
  const res = { _status: 200, _json: undefined as unknown } as {
    _status: number; _json: unknown; status: (c: number) => unknown; json: (p: unknown) => unknown;
  };
  res.status = (code: number) => { res._status = code; return res; };
  res.json = (payload: unknown) => { res._json = payload; return res; };
  return res as unknown as { _status: number; _json: unknown } & Parameters<
    typeof timesheetApprovalController.recall
  >[1];
};

const makeReq = (isAdmin: boolean): AuthenticatedRequest => ({
  params: {},
  query: {},
  body: { department_id: DEPT, ...RANGE },
  user: { id: 'user-uuid', employee_id: 7, is_admin: isAdmin, role_code: 'manager' },
} as unknown as AuthenticatedRequest);

/** Существующая подача в заданном статусе + результат UPDATE (если до него дойдёт). */
const mockApproval = (status: 'submitted' | 'approved' | 'draft') => {
  pgQueryOne.mockReset();
  pgQueryOne
    .mockResolvedValueOnce({
      id: 521, department_id: DEPT, manager_employee_id: null,
      start_date: RANGE.start_date, end_date: RANGE.end_date, status,
      submitted_by: 'manager-uuid', reviewed_by: status === 'approved' ? 'hr-uuid' : null,
    })
    .mockResolvedValue({
      id: 521, department_id: DEPT, manager_employee_id: null,
      start_date: RANGE.start_date, end_date: RANGE.end_date, status: 'draft',
      submitted_by: null, reviewed_by: null,
    });
};

/** Все UPDATE, дошедшие до БД: гард обязан не пустить ни одного. */
const updateCalls = () => [
  ...pgQueryOne.mock.calls.filter(c => /UPDATE timesheet_approvals/i.test(String(c[0]))),
  ...pgQuery.mock.calls.filter(c => /UPDATE timesheet_approvals/i.test(String(c[0]))),
];

beforeEach(() => {
  vi.clearAllMocks();
  pgQuery.mockResolvedValue([]);
  resolveScopedDeptMock.mockImplementation(async (_req: unknown, deptId: string | null) => deptId);
});

describe('recall — отзыв табеля', () => {
  it('руководитель отзывает поданный табель: 200, статус draft', async () => {
    mockApproval('submitted');
    const res = makeRes();

    await timesheetApprovalController.recall(makeReq(false), res);

    expect(res._status).toBe(200);
    expect((res._json as { data: { status: string } }).data.status).toBe('draft');
    expect(updateCalls()).toHaveLength(1);
  });

  it('руководитель НЕ отзывает утверждённый табель: 403, БД не трогаем', async () => {
    mockApproval('approved');
    const res = makeRes();

    await timesheetApprovalController.recall(makeReq(false), res);

    expect(res._status).toBe(403);
    expect((res._json as { code: string }).code).toBe('APPROVED_RECALL_FORBIDDEN');
    // Утверждение HR должно остаться на месте.
    expect(updateCalls()).toHaveLength(0);
  });

  it('админ отзывает утверждённый табель: 200, статус draft', async () => {
    mockApproval('approved');
    const res = makeRes();

    await timesheetApprovalController.recall(makeReq(true), res);

    expect(res._status).toBe(200);
    expect((res._json as { data: { status: string; reviewed_by: string | null } }).data.status).toBe('draft');
    expect((res._json as { data: { reviewed_by: string | null } }).data.reviewed_by).toBeNull();
    expect(updateCalls()).toHaveLength(1);
  });

  it('из draft отзывать нечего: 409 (поведение прежнее)', async () => {
    mockApproval('draft');
    const res = makeRes();

    await timesheetApprovalController.recall(makeReq(true), res);

    expect(res._status).toBe(409);
    expect(updateCalls()).toHaveLength(0);
  });
});
