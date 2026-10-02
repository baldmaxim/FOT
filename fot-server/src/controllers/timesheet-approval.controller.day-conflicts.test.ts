import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Утверждение не пропускает день сотрудника, уже утверждённый в другой подаче: иначе 1С
 * получает его часы дважды (сентябрь 2026 — руководитель в личной подаче и в подаче
 * отдела). Проверка идёт внутри транзакции после материализации версии — ошибка
 * откатывает и версию, и статус.
 */

const { pgQuery, pgQueryOne, txQueries, calls, materializeMock, assertConflictsMock } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  txQueries: [] as string[],
  calls: [] as string[],
  materializeMock: vi.fn(),
  assertConflictsMock: vi.fn(),
}));

vi.mock('../config/postgres.js', async (importActual) => ({
  ...(await importActual<typeof import('../config/postgres.js')>()),
  query: pgQuery,
  queryOne: pgQueryOne,
}));

const DEPT = '3ad4aa9f-d988-4c49-bc52-abb74ef74bd9';

const approvalRow = (over: Record<string, unknown> = {}) => ({
  id: 1782,
  department_id: DEPT,
  manager_employee_id: null,
  start_date: '2026-09-01',
  end_date: '2026-09-15',
  status: 'submitted',
  submitted_by: 'manager-uuid',
  reviewed_by: null,
  unlocked_at: null,
  unlocked_by: null,
  unlock_reason: null,
  ...over,
});

vi.mock('../services/timesheet-snapshot-tx.js', () => ({
  withTimesheetSnapshotTransaction: async (_pairs: unknown, fn: (client: unknown) => Promise<unknown>) => {
    const client = {
      query: async (sql: string) => {
        txQueries.push(sql);
        if (/FOR UPDATE/i.test(sql)) return { rows: [approvalRow()], rowCount: 1 };
        if (/UPDATE timesheet_approvals\s+SET status/i.test(sql)) {
          return { rows: [approvalRow({ status: 'approved', reviewed_by: 'hr-uuid' })], rowCount: 1 };
        }
        if (/version_dirty/i.test(sql)) calls.push('clearVersionDirty');
        return { rows: [], rowCount: 0 };
      },
    };
    return fn(client);
  },
  isRetryableDbError: () => false,
}));

vi.mock('../services/timesheet-version.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/timesheet-version.service.js')>()),
  materializeVersion: materializeMock,
}));

vi.mock('../services/timesheet-approved-day-conflicts.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/timesheet-approved-day-conflicts.service.js')>()),
  assertNoApprovedDayConflicts: assertConflictsMock,
}));

vi.mock('../services/timesheet-approval-correction-validation.service.js', () => ({
  validateCorrectionAttachments: vi.fn(async () => ({ ok: true })),
  listPendingCorrectionDays: vi.fn(async () => []),
}));
vi.mock('../services/data-scope.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/data-scope.service.js')>()),
  resolveScopedDepartmentId: vi.fn(async (_req: unknown, deptId: string | null) => deptId),
}));
vi.mock('../services/timesheet-approval-history.service.js', () => ({
  timesheetApprovalHistoryService: { appendEvent: vi.fn(async () => undefined), listByApprovalId: vi.fn(async () => []) },
}));
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: vi.fn(async () => undefined) },
  AUDIT_ACTIONS: new Proxy({}, { get: (_target, key) => key }),
}));
vi.mock('../services/timesheet-workflow-recipients.service.js', () => ({
  listTimesheetWorkflowRecipientIds: vi.fn(async () => []),
}));
vi.mock('../services/realtime-broadcast.service.js', () => ({ emitDomainChange: vi.fn() }));
vi.mock('../services/notification.service.js', () => ({ notificationService: { createMany: vi.fn(async () => undefined) } }));
vi.mock('../services/push.service.js', () => ({
  pushService: { sendToUsers: vi.fn(async () => undefined), sendGenericNotification: vi.fn(async () => undefined) },
}));
vi.mock('../middleware/cacheResponse.js', () => ({ invalidateCaches: vi.fn() }));

import { timesheetApprovalController } from './timesheet-approval.controller.js';
import { TimesheetApprovedDayConflictError } from '../services/timesheet-approved-day-conflicts.service.js';

const makeRes = () => {
  const res = { _status: 200, _json: undefined as unknown } as Record<string, unknown>;
  res.status = (code: number) => { res._status = code; return res; };
  res.json = (payload: unknown) => { res._json = payload; return res; };
  return res as unknown as { _status: number; _json: Record<string, unknown> } & Parameters<
    typeof timesheetApprovalController.approve
  >[1];
};

const makeReq = (): AuthenticatedRequest => ({
  params: { id: '1782' },
  query: {},
  body: {},
  user: { id: 'hr-uuid', employee_id: 7, is_admin: false, role_code: 'hr' },
} as unknown as AuthenticatedRequest);

beforeEach(() => {
  vi.clearAllMocks();
  txQueries.length = 0;
  calls.length = 0;
  pgQueryOne.mockImplementation(async (sql: string) => (
    /FROM timesheet_approvals WHERE id/i.test(sql) ? approvalRow() : null
  ));
  pgQuery.mockImplementation(async (sql: string) => (
    /FROM timesheet_approval_employees/i.test(sql) ? [{ employee_id: 567 }, { employee_id: 568 }] : []
  ));
  materializeMock.mockImplementation(async () => {
    calls.push('materialize');
    return { version: { revision: 1 }, created: true };
  });
  assertConflictsMock.mockImplementation(async () => { calls.push('assert'); });
});

describe('approve — день уже утверждён в другой подаче', () => {
  it('409 TIMESHEET_DAYS_ALREADY_APPROVED с ФИО и подачей; версия dirty не сбрасывается', async () => {
    assertConflictsMock.mockImplementation(async (_client: unknown, approvalId: number) => {
      calls.push('assert');
      throw new TimesheetApprovedDayConflictError(approvalId, [{
        employeeId: 567,
        fullName: 'Душанова Елена Анатольевна',
        approvalId: 1781,
        departmentId: null,
        departmentName: null,
        managerFullName: 'Душанова Елена Анатольевна',
        firstDay: '2026-09-01',
        lastDay: '2026-09-15',
        days: 11,
      }]);
    });
    const res = makeRes();

    await timesheetApprovalController.approve(makeReq(), res);

    expect(res._status).toBe(409);
    expect(res._json.code).toBe('TIMESHEET_DAYS_ALREADY_APPROVED');
    expect(String(res._json.error)).toContain('Душанова Е. А. — личный табель Душанова Е. А., 1–15 сен 2026');
    expect(res._json.conflicts).toHaveLength(1);
    expect(assertConflictsMock).toHaveBeenCalledWith(expect.anything(), 1782);
    // Проверка — после материализации, до сброса dirty: исключение откатывает всё.
    expect(calls).toEqual(['materialize', 'assert']);
  });

  it('пересечений нет — утверждено, проверка между материализацией и сбросом dirty', async () => {
    const res = makeRes();

    await timesheetApprovalController.approve(makeReq(), res);

    expect(res._status).toBe(200);
    expect(calls).toEqual(['materialize', 'assert', 'clearVersionDirty']);
  });
});
