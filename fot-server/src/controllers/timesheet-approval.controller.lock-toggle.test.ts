import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * «Открыть / Закрыть табель»: замок снимается временно, статус подачи не меняется.
 * Ключевое, что проверяем — состояние определяется результатом УСЛОВНОГО UPDATE
 * (без связки SELECT→проверка→UPDATE), а закрытие идёт под advisory-локами.
 */

const { pgQuery, pgQueryOne, txQueries, txRows, lockPairsSeen, materializeMock } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  txQueries: [] as Array<{ sql: string; params: unknown[] }>,
  txRows: { value: [] as unknown[] },
  lockPairsSeen: { value: [] as Array<{ employeeId: number; workDate: string }> },
  materializeMock: vi.fn(async () => ({ version: { revision: 1 }, created: true })),
}));

vi.mock('../config/postgres.js', async (importActual) => ({
  ...(await importActual<typeof import('../config/postgres.js')>()),
  query: pgQuery,
  queryOne: pgQueryOne,
}));

/**
 * Транзакция материализации: локи берутся ДО открытия snapshot-транзакции и потому
 * живут не в списке её запросов, а в аргументе хелпера — его и проверяем.
 */
vi.mock('../services/timesheet-snapshot-tx.js', () => ({
  withTimesheetSnapshotTransaction: async (
    pairs: Array<{ employeeId: number; workDate: string }>,
    fn: (client: unknown) => Promise<unknown>,
  ) => {
    lockPairsSeen.value = pairs;
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        txQueries.push({ sql, params: params ?? [] });
        if (/FOR UPDATE/i.test(sql)) {
          // Пустой txRows моделирует «UPDATE ничего не обновил», то есть период
          // уже закрыт — значит и под FOR UPDATE строка идёт без unlocked_at.
          const row = txRows.value.length > 0
            ? approvalRow({ ...(txRows.value[0] as Record<string, unknown>), unlocked_at: UNLOCKED_AT })
            : approvalRow();
          return { rows: [row], rowCount: 1 };
        }
        if (/UPDATE timesheet_approvals/i.test(sql)) {
          return { rows: txRows.value, rowCount: txRows.value.length };
        }
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

// Нерешённые выходные подачи — счётчик HR-гейта; по умолчанию ждать нечего.
const { pendingCountMock } = vi.hoisted(() => ({ pendingCountMock: vi.fn(async () => 0) }));
vi.mock('../services/timesheet-pending-decisions.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/timesheet-pending-decisions.service.js')>()),
  countPendingDecisionsForApproval: pendingCountMock,
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
  lockPairsSeen.value = [];
  // Состав подачи для advisory-локов читается ДО транзакции — через пул.
  pgQuery.mockImplementation(async (sql: string) => (
    /FROM timesheet_approval_employees/i.test(String(sql))
      ? [{ employee_id: 501 }, { employee_id: 502 }]
      : []
  ));
  pgQueryOne.mockResolvedValue(null);
  pendingCountMock.mockResolvedValue(0);
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
    // Локи берутся ДО открытия snapshot-транзакции (иначе snapshot REPEATABLE READ
    // зафиксируется на ожидании лока и не увидит чужую корректировку), поэтому их
    // состав проверяем по аргументу хелпера, а не по списку запросов транзакции.
    expect(lockPairsSeen.value).toEqual([
      { employeeId: 501, workDate: '2026-07-01' },
      { employeeId: 502, workDate: '2026-07-01' },
    ]);
    // Строка блокируется FOR UPDATE до условного UPDATE.
    const forUpdateIdx = txQueries.findIndex(q => /FOR UPDATE/i.test(q.sql));
    const updateIdx = txQueries.findIndex(q => /UPDATE timesheet_approvals/i.test(q.sql));
    expect(forUpdateIdx).toBeGreaterThanOrEqual(0);
    expect(forUpdateIdx).toBeLessThan(updateIdx);
    expect(txQueries[updateIdx]!.sql).toContain('unlocked_at IS NOT NULL');
    // Закрытие утверждённого периода порождает официальную версию для 1С.
    expect(materializeMock).toHaveBeenCalledTimes(1);
    expect(materializeMock.mock.calls[0]![2]).toBe('close');
  });

  it('утверждённый табель с нерешёнными выходными — 409, замок не возвращён, версии нет', async () => {
    pgQueryOne.mockResolvedValueOnce(approvalRow({ unlocked_at: UNLOCKED_AT }));
    txRows.value = [approvalRow()];
    pendingCountMock.mockResolvedValueOnce(2);
    const res = makeRes();

    await timesheetApprovalController.closePeriod(makeReq(), res);

    expect(res._status).toBe(409);
    expect(res._json).toMatchObject({
      code: 'PENDING_CORRECTIONS_EXIST',
      pending_count: 2,
      error: 'Табель ждёт согласования выходных — закрыть можно после решения по ним',
    });
    // Счётчик читается внутри транзакции закрытия, по заблокированной строке подачи.
    expect(pendingCountMock).toHaveBeenCalledTimes(1);
    expect((pendingCountMock.mock.calls[0] as unknown[])[0]).toMatchObject({ id: 521, status: 'approved' });
    expect(txQueries.some(q => /UPDATE timesheet_approvals/i.test(q.sql))).toBe(false);
    expect(materializeMock).not.toHaveBeenCalled();
  });

  it('поданный табель закрывается и с нерешёнными выходными — решать их замок не мешает', async () => {
    pgQueryOne.mockResolvedValueOnce(approvalRow({ status: 'submitted', unlocked_at: UNLOCKED_AT }));
    txRows.value = [approvalRow({ status: 'submitted' })];
    pendingCountMock.mockResolvedValue(3);
    const res = makeRes();

    await timesheetApprovalController.closePeriod(makeReq(), res);

    expect(res._status).toBe(200);
    expect(pendingCountMock).not.toHaveBeenCalled();
    expect(txQueries.some(q => /UPDATE timesheet_approvals/i.test(q.sql))).toBe(true);
    // Версия для 1С — только у утверждённого.
    expect(materializeMock).not.toHaveBeenCalled();
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
