import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Сверка авто-persona подачи руководителя после подачи отдела (кейс Карасени).
 *
 * Строку руководителя подаёт его собственный отдел, если у отдела есть владелец табеля;
 * тогда состав persona пуст, и оставшаяся от прошлых подач submitted/rejected уходит в
 * пустой черновик — иначе её замок держал строку, хотя отдел уже отозван. Сверка идёт и
 * на повторной подаче уже поданного отдела, каждый UPDATE — с guard по статусу, а при
 * неизменном составе ничего не пишется.
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
  execute: vi.fn(async () => 1),
  withTransaction: pgTx,
}));

const { compositionMock } = vi.hoisted(() => ({ compositionMock: vi.fn() }));
vi.mock('../services/timesheet-approval-employees-snapshot.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/timesheet-approval-employees-snapshot.service.js')>()),
  resolveManagerPersonalSnapshotIds: compositionMock,
}));

vi.mock('../services/timesheet-approval-correction-validation.service.js', () => ({
  validateCorrectionAttachments: vi.fn(async () => ({ ok: true })),
  listPendingCorrectionDays: vi.fn(async () => []),
}));
vi.mock('../services/timesheet-lock.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/timesheet-lock.service.js')>()),
  lockTimesheetMonthsOnClient: vi.fn(async () => undefined),
}));
vi.mock('../services/timesheet-department-assignments.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/timesheet-department-assignments.service.js')>()),
  listEmployeeIdsAssignedToDepartmentPeriod: vi.fn(async () => [523]),
}));
vi.mock('../services/data-scope.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/data-scope.service.js')>()),
  resolveTimesheetEditableDepartmentIds: vi.fn(async () => 'all'),
}));
vi.mock('../services/correction-restrictions.service.js', () => ({
  loadRoleRestrictions: vi.fn(async () => ({ weekend_memo_required: false })),
}));
vi.mock('../services/timesheet-approval-weekend-check.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/timesheet-approval-weekend-check.service.js')>()),
  checkManagerObjWeekendMemoRequirement: vi.fn(async () => ({
    required: false, satisfied: true, weekendWorkDates: [],
  })),
}));
vi.mock('../services/access-control.service.js', () => ({
  resolveEffectivePageAccess: vi.fn(async () => false),
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
  pushService: { sendToUsers: vi.fn(async () => undefined), sendGenericNotification: vi.fn(async () => undefined) },
}));
vi.mock('../middleware/cacheResponse.js', () => ({ invalidateCaches: vi.fn() }));

import { timesheetApprovalController } from './timesheet-approval.controller.js';

const DEPT = '319e3fbb-85ba-4eb6-8b88-b477083aeec0'; // «Закупка.Про» — Карасени в нём не числится
const RANGE = { startDate: '2026-08-01', endDate: '2026-08-15' };
const MANAGER = 768;
const PERSONAL_ID = 2008;
const SUB = 501;

const makeRes = () => {
  const res = { _status: 200, _json: undefined as unknown } as {
    _status: number; _json: unknown; status: (c: number) => unknown; json: (p: unknown) => unknown;
  };
  res.status = (code: number) => { res._status = code; return res; };
  res.json = (payload: unknown) => { res._json = payload; return res; };
  return res as unknown as { _status: number; _json: unknown } & Parameters<
    typeof timesheetApprovalController.submit
  >[1];
};

const req = {
  params: {},
  query: {},
  body: { department_id: DEPT, start_date: RANGE.startDate, end_date: RANGE.endDate },
  user: {
    id: 'karaseni-uuid', employee_id: MANAGER, is_admin: false,
    role_code: 'manager', timesheet_show_full_period: true,
  },
} as unknown as AuthenticatedRequest;

/** Состояние «БД» сценария. */
const db = {
  /** Подачи отдела, пересекающие диапазон (для повторной подачи — уже поданная). */
  deptOverlaps: [] as Array<Record<string, unknown>>,
  /** Persona-подача руководителя за тот же диапазон. */
  personal: null as Record<string, unknown> | null,
  /** Статус persona под FOR UPDATE (гонка с кадрами). */
  lockedStatus: null as string | null,
  /** Вернёт ли guarded UPDATE persona строку. */
  personalUpdateHits: true,
  /** Текущий снимок persona. */
  personalSnapshot: [] as number[],
};

const client = { query: vi.fn() };

const sqlCalls = () => client.query.mock.calls.map(c => [String(c[0]), (c[1] ?? []) as unknown[]] as const);

/** Записи, касающиеся persona-подачи (UPDATE статуса, снимок). */
const personalWrites = () => sqlCalls().filter(([sql, params]) =>
  (/UPDATE timesheet_approvals/i.test(sql) && params.includes(PERSONAL_ID))
  || (/timesheet_approval_employees/i.test(sql) && /DELETE|INSERT/i.test(sql) && params[0] === PERSONAL_ID));

const audits = () => (auditMock.mock.calls as unknown as Array<[unknown, unknown, string, {
  entityId: string; details: Record<string, unknown>;
}]>).map(c => ({ action: c[2], entityId: c[3].entityId, details: c[3].details }));

const personalAudits = () => audits().filter(a => a.entityId === String(PERSONAL_ID));

beforeEach(() => {
  vi.clearAllMocks();
  db.deptOverlaps = [];
  db.personal = null;
  db.lockedStatus = null;
  db.personalUpdateHits = true;
  db.personalSnapshot = [];
  compositionMock.mockResolvedValue([]);

  pgQuery.mockImplementation(async (sql: string) => {
    if (/FROM timesheet_approvals\s+WHERE department_id = \$1 AND manager_employee_id IS NULL/i.test(sql)) {
      return db.deptOverlaps;
    }
    return [];
  });
  pgQueryOne.mockImplementation(async (sql: string) => {
    if (/WHERE manager_employee_id = \$1 AND start_date = \$2 AND end_date = \$3/i.test(sql)) return db.personal;
    if (/FROM employees WHERE id = \$1/i.test(sql)) return { org_department_id: 'ebfc54cc-mto' };
    return null;
  });
  client.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/INSERT INTO timesheet_approvals/i.test(sql)) {
      const personal = params[0] === MANAGER;
      return { rows: [{ id: personal ? PERSONAL_ID : 900, status: 'submitted', manager_employee_id: personal ? MANAGER : null }] };
    }
    if (/FOR UPDATE/i.test(sql)) return { rows: [{ status: db.lockedStatus ?? db.personal?.status }] };
    if (/UPDATE timesheet_approvals/i.test(sql)) {
      if (!db.personalUpdateHits) return { rows: [] };
      const toDraft = /status = 'draft'/.test(sql);
      return { rows: [{ ...db.personal, status: toDraft ? 'draft' : 'submitted' }] };
    }
    if (/SELECT employee_id, full_name\s+FROM timesheet_approval_employees/i.test(sql)) {
      return { rows: db.personalSnapshot.map(id => ({ employee_id: String(id), full_name: `Сотрудник ${id}` })) };
    }
    if (/SELECT id, full_name FROM employees/i.test(sql)) {
      return { rows: (params[0] as number[]).map(id => ({ id, full_name: `Сотрудник ${id}` })) };
    }
    return { rows: [] };
  });
  pgTx.mockImplementation(async (fn: (c: typeof client) => Promise<unknown>) => fn(client));
  // Сегодня 20.08.2026 (МСК): последний завершённый период — 01–15 августа.
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-20T12:00:00+03:00'));
});

afterEach(() => {
  vi.useRealTimers();
});

const personalRow = (status: string) => ({
  id: PERSONAL_ID, department_id: null, manager_employee_id: MANAGER,
  start_date: RANGE.startDate, end_date: RANGE.endDate, status, submitted_by: 'karaseni-uuid',
});

describe('подача чужого отдела: persona со строкой руководителя больше не нужна', () => {
  it('stale submitted → пустой черновик: guarded UPDATE, DELETE снимка без INSERT, аудит', async () => {
    db.personal = personalRow('submitted');
    db.personalSnapshot = [MANAGER];
    const res = makeRes();

    await timesheetApprovalController.submit(req, res);

    expect(res._status).toBe(200);
    expect(compositionMock).toHaveBeenCalledWith(MANAGER, RANGE.startDate, RANGE.endDate);
    const writes = personalWrites();
    expect(writes).toHaveLength(2);
    const [updateSql, updateParams] = writes[0];
    expect(updateSql).toMatch(/status = 'draft'/);
    expect(updateSql).toMatch(/WHERE id = \$2 AND status = \$3/);
    for (const field of ['submitted_by', 'submitted_at', 'reviewed_by', 'reviewed_at', 'review_comment',
      'unlocked_at', 'unlocked_by', 'unlock_reason']) {
      expect(updateSql).toContain(`${field} = NULL`);
    }
    expect(updateParams.slice(1)).toEqual([PERSONAL_ID, 'submitted']);
    expect(writes[1][0]).toMatch(/DELETE FROM timesheet_approval_employees/);
    expect(sqlCalls().some(([sql, params]) =>
      /INSERT INTO timesheet_approval_employees/i.test(sql) && params[0] === PERSONAL_ID)).toBe(false);
    expect(personalAudits()).toEqual([{
      action: 'TIMESHEET_APPROVAL_RECALLED',
      entityId: String(PERSONAL_ID),
      details: expect.objectContaining({
        auto_self_personal: true, from_status: 'submitted', to_status: 'draft', manager_employee_id: MANAGER,
      }),
    }]);
  });

  it('stale rejected (кадры отклонили до деплоя) → тоже пустой черновик', async () => {
    db.personal = personalRow('rejected');
    const res = makeRes();

    await timesheetApprovalController.submit(req, res);

    const [, updateParams] = personalWrites()[0];
    expect(updateParams.slice(1)).toEqual([PERSONAL_ID, 'rejected']);
    expect(personalAudits()[0].details).toMatchObject({ from_status: 'rejected', to_status: 'draft' });
  });

  it.each(['approved', 'returned', 'draft'])('persona %s → не трогаем', async (status) => {
    db.personal = personalRow(status);
    const res = makeRes();

    await timesheetApprovalController.submit(req, res);

    expect(res._status).toBe(200);
    expect(personalWrites()).toHaveLength(0);
    expect(personalAudits()).toHaveLength(0);
  });

  it('гонка: guarded UPDATE не нашёл строку → ни очистки снимка, ни аудита', async () => {
    db.personal = personalRow('submitted');
    db.personalUpdateHits = false;
    const res = makeRes();

    await timesheetApprovalController.submit(req, res);

    expect(res._status).toBe(200);
    expect(personalWrites()).toHaveLength(1); // только сам UPDATE
    expect(personalAudits()).toHaveLength(0);
  });

  it('persona нет и состав пуст → ничего не создаётся', async () => {
    const res = makeRes();

    await timesheetApprovalController.submit(req, res);

    expect(sqlCalls().some(([sql, params]) =>
      /INSERT INTO timesheet_approvals/i.test(sql) && params[0] === MANAGER)).toBe(false);
    expect(personalAudits()).toHaveLength(0);
  });
});

describe('повторная подача уже поданного отдела тоже сводит persona', () => {
  beforeEach(() => {
    db.deptOverlaps = [{
      id: 900, department_id: DEPT, manager_employee_id: null,
      start_date: RANGE.startDate, end_date: RANGE.endDate, status: 'submitted',
    }];
  });

  it('отдел submitted + stale persona submitted → persona в черновик, новой строки нет', async () => {
    db.personal = personalRow('submitted');
    const res = makeRes();

    await timesheetApprovalController.submit(req, res);

    expect(res._status).toBe(200);
    expect((res._json as { data: { id: number } }).data.id).toBe(900);
    expect(sqlCalls().some(([sql]) => /INSERT INTO timesheet_approvals/i.test(sql))).toBe(false);
    expect(personalAudits().map(a => a.action)).toEqual(['TIMESHEET_APPROVAL_RECALLED']);
  });

  it('всё уже сведено → повторный submit ничего не пишет и не аудирует', async () => {
    compositionMock.mockResolvedValue([SUB]);
    db.personal = personalRow('submitted');
    db.personalSnapshot = [SUB];
    // Снимок отдела тот же, что вернёт listEmployeeIdsAssignedToDepartmentPeriod.
    client.query.mockImplementationOnce(async () => ({ rows: [{ employee_id: '523', full_name: 'Сотрудник 523' }] }));
    const res = makeRes();

    await timesheetApprovalController.submit(req, res);

    expect(res._status).toBe(200);
    expect(personalWrites()).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });
});

describe('persona с лично назначенными: состав не пуст', () => {
  it('submitted с другим составом → пересборка снимка под FOR UPDATE + ROSTER_REBUILT', async () => {
    compositionMock.mockResolvedValue([SUB]);
    db.personal = personalRow('submitted');
    db.personalSnapshot = [MANAGER, SUB];
    const res = makeRes();

    await timesheetApprovalController.submit(req, res);

    const calls = sqlCalls();
    const lockIndex = calls.findIndex(([sql, params]) => /FOR UPDATE/i.test(sql) && params[0] === PERSONAL_ID);
    const insertIndex = calls.findIndex(([sql, params]) =>
      /INSERT INTO timesheet_approval_employees/i.test(sql) && params[0] === PERSONAL_ID);
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(insertIndex).toBeGreaterThan(lockIndex);
    expect(calls[insertIndex][1][1]).toEqual([SUB]);
    expect(personalWrites().some(([sql]) => /UPDATE timesheet_approvals/i.test(sql))).toBe(false);
    expect(personalAudits()).toEqual([{
      action: 'TIMESHEET_APPROVAL_ROSTER_REBUILT',
      entityId: String(PERSONAL_ID),
      details: expect.objectContaining({ removed_employee_ids: [MANAGER], added_employee_ids: [], auto_self_personal: true }),
    }]);
  });

  it('под FOR UPDATE persona уже утверждена → снимок не трогаем', async () => {
    compositionMock.mockResolvedValue([SUB]);
    db.personal = personalRow('submitted');
    db.lockedStatus = 'approved';
    db.personalSnapshot = [MANAGER, SUB];
    const res = makeRes();

    await timesheetApprovalController.submit(req, res);

    expect(personalWrites()).toHaveLength(0);
    expect(personalAudits()).toHaveLength(0);
  });

  it('draft → submitted с guard по статусу, снимок и событие подачи', async () => {
    compositionMock.mockResolvedValue([SUB]);
    db.personal = personalRow('draft');
    const res = makeRes();

    await timesheetApprovalController.submit(req, res);

    const [updateSql, updateParams] = personalWrites()[0];
    expect(updateSql).toMatch(/SET status = 'submitted'/);
    expect(updateSql).toMatch(/WHERE id = \$3 AND status = \$4/);
    expect(updateParams.slice(2)).toEqual([PERSONAL_ID, 'draft']);
    expect(personalAudits()).toEqual([{
      action: 'TIMESHEET_APPROVAL_SUBMITTED',
      entityId: String(PERSONAL_ID),
      details: expect.objectContaining({ from_status: 'draft', to_status: 'submitted', auto_self_personal: true }),
    }]);
  });
});
