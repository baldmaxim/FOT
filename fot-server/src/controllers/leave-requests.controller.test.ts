import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const { pgQuery, pgQueryOne, pgExecute, pgTx, txClient } = vi.hoisted(() => {
  const txClient = { query: vi.fn() };
  return {
    pgQuery: vi.fn(),
    pgQueryOne: vi.fn(),
    pgExecute: vi.fn(),
    // withTransaction исполняет переданный колбэк с tx-клиентом и пробрасывает ошибки
    // (как настоящая реализация делает ROLLBACK и rethrow).
    pgTx: vi.fn(async (fn: (c: typeof txClient) => Promise<unknown>) => fn(txClient)),
    txClient,
  };
});

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: pgExecute,
  withTransaction: pgTx,
}));

const { upsertSpy } = vi.hoisted(() => ({ upsertSpy: vi.fn(async (..._args: unknown[]) => ({ id: 1 })) }));
vi.mock('../services/attendance.service.js', () => ({
  upsertAttendanceAdjustment: upsertSpy,
}));

vi.mock('../services/data-scope.service.js', () => ({
  canAccessEmployeeInScope: vi.fn(async () => true),
  canEditEmployeeInScope: vi.fn(async () => true),
  resolveAccessibleDepartmentIds: vi.fn(async () => []),
  resolveEditableDepartmentIds: vi.fn(async () => []),
  resolveManagedDepartmentIds: vi.fn(async () => []),
  resolveScopedDepartmentId: vi.fn(async () => null),
}));

const { responsiblesByEmpMock } = vi.hoisted(() => ({
  responsiblesByEmpMock: vi.fn(async () => new Map<number, number[]>()),
}));
vi.mock('../services/approval-routing.service.js', () => ({
  resolveResponsibleEmployeeIdsByEmployee: responsiblesByEmpMock,
}));

const { resolveApprovalMock } = vi.hoisted(() => ({
  resolveApprovalMock: vi.fn(async () => 'auto_approved'),
}));
vi.mock('./timesheet.controller.js', () => ({
  resolveAdjustmentApprovalStatus: resolveApprovalMock,
}));

vi.mock('../services/push.service.js', () => ({ pushService: { sendToUser: vi.fn(), sendLeaveRequestNotification: vi.fn(async () => []) } }));
vi.mock('../services/notification.service.js', () => ({ notificationService: { create: vi.fn(), createMany: vi.fn(async () => undefined) } }));
vi.mock('../socket/io-instance.js', () => ({ getIo: vi.fn(() => null) }));
vi.mock('../services/realtime-broadcast.service.js', () => ({ emitDomainChange: vi.fn() }));
vi.mock('../services/recipients.service.js', () => ({ getLeaveRequestRecipients: vi.fn(async () => []) }));
vi.mock('../services/employee-direct-reports.service.js', () => ({ listDirectSubordinates: vi.fn(async () => []) }));
import { resolveAccessibleDepartmentIds, resolveManagedDepartmentIds } from '../services/data-scope.service.js';
vi.mock('../services/employee-skud-object-access.service.js', () => ({ listSelectableObjectsForEmployee: vi.fn(async () => []) }));
vi.mock('../services/timesheet-object.service.js', () => ({ OBJECT_ADJUSTMENT_SOURCE_TYPE: 'manual_object' }));

import { leaveRequestsController } from './leave-requests.controller.js';

function makeReq(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    params: { id: '708' },
    query: {},
    body: {},
    user: {
      id: 'reviewer-uuid',
      email: 'mgr@example.com',
      position_type: 'header',
      employee_id: 7,
      department_id: 'dep-1',
      is_approved: true,
      two_factor_enabled: false,
      two_factor_verified: true,
    },
    ...overrides,
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

function mockRequestRow(over: Record<string, unknown>) {
  // 1-й queryOne → строка leave_requests; 2-й → автор (user_profiles).
  pgQueryOne
    .mockResolvedValueOnce({
      id: 708, employee_id: 247, status: 'pending', request_type: 'remote',
      start_date: '2026-05-30', end_date: '2026-05-30', selected_dates: null,
      correction_date: null, correction_status: null, correction_hours: null,
      correction_object_id: null, correction_object_name: null, reason: null,
      ...over,
    })
    .mockResolvedValueOnce({ id: 'author-uuid' });
}

describe('leaveRequestsController.approve', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveApprovalMock.mockResolvedValue('auto_approved');
    pgTx.mockImplementation(async (fn: (c: typeof txClient) => Promise<unknown>) => fn(txClient));
    txClient.query.mockResolvedValue({ rows: [{ id: 708, status: 'approved' }], rowCount: 1 });
  });

  it('одиночная remote-заявка на субботу материализует корректировку (не теряется)', async () => {
    mockRequestRow({ start_date: '2026-05-30', end_date: '2026-05-30' }); // 2026-05-30 = суббота
    const res = makeRes();

    await leaveRequestsController.approve(makeReq(), res);

    expect(res._status).toBe(200);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    const [payload, exec] = upsertSpy.mock.calls[0];
    expect(payload).toMatchObject({ employee_id: 247, work_date: '2026-05-30', status: 'remote', source_type: 'leave_request', source_id: '708' });
    expect(exec).toBe(txClient); // вставка идёт в той же транзакции
  });

  it('многодневный remote-диапазон по-прежнему пропускает выходные', async () => {
    mockRequestRow({ start_date: '2026-05-29', end_date: '2026-06-01' }); // Пт..Пн (30 Сб, 31 Вс)
    const res = makeRes();

    await leaveRequestsController.approve(makeReq(), res);

    const dates = upsertSpy.mock.calls.map(c => (c[0] as { work_date: string }).work_date).sort();
    expect(dates).toEqual(['2026-05-29', '2026-06-01']);
  });

  it('сбой создания корректировки откатывает одобрение (атомарность)', async () => {
    mockRequestRow({ start_date: '2026-05-30', end_date: '2026-05-30' });
    upsertSpy.mockRejectedValueOnce(new Error('insert failed'));
    const res = makeRes();

    await leaveRequestsController.approve(makeReq(), res);

    // Ошибка не проглочена «успехом»: 500, а смена статуса шла внутри транзакции (откатится).
    expect(res._status).toBe(500);
    expect(pgTx).toHaveBeenCalledTimes(1);
    const updateCall = txClient.query.mock.calls.find(c => String(c[0]).includes('UPDATE leave_requests'));
    expect(updateCall).toBeDefined();
  });

  it('work-заявка при одобрении (1-й этап) материализует корректировку через резолвер выходных', async () => {
    resolveApprovalMock.mockResolvedValueOnce('pending');
    // work — routed-тип: canManageLeaveRequest резолвит ответственного (зритель 7).
    responsiblesByEmpMock.mockResolvedValue(new Map([[247, [7]]]));
    pgQueryOne
      .mockResolvedValueOnce({
        id: 708, employee_id: 247, status: 'pending', request_type: 'work',
        start_date: '2026-06-06', end_date: '2026-06-06', selected_dates: ['2026-06-06'],
        correction_date: null, correction_status: null, correction_hours: null,
        correction_object_id: null, correction_object_name: null, reason: null,
      })
      .mockResolvedValueOnce({ org_department_id: 'dep-1' }) // canManageLeaveRequest
      .mockResolvedValueOnce({ id: 'author-uuid' }); // автор корректировки
    const res = makeRes();

    await leaveRequestsController.approve(makeReq(), res);

    expect(res._status).toBe(200);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy.mock.calls[0][0]).toMatchObject({
      employee_id: 247,
      work_date: '2026-06-06',
      status: 'work',
      approval_status: 'pending',
    });
  });
});

describe('leaveRequestsController.create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveApprovalMock.mockResolvedValue('auto_approved');
    pgTx.mockImplementation(async (fn: (c: typeof txClient) => Promise<unknown>) => fn(txClient));
  });

  it('work-заявка при создании НЕ материализует корректировки — сначала «Заявления»', async () => {
    txClient.query.mockResolvedValueOnce({
      rows: [{
        id: 900,
        employee_id: 247,
        request_type: 'work',
        status: 'pending',
        start_date: '2026-06-06',
        end_date: '2026-06-06',
        selected_dates: ['2026-06-06'],
        reason: 'работа в выходной',
      }],
      rowCount: 1,
    });
    const res = makeRes();

    await leaveRequestsController.create(makeReq({
      body: {
        request_type: 'work',
        start_date: '2026-06-06',
        end_date: '2026-06-06',
        selected_dates: ['2026-06-06'],
        reason: 'работа в выходной',
      },
      user: { ...makeReq().user, employee_id: 247 },
    } as Partial<AuthenticatedRequest>), res);

    expect(res._status).toBe(200);
    // Корректировки появятся только при одобрении в «Заявлениях» (approve) —
    // до этого заявка не должна попадать в очередь /approvals.
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(resolveApprovalMock).not.toHaveBeenCalled();
    expect(txClient.query.mock.calls.some(c => String(c[0]).includes("status = 'approved'"))).toBe(false);
    expect((res._json as { data: { status: string } }).data.status).toBe('pending');
  });
});

describe('leaveRequestsController.getAll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveAccessibleDepartmentIds).mockResolvedValue([]);
    responsiblesByEmpMock.mockResolvedValue(new Map());
  });

  it('админ (scope=all) видит все заявления, скрывая лишь work, ушедшее в approvals', async () => {
    // Админ: адресная маршрутизация не применяется — vacation остаётся видимой.
    vi.mocked(resolveAccessibleDepartmentIds).mockResolvedValue('all');
    pgQuery
      .mockResolvedValueOnce([
        { id: 1, employee_id: 101, request_type: 'work', status: 'pending', reviewer_id: null },
        { id: 2, employee_id: 102, request_type: 'vacation', status: 'pending', reviewer_id: null },
      ])
      .mockResolvedValueOnce([
        { id: 101, full_name: 'Работа В.', org_department_id: 'dep-1', department_name: 'ЦТ', position_name: null },
        { id: 102, full_name: 'Отпуск О.', org_department_id: 'dep-1', department_name: 'ЦТ', position_name: null },
      ])
      .mockResolvedValueOnce([{ source_id: '1' }])
      .mockResolvedValueOnce([]);
    const res = makeRes();

    await leaveRequestsController.getAll(makeReq({ query: { status: 'pending' } }), res);

    expect(res._status).toBe(200);
    expect((res._json as { data: Array<{ id: number }> }).data.map(r => r.id)).toEqual([2]);
    expect(responsiblesByEmpMock).not.toHaveBeenCalled();
  });
});

describe('leaveRequestsController.getDepartment (адресная маршрутизация)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks не чистит once-очередь: неиспользованные mockResolvedValueOnce
    // из теста с пустой выдачей утекали бы в следующий тест.
    pgQuery.mockReset();
    vi.mocked(resolveAccessibleDepartmentIds).mockResolvedValue([]);
    vi.mocked(resolveManagedDepartmentIds).mockResolvedValue(['dep-1']);
    responsiblesByEmpMock.mockResolvedValue(new Map());
  });

  const mockDeptQueries = () => {
    pgQuery
      // loadEmployeeIdsByDepartments
      .mockResolvedValueOnce([{ id: 102, full_name: 'Отпуск О.', org_department_id: 'dep-1' }])
      // data: leave_requests
      .mockResolvedValueOnce([{ id: 2, employee_id: 102, request_type: 'vacation', status: 'pending', reviewer_id: null }])
      // loadEmployeeMeta
      .mockResolvedValueOnce([{ id: 102, full_name: 'Отпуск О.', org_department_id: 'dep-1', department_name: 'ЦТ', position_name: null }])
      // loadAttachmentsByLeaveRequestIds
      .mockResolvedValueOnce([]);
  };

  it('ответственный (зритель) видит routed-заявку отпуска', async () => {
    responsiblesByEmpMock.mockResolvedValue(new Map([[102, [7]]])); // viewer employee_id = 7
    mockDeptQueries();
    const res = makeRes();

    await leaveRequestsController.getDepartment(makeReq(), res);

    expect(res._status).toBe(200);
    expect((res._json as { data: Array<{ id: number }> }).data.map(r => r.id)).toEqual([2]);
  });

  it('другой руководитель отдела (не ответственный) не видит routed-заявку', async () => {
    responsiblesByEmpMock.mockResolvedValue(new Map([[102, [999]]])); // ответственный — не зритель
    mockDeptQueries();
    const res = makeRes();

    await leaveRequestsController.getDepartment(makeReq(), res);

    expect(res._status).toBe(200);
    expect((res._json as { data: Array<{ id: number }> }).data).toEqual([]);
  });

  const mockWorkDeptQueries = () => {
    pgQuery
      // loadEmployeeIdsByDepartments
      .mockResolvedValueOnce([{ id: 102, full_name: 'Работник Р.', org_department_id: 'dep-1' }])
      // data: leave_requests
      .mockResolvedValueOnce([{ id: 3, employee_id: 102, request_type: 'work', status: 'pending', reviewer_id: null }])
      // loadEmployeeMeta
      .mockResolvedValueOnce([{ id: 102, full_name: 'Работник Р.', org_department_id: 'dep-1', department_name: 'ЦТ', position_name: null }])
      // loadWorkRequestIdsPendingInApprovals: pending-корректировок нет (новый флоу)
      .mockResolvedValueOnce([])
      // хвост: attachments / correction status
      .mockResolvedValue([]);
  };

  it('ответственный видит pending work-заявку в «Заявлениях» (1-й этап)', async () => {
    responsiblesByEmpMock.mockResolvedValue(new Map([[102, [7]]])); // viewer employee_id = 7
    mockWorkDeptQueries();
    const res = makeRes();

    await leaveRequestsController.getDepartment(makeReq(), res);

    expect(res._status).toBe(200);
    expect((res._json as { data: Array<{ id: number }> }).data.map(r => r.id)).toEqual([3]);
  });

  it('не-ответственный не видит pending work-заявку', async () => {
    responsiblesByEmpMock.mockResolvedValue(new Map([[102, [999]]]));
    mockWorkDeptQueries();
    const res = makeRes();

    await leaveRequestsController.getDepartment(makeReq(), res);

    expect(res._status).toBe(200);
    expect((res._json as { data: Array<{ id: number }> }).data).toEqual([]);
  });
});

describe('leaveRequestsController.approve (маршрутизация прав)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveAccessibleDepartmentIds).mockResolvedValue([]);
    responsiblesByEmpMock.mockResolvedValue(new Map());
    pgTx.mockImplementation(async (fn: (c: typeof txClient) => Promise<unknown>) => fn(txClient));
    txClient.query.mockResolvedValue({ rows: [{ id: 708, status: 'approved' }], rowCount: 1 });
  });

  it('не-ответственный получает 403 на одобрение routed-заявки (vacation)', async () => {
    // 1-й queryOne → строка заявки; внутри canManageLeaveRequest queryOne → org_department_id сотрудника.
    pgQueryOne
      .mockResolvedValueOnce({
        id: 708, employee_id: 247, status: 'pending', request_type: 'vacation',
        start_date: '2026-06-01', end_date: '2026-06-01', selected_dates: null,
        correction_date: null, correction_status: null, correction_hours: null,
        correction_object_id: null, correction_object_name: null, reason: null,
      })
      .mockResolvedValueOnce({ org_department_id: 'dep-1' });
    responsiblesByEmpMock.mockResolvedValue(new Map([[247, [999]]])); // ответственный ≠ зритель (7)
    const res = makeRes();

    await leaveRequestsController.approve(makeReq(), res);

    expect(res._status).toBe(403);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('не-ответственный получает 403 на одобрение work-заявки', async () => {
    pgQueryOne
      .mockResolvedValueOnce({
        id: 708, employee_id: 247, status: 'pending', request_type: 'work',
        start_date: '2026-06-06', end_date: '2026-06-06', selected_dates: ['2026-06-06'],
        correction_date: null, correction_status: null, correction_hours: null,
        correction_object_id: null, correction_object_name: null, reason: null,
      })
      .mockResolvedValueOnce({ org_department_id: 'dep-1' });
    responsiblesByEmpMock.mockResolvedValue(new Map([[247, [999]]])); // ответственный ≠ зритель (7)
    const res = makeRes();

    await leaveRequestsController.approve(makeReq(), res);

    expect(res._status).toBe(403);
    expect(upsertSpy).not.toHaveBeenCalled();
  });
});
