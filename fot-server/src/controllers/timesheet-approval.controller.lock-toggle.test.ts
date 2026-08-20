import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * «Открыть / Закрыть табель»: замок снимается временно, статус подачи не меняется.
 * Ключевое, что проверяем — состояние определяется результатом УСЛОВНОГО UPDATE
 * (без связки SELECT→проверка→UPDATE), а закрытие идёт под advisory-локами.
 */

const { pgQuery, pgQueryOne, txQueries, txRows } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  txQueries: [] as Array<{ sql: string; params: unknown[] }>,
  txRows: { value: [] as unknown[] },
}));

vi.mock('../config/postgres.js', async (importActual) => ({
  ...(await importActual<typeof import('../config/postgres.js')>()),
  query: pgQuery,
  queryOne: pgQueryOne,
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) => {
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        txQueries.push({ sql, params: params ?? [] });
        if (/FROM timesheet_approval_employees/i.test(sql)) {
          return { rows: [{ employee_id: 501 }, { employee_id: 502 }], rowCount: 2 };
        }
        if (/UPDATE timesheet_approvals/i.test(sql)) {
          return { rows: txRows.value, rowCount: txRows.value.length };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    return fn(client);
  },
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
  AUDIT_ACTIONS: {
    TIMESHEET_APPROVAL_OPENED: 'TIMESHEET_APPROVAL_OPENED',
    TIMESHEET_APPROVAL_CLOSED: 'TIMESHEET_APPROVAL_CLOSED',
  },
}));
vi.mock('../services/realtime-broadcast.service.js', () => ({ emitDomainChange: vi.fn() }));
vi.mock('../middleware/cacheResponse.js', () => ({ invalidateCaches: vi.fn() }));

const { recipientsMock } = vi.hoisted(() => ({ recipientsMock: vi.fn(async () => ['u1']) }));
vi.mock('../services/timesheet-workflow-recipients.service.js', () => ({
  listTimesheetWorkflowRecipientIds: recipientsMock,
}));

import { timesheetApprovalController } from './timesheet-approval.controller.js';

const DEPT = '3ad4aa9f-d988-4c49-bc52-abb74ef74bd9';
const UNLOCKED_AT = '2026-08-20T10:00:00Z';

const approvalRow = (over: Record<string, unknown> = {}) => ({
  id: 521,
  department_id: DEPT,
  manager_employee_id: null,
  start_date: '2026-07-01',
  end_date: '2026-07-15',
  status: 'approved',
  submitted_by: 'manager-uuid',
  reviewed_by: 'hr-uuid',
  unlocked_at: null,
  unlocked_by: null,
  unlock_reason: null,
  ...over,
});

const makeRes = () => {
  const res = { _status: 200, _json: undefined as unknown } as Record<string, unknown>;
  res.status = (code: number) => { res._status = code; return res; };
  res.json = (payload: unknown) => { res._json = payload; return res; };
  return res as unknown as { _status: number; _json: unknown } & Parameters<
    typeof timesheetApprovalController.openPeriod
  >[1];
};

const makeReq = (body: Record<string, unknown> = {}): AuthenticatedRequest => ({
  params: { id: '521' },
  query: {},
  body,
  user: { id: 'hr-uuid', employee_id: 7, is_admin: false, role_code: 'hr' },
} as unknown as AuthenticatedRequest);

/** Вызовы UPDATE timesheet_approvals, ушедшие через пул (открытие). */
const poolUpdateCalls = () =>
  pgQueryOne.mock.calls.filter(c => /UPDATE timesheet_approvals/i.test(String(c[0])));

beforeEach(() => {
  vi.clearAllMocks();
  txQueries.length = 0;
  txRows.value = [];
  pgQuery.mockResolvedValue([]);
  pgQueryOne.mockResolvedValue(null);
  resolveScopedDeptMock.mockImplementation(async (_req: unknown, deptId: string | null) => deptId);
});

describe('openPeriod', () => {
  it('открывает утверждённый период условным UPDATE, 200', async () => {
    pgQueryOne
      .mockResolvedValueOnce(approvalRow())
      .mockResolvedValueOnce(approvalRow({ unlocked_at: UNLOCKED_AT, unlocked_by: 'hr-uuid' }))
      .mockResolvedValue({ full_name: 'Фетисова А. А.' });
    const res = makeRes();

    await timesheetApprovalController.openPeriod(makeReq({ reason: '  правка по объекту  ' }), res);

    expect(res._status).toBe(200);
    const updateCall = poolUpdateCalls()[0];
    expect(updateCall).toBeDefined();
    // Условия внутри UPDATE: иначе два параллельных запроса открыли бы период дважды.
    expect(String(updateCall![0])).toContain("status IN ('submitted', 'approved')");
    expect(String(updateCall![0])).toContain('unlocked_at IS NULL');
    // Причина нормализована (trim).
    expect((updateCall![1] as unknown[])[2]).toBe('правка по объекту');
  });

  it('пустая причина уходит как null', async () => {
    pgQueryOne
      .mockResolvedValueOnce(approvalRow())
      .mockResolvedValueOnce(approvalRow({ unlocked_at: UNLOCKED_AT }));

    await timesheetApprovalController.openPeriod(makeReq({ reason: '   ' }), makeRes());

    expect((poolUpdateCalls()[0]![1] as unknown[])[2]).toBeNull();
  });

  it('слишком длинная причина — 400, БД не трогаем', async () => {
    const res = makeRes();

    await timesheetApprovalController.openPeriod(makeReq({ reason: 'x'.repeat(501) }), res);

    expect(res._status).toBe(400);
    expect(pgQueryOne).not.toHaveBeenCalled();
  });

  it('период уже открыт — 409 ALREADY_UNLOCKED', async () => {
    pgQueryOne
      .mockResolvedValueOnce(approvalRow({ unlocked_at: UNLOCKED_AT }))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(approvalRow({ unlocked_at: UNLOCKED_AT }));
    const res = makeRes();

    await timesheetApprovalController.openPeriod(makeReq(), res);

    expect(res._status).toBe(409);
    expect((res._json as { code: string }).code).toBe('ALREADY_UNLOCKED');
  });

  it('период не закрыт (draft) — 409 PERIOD_NOT_CLOSED', async () => {
    pgQueryOne
      .mockResolvedValueOnce(approvalRow({ status: 'draft' }))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(approvalRow({ status: 'draft' }));
    const res = makeRes();

    await timesheetApprovalController.openPeriod(makeReq(), res);

    expect(res._status).toBe(409);
    expect((res._json as { code: string }).code).toBe('PERIOD_NOT_CLOSED');
  });

  it('нет подачи — 404', async () => {
    pgQueryOne.mockResolvedValueOnce(null);
    const res = makeRes();

    await timesheetApprovalController.openPeriod(makeReq(), res);

    expect(res._status).toBe(404);
  });

  it('нет доступа к отделу — 403, ничего не пишем', async () => {
    pgQueryOne.mockResolvedValueOnce(approvalRow());
    resolveScopedDeptMock.mockResolvedValue(null);
    const res = makeRes();

    await timesheetApprovalController.openPeriod(makeReq(), res);

    expect(res._status).toBe(403);
    expect(poolUpdateCalls()).toHaveLength(0);
  });

  it('рассылка уходит и тем, кто ведёт табель (submit), а не только проверяющим', async () => {
    pgQueryOne
      .mockResolvedValueOnce(approvalRow())
      .mockResolvedValueOnce(approvalRow({ unlocked_at: UNLOCKED_AT }));

    await timesheetApprovalController.openPeriod(makeReq(), makeRes());

    expect(recipientsMock).toHaveBeenCalledWith(DEPT, ['submit', 'review', 'monitor']);
  });
});

describe('смена статуса при открытом периоде', () => {
  it('возврат на доработку — 409 TIMESHEET_PERIOD_UNLOCKED, статус не трогаем', async () => {
    pgQueryOne.mockResolvedValueOnce(approvalRow({ unlocked_at: UNLOCKED_AT }));
    const res = makeRes();

    await timesheetApprovalController.returnToRework(makeReq(), res);

    expect(res._status).toBe(409);
    expect((res._json as { code: string }).code).toBe('TIMESHEET_PERIOD_UNLOCKED');
    // Иначе unlocked_at пережил бы смену статуса и оставил замок снятым.
    expect(poolUpdateCalls()).toHaveLength(0);
  });

  it('закрытый период возвращается на доработку как раньше', async () => {
    pgQueryOne.mockResolvedValueOnce(approvalRow());
    const res = makeRes();

    await timesheetApprovalController.returnToRework(makeReq(), res);

    expect(res._status).not.toBe(409);
  });
});

describe('closePeriod', () => {
  it('закрывает период под advisory-локами по составу подачи', async () => {
    pgQueryOne.mockResolvedValueOnce(approvalRow({ unlocked_at: UNLOCKED_AT }));
    txRows.value = [approvalRow()];
    const res = makeRes();

    await timesheetApprovalController.closePeriod(makeReq(), res);

    expect(res._status).toBe(200);
    // Локи взяты ДО UPDATE: иначе правка, начатая раньше, закоммитилась бы уже после закрытия.
    const lockCalls = txQueries.filter(q => /pg_advisory_xact_lock/.test(q.sql));
    expect(lockCalls.map(c => c.params)).toEqual([[501, 202607], [502, 202607]]);
    const lockIdx = txQueries.findIndex(q => /pg_advisory_xact_lock/.test(q.sql));
    const updateIdx = txQueries.findIndex(q => /UPDATE timesheet_approvals/i.test(q.sql));
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(lockIdx).toBeLessThan(updateIdx);
    expect(txQueries[updateIdx]!.sql).toContain('unlocked_at IS NOT NULL');
  });

  it('период уже закрыт — 409 ALREADY_LOCKED', async () => {
    pgQueryOne.mockResolvedValueOnce(approvalRow());
    txRows.value = [];
    const res = makeRes();

    await timesheetApprovalController.closePeriod(makeReq(), res);

    expect(res._status).toBe(409);
    expect((res._json as { code: string }).code).toBe('ALREADY_LOCKED');
  });

  it('нет доступа к отделу — 403, транзакцию не открываем', async () => {
    pgQueryOne.mockResolvedValueOnce(approvalRow({ unlocked_at: UNLOCKED_AT }));
    resolveScopedDeptMock.mockResolvedValue(null);
    const res = makeRes();

    await timesheetApprovalController.closePeriod(makeReq(), res);

    expect(res._status).toBe(403);
    expect(txQueries).toHaveLength(0);
  });
});
