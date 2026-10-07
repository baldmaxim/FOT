import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Подача табеля с нерешёнными выходными разрешена: их решают и в поданном табеле
 * (статус «Ждёт согласования выходных»), а HR-утверждение до решения закрыто
 * (PENDING_CORRECTIONS_EXIST). Подачу блокирует только выход в выходной без
 * корректировки и без заявления.
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

const { mockValidate, mockCountPending } = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockCountPending: vi.fn(),
}));
vi.mock('../services/timesheet-approval-correction-validation.service.js', () => ({
  validateCorrectionAttachments: mockValidate,
}));
vi.mock('../services/timesheet-pending-decisions.service.js', () => ({
  countPendingDecisionsForApproval: mockCountPending,
  loadPendingDecisionFactsForApproval: vi.fn(async () => ({ days: [], requests: [] })),
  describePendingDecisions: vi.fn(async () => []),
}));
vi.mock('../services/timesheet-workflow-recipients.service.js', () => ({
  listTimesheetWorkflowRecipientIds: vi.fn(async () => ['hr-uuid']),
}));

const { mockLockMonths } = vi.hoisted(() => ({ mockLockMonths: vi.fn() }));
vi.mock('../services/timesheet-lock.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/timesheet-lock.service.js')>()),
  lockTimesheetMonthsOnClient: mockLockMonths,
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
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: vi.fn(async () => undefined) },
  AUDIT_ACTIONS: {},
}));
vi.mock('../services/realtime-broadcast.service.js', () => ({ emitDomainChange: vi.fn() }));
const { mockCreateMany } = vi.hoisted(() => ({ mockCreateMany: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock('../services/notification.service.js', () => ({
  notificationService: { createMany: mockCreateMany },
}));
vi.mock('../services/push.service.js', () => ({
  pushService: { sendToUsers: vi.fn(async () => undefined), sendGenericNotification: vi.fn(async () => []) },
}));
vi.mock('../middleware/cacheResponse.js', () => ({ invalidateCaches: vi.fn() }));
vi.mock('../services/timesheet-approval-history.service.js', () => ({
  timesheetApprovalHistoryService: { appendEvent: vi.fn(async () => undefined), listByApprovalId: vi.fn(async () => []) },
}));

import { timesheetApprovalController } from './timesheet-approval.controller.js';

const DEPT = 'c1d95c50-9bd8-4f76-8a45-eff44b1d7884';
const RANGE = { startDate: '2026-08-01', endDate: '2026-08-15' };
const MISSING = [{
  date: '2026-08-08',
  employee_id: 523,
  employee_name: 'Демчук Анна Александровна',
  kind: 'weekend_no_correction',
  reason: 'Работа в выходной без корректировки — создайте корректировку',
}];

const makeRes = () => {
  const res = { _status: 200, _json: undefined as unknown } as {
    _status: number; _json: unknown; status: (c: number) => unknown; json: (p: unknown) => unknown;
  };
  res.status = (code: number) => { res._status = code; return res; };
  res.json = (payload: unknown) => { res._json = payload; return res; };
  return res as unknown as { _status: number; _json: { code?: string; missing_days?: unknown } } & Parameters<
    typeof timesheetApprovalController.submit
  >[1];
};

const req = {
  params: {},
  query: {},
  body: { department_id: DEPT, start_date: RANGE.startDate, end_date: RANGE.endDate },
  user: {
    id: 'user-uuid', employee_id: 8783, is_admin: false,
    role_code: 'manager', timesheet_show_full_period: true,
  },
} as unknown as AuthenticatedRequest;

const client = { query: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  pgQuery.mockResolvedValue([]);
  pgQueryOne.mockResolvedValue(null);
  client.query.mockImplementation(async (sql: string) => (
    /INSERT INTO timesheet_approvals/i.test(String(sql))
      ? {
        rows: [{
          id: 1831, department_id: DEPT, manager_employee_id: null,
          start_date: RANGE.startDate, end_date: RANGE.endDate, status: 'submitted',
        }],
      }
      : { rows: [] }
  ));
  pgTx.mockImplementation(async (fn: (c: typeof client) => Promise<unknown>) => fn(client));
  // Сегодня 20.08.2026 (МСК): последний завершённый период — 01–15 августа.
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-20T12:00:00+03:00'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('timesheet-approval.submit — нерешённые выходные', () => {
  const notifiedBodies = () => mockCreateMany.mock.calls
    .flatMap(c => (c[0] as Array<{ body: string }>).map(n => n.body));

  it('выход в выходной без корректировки → 400 со списком дней, транзакции нет', async () => {
    mockValidate.mockResolvedValue({ ok: false, missing: MISSING });
    const res = makeRes();

    await timesheetApprovalController.submit(req, res);

    expect(res._status).toBe(400);
    expect(res._json.code).toBe('CORRECTION_VALIDATION_FAILED');
    expect(res._json.missing_days).toEqual(MISSING);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('нерешённые выходные подаче не мешают: подача пишется, под локом они не проверяются', async () => {
    mockValidate.mockResolvedValue({ ok: true });
    mockCountPending.mockResolvedValue(2);
    const res = makeRes();

    await timesheetApprovalController.submit(req, res);

    expect(res._status).toBe(200);
    const writes = client.query.mock.calls.map(c => String(c[0]));
    expect(writes.some(sql => /INSERT INTO timesheet_approvals/i.test(sql))).toBe(true);
    // Счётчик нерешённых — только для текста уведомления, вне транзакции подачи.
    for (const call of mockCountPending.mock.calls) expect(call[1]).toBeUndefined();
  });

  it('кадрам «Табель отправлен на проверку» с пометкой «ждёт согласования выходных»', async () => {
    mockValidate.mockResolvedValue({ ok: true });
    mockCountPending.mockResolvedValue(2);

    await timesheetApprovalController.submit(req, makeRes());

    await vi.waitFor(() => expect(mockCreateMany).toHaveBeenCalled());
    expect(notifiedBodies()).toEqual([expect.stringContaining('· ждёт согласования выходных.')]);
  });

  it('без нерешённых выходных — уведомление без пометки', async () => {
    mockValidate.mockResolvedValue({ ok: true });
    mockCountPending.mockResolvedValue(0);

    await timesheetApprovalController.submit(req, makeRes());

    await vi.waitFor(() => expect(mockCreateMany).toHaveBeenCalled());
    expect(notifiedBodies().some(body => body.includes('ждёт согласования выходных'))).toBe(false);
  });
});
