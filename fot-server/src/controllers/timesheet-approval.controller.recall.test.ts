import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Отзыв табеля: руководитель возвращает в черновик только ПОДАННЫЙ период.
 * Утверждённый отзывает лишь админ — иначе руководитель снимал бы утверждение HR
 * и правил закрытый табель, обходя гард закрытого периода.
 *
 * Отзыв отдела в той же транзакции отзывает persona-подачу автора подачи за тот же
 * диапазон (кейс Карасени: отдел отозван, а persona со строкой руководителя держала замок).
 */

const { pgQuery, pgQueryOne, pgTx } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  pgTx: vi.fn(),
}));
vi.mock('../config/postgres.js', async (importActual) => ({
  ...(await importActual<typeof import('../config/postgres.js')>()),
  query: pgQuery,
  queryOne: pgQueryOne,
  withTransaction: pgTx,
}));

const { resolveScopedDeptMock, resolveEditableDeptsMock } = vi.hoisted(() => ({
  resolveScopedDeptMock: vi.fn(async (_req: unknown, deptId: string | null) => deptId),
  // Отзыв — write-действие: отдел резолвится по editable-скоупу
  // (resolveTimesheetWritableDepartmentId), а не по видимому.
  resolveEditableDeptsMock: vi.fn(async () => [] as string[]),
}));
vi.mock('../services/data-scope.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/data-scope.service.js')>()),
  resolveScopedDepartmentId: resolveScopedDeptMock,
  resolveEditableDepartmentIds: resolveEditableDeptsMock,
  // Отзыв табеля резолвит отдел по табельному скоупу (full + отделы заместителя).
  resolveTimesheetEditableDepartmentIds: resolveEditableDeptsMock,
}));

const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn(async () => undefined) }));
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: auditMock },
  AUDIT_ACTIONS: new Proxy({}, { get: (_target, key) => key }),
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
const AUTHOR = 'manager-uuid';

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

const makeReq = (isAdmin: boolean, body: Record<string, unknown> = {}): AuthenticatedRequest => ({
  params: {},
  query: {},
  body: { department_id: DEPT, ...RANGE, ...body },
  user: { id: isAdmin ? 'admin-uuid' : AUTHOR, employee_id: 7, is_admin: isAdmin, role_code: 'manager' },
} as unknown as AuthenticatedRequest);

const client = { query: vi.fn() };

/** Строки, которые вернут UPDATE отдела и каскадный UPDATE persona-подачи. */
const db = {
  deptUpdated: true,
  personal: null as Record<string, unknown> | null,
  cascadeError: null as Error | null,
};

/** Существующая подача отдела в заданном статусе. */
const mockApproval = (
  status: 'submitted' | 'approved' | 'draft',
  over: Record<string, unknown> = {},
) => {
  pgQueryOne.mockResolvedValue({
    id: 521, department_id: DEPT, manager_employee_id: null,
    start_date: RANGE.start_date, end_date: RANGE.end_date, status,
    submitted_by: AUTHOR, reviewed_by: status === 'approved' ? 'hr-uuid' : null,
    unlocked_at: null, unlocked_by: null, unlock_reason: null,
    ...over,
  });
};

/** Все UPDATE подач, дошедшие до БД. */
const updateCalls = () => [
  ...client.query.mock.calls,
  ...pgQueryOne.mock.calls,
  ...pgQuery.mock.calls,
].filter(c => /UPDATE timesheet_approvals/i.test(String(c[0])));

const cascadeCalls = () => client.query.mock.calls.filter(c => /FROM user_profiles/i.test(String(c[0])));

const auditedIds = () => (auditMock.mock.calls as unknown as Array<[unknown, unknown, string, { entityId: string }]>)
  .map(c => c[3].entityId);

beforeEach(() => {
  vi.clearAllMocks();
  pgQuery.mockResolvedValue([]);
  db.deptUpdated = true;
  db.personal = null;
  db.cascadeError = null;
  client.query.mockImplementation(async (sql: string) => {
    if (/FROM user_profiles/i.test(sql)) {
      if (db.cascadeError) throw db.cascadeError;
      return { rows: db.personal ? [{ ...db.personal, status: 'draft', submitted_by: null }] : [] };
    }
    if (/UPDATE timesheet_approvals/i.test(sql)) {
      return {
        rows: db.deptUpdated
          ? [{
              id: 521, department_id: DEPT, manager_employee_id: null,
              start_date: RANGE.start_date, end_date: RANGE.end_date, status: 'draft',
              submitted_by: null, reviewed_by: null,
            }]
          : [],
      };
    }
    return { rows: [] };
  });
  pgTx.mockImplementation(async (fn: (c: typeof client) => Promise<unknown>) => fn(client));
  resolveScopedDeptMock.mockImplementation(async (_req: unknown, deptId: string | null) => deptId);
  resolveEditableDeptsMock.mockResolvedValue([DEPT]);
});

describe('recall — отзыв табеля', () => {
  it('руководитель отзывает поданный табель: 200, статус draft', async () => {
    mockApproval('submitted');
    const res = makeRes();

    await timesheetApprovalController.recall(makeReq(false), res);

    expect(res._status).toBe(200);
    expect((res._json as { data: { status: string } }).data.status).toBe('draft');
    // UPDATE отдела + попытка каскада (persona нет — строк не вернул).
    expect(updateCalls()).toHaveLength(2);
    expect(auditedIds()).toEqual(['521']);
  });

  it('руководитель НЕ отзывает утверждённый табель: 403, БД не трогаем', async () => {
    mockApproval('approved');
    const res = makeRes();

    await timesheetApprovalController.recall(makeReq(false), res);

    expect(res._status).toBe(403);
    expect((res._json as { code: string }).code).toBe('APPROVED_RECALL_FORBIDDEN');
    // Утверждение HR должно остаться на месте.
    expect(updateCalls()).toHaveLength(0);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('админ отзывает утверждённый табель: 200, статус draft', async () => {
    mockApproval('approved');
    const res = makeRes();

    await timesheetApprovalController.recall(makeReq(true), res);

    expect(res._status).toBe(200);
    expect((res._json as { data: { status: string; reviewed_by: string | null } }).data.status).toBe('draft');
    expect((res._json as { data: { reviewed_by: string | null } }).data.reviewed_by).toBeNull();
  });

  it('отзыв обнуляет открытие периода: unlock-поля не переживают возврат в draft', async () => {
    mockApproval('approved', { unlocked_at: '2026-06-20T10:00:00Z', unlocked_by: 'hr-uuid' });
    const res = makeRes();

    await timesheetApprovalController.recall(makeReq(true), res);

    expect(res._status).toBe(200);
    for (const call of updateCalls()) {
      const sql = String(call[0]);
      expect(sql).toContain('unlocked_at = NULL');
      expect(sql).toContain('unlocked_by = NULL');
      expect(sql).toContain('unlock_reason = NULL');
    }
  });

  it('из draft отзывать нечего: 409 (поведение прежнее)', async () => {
    mockApproval('draft');
    const res = makeRes();

    await timesheetApprovalController.recall(makeReq(true), res);

    expect(res._status).toBe(409);
    expect(updateCalls()).toHaveLength(0);
  });

  it('UPDATE отдела с guard по прочитанному статусу; гонка с кадрами → 409, без каскада и аудита', async () => {
    mockApproval('submitted');
    db.deptUpdated = false;
    const res = makeRes();

    await timesheetApprovalController.recall(makeReq(false), res);

    const [sql, params] = client.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/WHERE id = \$2 AND status = \$3/);
    expect(params.slice(1)).toEqual([521, 'submitted']);
    expect(res._status).toBe(409);
    expect(cascadeCalls()).toHaveLength(0);
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('recall отдела — каскад на persona-подачу автора', () => {
  const PERSONAL = {
    id: 2008, department_id: null, manager_employee_id: 768,
    start_date: RANGE.start_date, end_date: RANGE.end_date, status: 'submitted', submitted_by: AUTHOR,
  };

  it('отдел + persona submitted → оба в draft одной транзакцией, аудит по обоим', async () => {
    mockApproval('submitted');
    db.personal = PERSONAL;
    const res = makeRes();

    await timesheetApprovalController.recall(makeReq(false), res);

    expect(res._status).toBe(200);
    expect(pgTx).toHaveBeenCalledTimes(1);
    expect(updateCalls()).toHaveLength(2);
    const [sql, params] = cascadeCalls()[0] as [string, unknown[]];
    // Только submitted: approved persona — решение кадров, её не трогаем.
    expect(sql).toMatch(/p\.status = 'submitted'/);
    expect(sql).toContain('unlocked_at = NULL');
    // Тот же диапазон, автор — по подаче отдела.
    expect(params.slice(1)).toEqual([AUTHOR, RANGE.start_date, RANGE.end_date]);
    expect(auditedIds()).toEqual(['521', '2008']);
    const personalAudit = (auditMock.mock.calls as unknown as Array<[unknown, unknown, string, { details: Record<string, unknown> }]>)[1];
    expect(personalAudit[2]).toBe('TIMESHEET_APPROVAL_RECALLED');
    expect(personalAudit[3].details).toMatchObject({ auto_self_personal: true, to_status: 'draft', recalled_with_approval_id: 521 });
  });

  it('persona не submitted (approved / другой диапазон) — каскадный UPDATE ничего не вернул, аудита нет', async () => {
    mockApproval('submitted');
    db.personal = null;
    const res = makeRes();

    await timesheetApprovalController.recall(makeReq(false), res);

    expect(res._status).toBe(200);
    expect(cascadeCalls()).toHaveLength(1);
    expect(auditedIds()).toEqual(['521']);
  });

  it('отзыв persona-подачи (personal: true) — без каскада', async () => {
    pgQueryOne.mockResolvedValue({ ...PERSONAL });
    const res = makeRes();

    await timesheetApprovalController.recall(makeReq(false, { personal: true, department_id: undefined }), res);

    expect(res._status).toBe(200);
    expect(updateCalls()).toHaveLength(1);
    expect(cascadeCalls()).toHaveLength(0);
  });

  it('отдел отзывает админ → каскад на persona автора подачи, не админа', async () => {
    mockApproval('submitted');
    db.personal = PERSONAL;
    const res = makeRes();

    await timesheetApprovalController.recall(makeReq(true), res);

    expect(res._status).toBe(200);
    const [, params] = cascadeCalls()[0] as [string, unknown[]];
    expect(params[1]).toBe(AUTHOR);
  });

  it('сбой каскада → транзакция падает целиком: 500, аудита нет', async () => {
    mockApproval('submitted');
    db.personal = PERSONAL;
    db.cascadeError = new Error('boom');
    const res = makeRes();

    await timesheetApprovalController.recall(makeReq(false), res);

    expect(res._status).toBe(500);
    expect(auditMock).not.toHaveBeenCalled();
  });
});
