import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Подача табеля с несогласованными корректировками запрещена: поданный табель закрыт,
 * решение по ним после подачи невозможно, а HR-утверждение упирается в
 * PENDING_CORRECTIONS_EXIST. Внешняя проверка даёт список дней, но авторитетна повторная
 * — под advisory-локом подачи: корректировка, сохранённая между ними, иначе застряла бы.
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

const { mockValidate, mockListPending } = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockListPending: vi.fn(),
}));
vi.mock('../services/timesheet-approval-correction-validation.service.js', () => ({
  validateCorrectionAttachments: mockValidate,
  listPendingCorrectionDays: mockListPending,
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
vi.mock('../services/notification.service.js', () => ({
  notificationService: { createMany: vi.fn(async () => undefined) },
}));
vi.mock('../services/push.service.js', () => ({
  pushService: { sendToUsers: vi.fn(async () => undefined) },
}));
vi.mock('../middleware/cacheResponse.js', () => ({ invalidateCaches: vi.fn() }));

import { timesheetApprovalController } from './timesheet-approval.controller.js';

const DEPT = 'c1d95c50-9bd8-4f76-8a45-eff44b1d7884';
const RANGE = { startDate: '2026-08-01', endDate: '2026-08-15' };
const MISSING = [{
  date: '2026-08-08',
  employee_id: 523,
  employee_name: 'Демчук Анна Александровна',
  kind: 'pending_correction',
  reason: 'Корректировка не согласована ответственным',
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
  client.query.mockResolvedValue({ rows: [] });
  pgTx.mockImplementation(async (fn: (c: typeof client) => Promise<unknown>) => fn(client));
  // Сегодня 20.08.2026 (МСК): последний завершённый период — 01–15 августа.
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-20T12:00:00+03:00'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('timesheet-approval.submit — несогласованные корректировки', () => {
  it('pending найден внешней проверкой → 400 со списком дней, транзакции нет', async () => {
    mockValidate.mockResolvedValue({ ok: false, missing: MISSING });
    const res = makeRes();

    await timesheetApprovalController.submit(req, res);

    expect(res._status).toBe(400);
    expect(res._json.code).toBe('CORRECTION_VALIDATION_FAILED');
    expect(res._json.missing_days).toEqual(MISSING);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('pending появился после внешней проверки → под локом откат, статус submitted не пишется', async () => {
    mockValidate
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, missing: MISSING });
    mockListPending.mockResolvedValue([{ employee_id: 523, work_date: '2026-08-08' }]);
    const res = makeRes();

    await timesheetApprovalController.submit(req, res);

    expect(mockListPending).toHaveBeenCalledWith(
      { kind: 'department', departmentId: DEPT }, RANGE, client,
    );
    expect(mockLockMonths.mock.invocationCallOrder[0])
      .toBeLessThan(mockListPending.mock.invocationCallOrder[0]);
    const writes = client.query.mock.calls.map(c => String(c[0]));
    expect(writes.some(sql => /timesheet_approvals/i.test(sql))).toBe(false);
    expect(res._status).toBe(400);
    expect(res._json.code).toBe('CORRECTION_VALIDATION_FAILED');
    expect(res._json.missing_days).toEqual(MISSING);
  });

  it('под локом pending нет → подача пишется в той же транзакции', async () => {
    mockValidate.mockResolvedValue({ ok: true });
    mockListPending.mockResolvedValue([]);
    const res = makeRes();

    await timesheetApprovalController.submit(req, res);

    const writes = client.query.mock.calls.map(c => String(c[0]));
    expect(writes.some(sql => /INSERT INTO timesheet_approvals/i.test(sql))).toBe(true);
    expect(mockListPending.mock.invocationCallOrder[0])
      .toBeLessThan(client.query.mock.invocationCallOrder[
        writes.findIndex(sql => /INSERT INTO timesheet_approvals/i.test(sql))
      ]);
  });
});
