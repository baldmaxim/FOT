import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * POST /timesheet-approvals/close-month: валидация набора, скоуп на запись, запрет на
 * незавершённый месяц, бюджет запроса с remaining_ids и побочные эффекты строго по
 * реально изменённым подачам. Само закрытие — в тестах сервиса на PostgreSQL.
 */

const { closeMock, editableMock, completedMock, auditMock, emitMock, invalidateMock, recipientsMock, queryMock } =
  vi.hoisted(() => ({
    closeMock: vi.fn(),
    editableMock: vi.fn(),
    completedMock: vi.fn(),
    auditMock: vi.fn(async () => undefined),
    emitMock: vi.fn(),
    invalidateMock: vi.fn(),
    recipientsMock: vi.fn(async () => ['manager-user']),
    queryMock: vi.fn(),
  }));

vi.mock('../config/postgres.js', () => ({ query: queryMock }));
vi.mock('../services/timesheet-month-close.service.js', () => ({
  closeDepartmentMonth: closeMock,
  MONTH_CLOSE_COMMENT: 'Закрыт кадровой службой при выгрузке в 1С',
  monthHalfRanges: (month: string) => [
    { startDate: `${month}-01`, endDate: `${month}-15` },
    { startDate: `${month}-16`, endDate: `${month}-30` },
  ],
}));
vi.mock('../services/data-scope.service.js', () => ({ resolveEditableDepartmentIds: editableMock }));
vi.mock('../services/timesheet-period.service.js', () => ({ isRangeWithinCompletedPeriods: completedMock }));
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: auditMock },
  AUDIT_ACTIONS: {
    TIMESHEET_APPROVAL_APPROVED: 'TIMESHEET_APPROVAL_APPROVED',
    TIMESHEET_APPROVAL_CLOSED: 'TIMESHEET_APPROVAL_CLOSED',
  },
}));
vi.mock('../services/realtime-broadcast.service.js', () => ({ emitDomainChange: emitMock }));
vi.mock('../middleware/cacheResponse.js', () => ({ invalidateCaches: invalidateMock }));
vi.mock('../services/timesheet-workflow-recipients.service.js', () => ({
  listTimesheetWorkflowRecipientIds: recipientsMock,
}));

import { closeTimesheetMonth } from './timesheet-month-close.controller.js';

const DEPT_A = '00000000-0000-4000-8000-0000000000a1';
const DEPT_B = '00000000-0000-4000-8000-0000000000a2';
const DEPT_C = '00000000-0000-4000-8000-0000000000a3';

const makeReq = (body: unknown): AuthenticatedRequest => ({
  body,
  user: { id: 'hr-user', is_admin: false },
  headers: {},
  socket: {},
}) as unknown as AuthenticatedRequest;

const makeRes = () => {
  const res = { statusCode: 200, body: null as unknown } as { statusCode: number; body: unknown } & Partial<Response>;
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json = vi.fn((payload: unknown) => { res.body = payload; return res as Response; });
  return res as { statusCode: number; body: { success: boolean; code?: string; data?: {
    results: Array<{ department_id: string; name: string | null; halves: unknown[] }>;
    remaining_ids: string[];
  } } } & Response;
};

const halves = (status: string) => [
  { start_date: '2026-09-01', end_date: '2026-09-15', status },
  { start_date: '2026-09-16', end_date: '2026-09-30', status },
];

describe('closeTimesheetMonth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    editableMock.mockResolvedValue('all');
    completedMock.mockReturnValue(true);
    queryMock.mockResolvedValue([{ id: DEPT_A, name: 'бр.А' }, { id: DEPT_B, name: 'бр.Б' }]);
    closeMock.mockResolvedValue({ halves: halves('already_closed'), changes: [], errors: [] });
  });

  it.each([
    ['месяц не в формате ГГГГ-ММ', { month: '2026-9', department_ids: [DEPT_A] }],
    ['тринадцатый месяц', { month: '2026-13', department_ids: [DEPT_A] }],
    ['пустой набор', { month: '2026-09', department_ids: [] }],
    ['не UUID', { month: '2026-09', department_ids: ['abc'] }],
    ['больше 10 отделов', {
      month: '2026-09',
      department_ids: Array.from({ length: 11 }, (_unused, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`),
    }],
    ['повтор отдела', { month: '2026-09', department_ids: [DEPT_A, DEPT_A.toUpperCase()] }],
  ])('400: %s', async (_label, body) => {
    const res = makeRes();
    await closeTimesheetMonth(makeReq(body), res);

    expect(res.statusCode).toBe(400);
    expect(closeMock).not.toHaveBeenCalled();
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it('403 на весь запрос, если хотя бы один отдел вне скоупа на запись', async () => {
    editableMock.mockResolvedValue([DEPT_A]);
    const res = makeRes();

    await closeTimesheetMonth(makeReq({ month: '2026-09', department_ids: [DEPT_A, DEPT_B] }), res);

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('DEPARTMENT_ACCESS_DENIED');
    expect(closeMock).not.toHaveBeenCalled();
  });

  it('409, если месяц не завершён: проверяется диапазон с 1-го по последний день', async () => {
    completedMock.mockReturnValue(false);
    const res = makeRes();

    await closeTimesheetMonth(makeReq({ month: '2026-09', department_ids: [DEPT_A] }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('MONTH_NOT_COMPLETED');
    expect(completedMock).toHaveBeenCalledWith('2026-09-01', '2026-09-30');
    expect(closeMock).not.toHaveBeenCalled();
  });

  it('аудит и realtime — по каждой изменённой подаче; без изменений — ничего', async () => {
    closeMock
      .mockResolvedValueOnce({
        halves: halves('closed'),
        errors: [],
        changes: [
          { approvalId: 11, kind: 'approved', fromStatus: null,
            startDate: '2026-09-01', endDate: '2026-09-15', submittedBy: null },
          { approvalId: 12, kind: 'closed', fromStatus: 'approved',
            startDate: '2026-09-16', endDate: '2026-09-30', submittedBy: 'manager-user' },
        ],
      })
      .mockResolvedValueOnce({ halves: halves('already_closed'), changes: [], errors: [] });
    const res = makeRes();

    await closeTimesheetMonth(makeReq({ month: '2026-09', department_ids: [DEPT_A, DEPT_B] }), res);

    expect(res.statusCode).toBe(200);
    expect(closeMock.mock.calls.map(call => call.slice(0, 3))).toEqual([
      ['hr-user', DEPT_A, '2026-09'],
      ['hr-user', DEPT_B, '2026-09'],
    ]);
    expect(auditMock).toHaveBeenCalledTimes(2);
    expect(auditMock.mock.calls[0].slice(2)).toEqual(['TIMESHEET_APPROVAL_APPROVED', {
      entityType: 'timesheet_approval',
      entityId: '11',
      details: expect.objectContaining({
        department_id: DEPT_A, department_name: 'бр.А', from_status: null, to_status: 'approved', forced: true,
      }),
    }]);
    // Открытая утверждённая: только «закрыт», как у штатного «Закрыть табель».
    expect(auditMock.mock.calls[1].slice(2)).toEqual(['TIMESHEET_APPROVAL_CLOSED', {
      entityType: 'timesheet_approval',
      entityId: '12',
      details: expect.objectContaining({ department_id: DEPT_A, status: 'approved' }),
    }]);
    expect(emitMock).toHaveBeenCalledTimes(2);
    expect(recipientsMock).toHaveBeenCalledWith(DEPT_A, ['submit', 'review', 'monitor']);
    expect(res.body.data).toEqual({
      results: [
        { department_id: DEPT_A, name: 'бр.А', halves: halves('closed') },
        { department_id: DEPT_B, name: 'бр.Б', halves: halves('already_closed') },
      ],
      remaining_ids: [],
    });
    expect(invalidateMock).toHaveBeenCalledWith(
      'timesheet', 'timesheet:today', 'timesheet:overview', 'timesheet:overview:today', 'timesheet-1c-status',
    );
  });

  it('бюджет исчерпан: начатый отдел доводится, остальные уходят в remaining_ids', async () => {
    vi.useFakeTimers();
    closeMock.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(21_000);
      return { halves: halves('closed'), changes: [], errors: [] };
    });
    const res = makeRes();

    await closeTimesheetMonth(makeReq({ month: '2026-09', department_ids: [DEPT_A, DEPT_B, DEPT_C] }), res);

    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(res.body.data?.results.map(result => result.department_id)).toEqual([DEPT_A]);
    expect(res.body.data?.remaining_ids).toEqual([DEPT_B, DEPT_C]);
  });

  it('сбой посреди набора: 500, но кэши сброшены — часть подач уже изменилась', async () => {
    closeMock
      .mockResolvedValueOnce({ halves: halves('closed'), changes: [], errors: [] })
      .mockRejectedValueOnce(new Error('pool exhausted'));
    const res = makeRes();

    await closeTimesheetMonth(makeReq({ month: '2026-09', department_ids: [DEPT_A, DEPT_B] }), res);

    expect(res.statusCode).toBe(500);
    expect(invalidateMock).toHaveBeenCalledTimes(1);
  });

  it('сбой аудита не валит закрытие', async () => {
    auditMock.mockRejectedValueOnce(new Error('audit down'));
    closeMock.mockResolvedValueOnce({
      halves: halves('closed'),
      errors: [],
      changes: [{ approvalId: 11, kind: 'approved', fromStatus: 'submitted',
        startDate: '2026-09-01', endDate: '2026-09-15', submittedBy: 'manager-user' }],
    });
    const res = makeRes();

    await closeTimesheetMonth(makeReq({ month: '2026-09', department_ids: [DEPT_A] }), res);

    expect(res.statusCode).toBe(200);
    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({
      event: 'timesheet_approval:changed',
      targetUserIds: expect.arrayContaining(['hr-user', 'manager-user']),
    }));
  });
});
