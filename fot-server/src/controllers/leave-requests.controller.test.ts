import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

// Годовые границы validateLeaveRequestPeriod ([тек−1, тек+5]) зависят от «сейчас».
// Фиксируем только Date (setTimeout остаётся настоящим, чтобы async-моки не ломались),
// иначе тесты с датами 2026 стали бы хрупкими после 2031.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-06-29T00:00:00Z'));
});
afterAll(() => {
  vi.useRealTimers();
});

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

const { weekendResponsibleMock } = vi.hoisted(() => ({
  weekendResponsibleMock: vi.fn(async (): Promise<number | null> => null),
}));
vi.mock('../services/weekend-approval-assignments.service.js', () => ({
  resolveResponsibleEmployeeForTarget: weekendResponsibleMock,
}));

vi.mock('../services/push.service.js', () => ({ pushService: { sendToUser: vi.fn(), sendLeaveRequestNotification: vi.fn(async () => []), sendGenericNotification: vi.fn(async () => []) } }));
vi.mock('../services/notification.service.js', () => ({ notificationService: { create: vi.fn(), createMany: vi.fn(async () => undefined) } }));
vi.mock('../socket/io-instance.js', () => ({ getIo: vi.fn(() => null) }));
vi.mock('../services/realtime-broadcast.service.js', () => ({ emitDomainChange: vi.fn() }));
vi.mock('../services/recipients.service.js', () => ({ getLeaveRequestRecipients: vi.fn(async () => []), getEmployeeUserId: vi.fn(async () => 'emp-user-uuid') }));
// Детерминированное «сегодня» (Europe/Moscow) для проверок будущности отпуска.
vi.mock('../utils/date.utils.js', () => ({ moscowTodayIso: vi.fn(() => '2026-06-29') }));
vi.mock('../services/employee-direct-reports.service.js', () => ({ listDirectSubordinates: vi.fn(async () => []) }));
import { resolveAccessibleDepartmentIds, resolveManagedDepartmentIds } from '../services/data-scope.service.js';
vi.mock('../services/employee-skud-object-access.service.js', () => ({ listSelectableObjectsForEmployee: vi.fn(async () => []) }));
vi.mock('../services/timesheet-object.service.js', () => ({ OBJECT_ADJUSTMENT_SOURCE_TYPE: 'manual_object' }));

import {
  leaveRequestsController,
  validateLeaveRequestPeriod,
  MAX_MATERIALIZED_LEAVE_DAYS,
} from './leave-requests.controller.js';
import { notificationService } from '../services/notification.service.js';

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

  it('одобряющий — ответственный за выходные: 2-й этап схлопывается в approved', async () => {
    resolveApprovalMock.mockResolvedValueOnce('pending');
    responsiblesByEmpMock.mockResolvedValue(new Map([[247, [7]]]));
    weekendResponsibleMock.mockResolvedValueOnce(7); // ответственный = одобряющий (employee_id 7)
    pgQueryOne
      .mockResolvedValueOnce({
        id: 708, employee_id: 247, status: 'pending', request_type: 'work',
        start_date: '2026-06-06', end_date: '2026-06-06', selected_dates: ['2026-06-06'],
        correction_date: null, correction_status: null, correction_hours: null,
        correction_object_id: null, correction_object_name: null, reason: null,
      })
      .mockResolvedValueOnce({ org_department_id: 'dep-1' }) // canManageLeaveRequest
      .mockResolvedValueOnce({ id: 'author-uuid' }) // автор корректировки
      .mockResolvedValueOnce({ org_department_id: 'dep-1' }); // отдел для схлопывания
    const res = makeRes();

    await leaveRequestsController.approve(makeReq(), res);

    expect(res._status).toBe(200);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy.mock.calls[0][0]).toMatchObject({
      employee_id: 247,
      work_date: '2026-06-06',
      approval_status: 'approved',
      approved_by: 'reviewer-uuid',
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

describe('validateLeaveRequestPeriod (сейчас = 2026, диапазон годов 2025–2031)', () => {
  it('обычный однодневный отпуск в пределах — ok', () => {
    expect(validateLeaveRequestPeriod('2026-07-31', '2026-07-31')).toEqual({ ok: true });
  });

  it('битый год 0026 (диапазон) — отклоняется', () => {
    const r = validateLeaveRequestPeriod('0026-07-31', '2026-07-31');
    expect(r.ok).toBe(false);
  });

  it('битый год 0026 (одиночная 0026→0026) — отклоняется, хотя span=1', () => {
    const r = validateLeaveRequestPeriod('0026-07-31', '0026-07-31');
    expect(r.ok).toBe(false);
  });

  it('несуществующая календарная дата 2026-02-31 — отклоняется', () => {
    expect(validateLeaveRequestPeriod('2026-02-31', '2026-02-31').ok).toBe(false);
  });

  it('start > end — отклоняется', () => {
    expect(validateLeaveRequestPeriod('2026-08-10', '2026-08-01').ok).toBe(false);
  });

  it(`ровно ${MAX_MATERIALIZED_LEAVE_DAYS} дней — ok, +1 — отклоняется`, () => {
    // 2026-01-01 → 2027-01-01 включительно = 366 дней; +1 день = 367.
    expect(validateLeaveRequestPeriod('2026-01-01', '2027-01-01').ok).toBe(true);
    expect(validateLeaveRequestPeriod('2026-01-01', '2027-01-02').ok).toBe(false);
  });

  it('selected_dates > лимита (после дедупа) — отклоняется', () => {
    const many = Array.from({ length: MAX_MATERIALIZED_LEAVE_DAYS + 1 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 0, 1 + i));
      return d.toISOString().slice(0, 10);
    });
    const r = validateLeaveRequestPeriod(many[0], many[many.length - 1], many);
    expect(r.ok).toBe(false);
  });

  it('дата из selected_dates вне периода — отклоняется', () => {
    const r = validateLeaveRequestPeriod('2026-07-01', '2026-07-31', ['2026-07-10', '2026-08-15']);
    expect(r.ok).toBe(false);
  });
});

describe('leaveRequestsController.approve (валидация периода до транзакции)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveAccessibleDepartmentIds).mockResolvedValue([]);
    responsiblesByEmpMock.mockResolvedValue(new Map([[247, [7]]])); // зритель 7 — ответственный
    pgTx.mockImplementation(async (fn: (c: typeof txClient) => Promise<unknown>) => fn(txClient));
    txClient.query.mockResolvedValue({ rows: [{ id: 708, status: 'approved' }], rowCount: 1 });
  });

  const mockVacationRow = (over: Record<string, unknown>) => {
    pgQueryOne
      .mockResolvedValueOnce({
        id: 708, employee_id: 247, status: 'pending', request_type: 'vacation',
        start_date: '2026-07-31', end_date: '2026-07-31', selected_dates: null,
        correction_date: null, correction_status: null, correction_hours: null,
        correction_object_id: null, correction_object_name: null, reason: null,
        ...over,
      })
      .mockResolvedValueOnce({ org_department_id: 'dep-1' }); // canManageLeaveRequest
  };

  it('заявка с годом 0026 (диапазон) → 400, без транзакции и без материализации', async () => {
    mockVacationRow({ start_date: '0026-07-31', end_date: '2026-07-31' });
    const res = makeRes();

    await leaveRequestsController.approve(makeReq(), res);

    expect(res._status).toBe(400);
    expect(pgTx).not.toHaveBeenCalled();
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('одиночная заявка 0026→0026 → 400, без транзакции и без материализации', async () => {
    mockVacationRow({ start_date: '0026-07-31', end_date: '0026-07-31' });
    const res = makeRes();

    await leaveRequestsController.approve(makeReq(), res);

    expect(res._status).toBe(400);
    expect(pgTx).not.toHaveBeenCalled();
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('корректная однодневная заявка (год в пределах) → 200, ровно одна корректировка', async () => {
    mockVacationRow({ start_date: '2026-07-31', end_date: '2026-07-31' });
    const res = makeRes();

    await leaveRequestsController.approve(makeReq(), res);

    expect(res._status).toBe(200);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy.mock.calls[0][0]).toMatchObject({ employee_id: 247, work_date: '2026-07-31', source_id: '708' });
  });
});

describe('leaveRequestsController.create (валидация периода)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pgTx.mockImplementation(async (fn: (c: typeof txClient) => Promise<unknown>) => fn(txClient));
  });

  const createReq = (body: Record<string, unknown>) =>
    makeReq({ body, user: { ...makeReq().user, employee_id: 247 } } as Partial<AuthenticatedRequest>);

  it('год 0026 → 400, без вставки', async () => {
    const res = makeRes();
    await leaveRequestsController.create(createReq({ request_type: 'vacation', start_date: '0026-07-31', end_date: '0026-07-31' }), res);
    expect(res._status).toBe(400);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('start > end → 400, без вставки', async () => {
    const res = makeRes();
    await leaveRequestsController.create(createReq({ request_type: 'vacation', start_date: '2026-08-10', end_date: '2026-08-01' }), res);
    expect(res._status).toBe(400);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('слишком большой период (367 дней) → 400, без вставки', async () => {
    const res = makeRes();
    await leaveRequestsController.create(createReq({ request_type: 'vacation', start_date: '2026-01-01', end_date: '2027-01-02' }), res);
    expect(res._status).toBe(400);
    expect(pgTx).not.toHaveBeenCalled();
  });
});

describe('leaveRequestsController.revokeApproval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pgTx.mockImplementation(async (fn: (c: typeof txClient) => Promise<unknown>) => fn(txClient));
  });

  // Approved-отпуск, согласованный пользователем 'reviewer-uuid' (= makeReq().user.id), будущие даты.
  const approvedVacation = (over: Record<string, unknown> = {}) => ({
    id: 708, employee_id: 247, request_type: 'vacation', status: 'approved',
    reviewer_id: 'reviewer-uuid', start_date: '2026-12-01', end_date: '2026-12-05',
    selected_dates: null, ...over,
  });

  const adminReq = (over: Record<string, unknown> = {}) =>
    makeReq({ user: { id: 'admin-uuid', is_admin: true } as never, ...over });

  it('404 — заявление не найдено', async () => {
    pgQueryOne.mockResolvedValueOnce(null);
    const res = makeRes();
    await leaveRequestsController.revokeApproval(makeReq(), res);
    expect(res._status).toBe(404);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('400 — тип не отпускной', async () => {
    pgQueryOne.mockResolvedValueOnce(approvedVacation({ request_type: 'remote' }));
    const res = makeRes();
    await leaveRequestsController.revokeApproval(makeReq(), res);
    expect(res._status).toBe(400);
  });

  it('400 — статус не approved', async () => {
    pgQueryOne.mockResolvedValueOnce(approvedVacation({ status: 'pending' }));
    const res = makeRes();
    await leaveRequestsController.revokeApproval(makeReq(), res);
    expect(res._status).toBe(400);
  });

  it('403 — не админ и не согласовавший', async () => {
    pgQueryOne.mockResolvedValueOnce(approvedVacation({ reviewer_id: 'someone-else' }));
    const res = makeRes();
    await leaveRequestsController.revokeApproval(makeReq(), res); // user.id='reviewer-uuid', is_admin отсутствует
    expect(res._status).toBe(403);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('400 — руководитель не может отменить начавшийся/прошедший отпуск', async () => {
    pgQueryOne.mockResolvedValueOnce(approvedVacation({ start_date: '2026-01-01', end_date: '2026-01-05' }));
    const res = makeRes();
    await leaveRequestsController.revokeApproval(makeReq(), res);
    expect(res._status).toBe(400);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('409 — период уже сдан/закрыт в табеле', async () => {
    pgQueryOne.mockResolvedValueOnce(approvedVacation({ start_date: '2026-01-01', end_date: '2026-01-03' }));
    pgQuery.mockResolvedValueOnce([{ ok: 1 }]); // гард: период submitted/approved
    const res = makeRes();
    await leaveRequestsController.revokeApproval(adminReq(), res); // админ: проверка дат пропущена
    expect(res._status).toBe(409);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('успех — cancelled, cancelled_by/reason, точечный DELETE, уведомление', async () => {
    pgQueryOne.mockResolvedValueOnce(approvedVacation());
    pgQuery.mockResolvedValueOnce([]); // гард: период не закрыт
    txClient.query
      .mockResolvedValueOnce({ rows: [{ status: 'approved' }] }) // FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 708, status: 'cancelled' }] }) // UPDATE
      .mockResolvedValueOnce({ rowCount: 2 }); // DELETE
    const res = makeRes();

    await leaveRequestsController.revokeApproval(makeReq({ body: { reason: 'тест' } }), res);

    expect(res._status).toBe(200);
    expect((res._json as { data: { status: string } }).data.status).toBe('cancelled');

    const updateCall = txClient.query.mock.calls.find((c: unknown[]) => String(c[0]).includes('UPDATE leave_requests'));
    expect(updateCall).toBeDefined();
    expect(String(updateCall![0])).toContain('cancelled_by');
    // Согласовавший руководитель → cancel_source='manager'.
    expect(updateCall![1]).toEqual(['reviewer-uuid', expect.any(String), 'тест', '708', 'manager']);

    const deleteCall = txClient.query.mock.calls.find((c: unknown[]) => String(c[0]).includes('DELETE FROM attendance_adjustments'));
    expect(deleteCall).toBeDefined();
    expect(deleteCall![1]).toEqual([['708', '708:time_correction']]);

    expect(notificationService.createMany).toHaveBeenCalledTimes(1);
  });

  it('админ может отменить начавшийся отпуск, если период не закрыт', async () => {
    pgQueryOne.mockResolvedValueOnce(approvedVacation({ start_date: '2026-01-01', end_date: '2026-01-03' }));
    pgQuery.mockResolvedValueOnce([]); // гард: период не закрыт
    txClient.query
      .mockResolvedValueOnce({ rows: [{ status: 'approved' }] })
      .mockResolvedValueOnce({ rows: [{ id: 708, status: 'cancelled' }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    const res = makeRes();

    await leaveRequestsController.revokeApproval(adminReq(), res);

    expect(res._status).toBe(200);
    expect(pgTx).toHaveBeenCalledTimes(1);
  });

  it('админ, который сам не согласовывал → cancel_source=admin', async () => {
    pgQueryOne.mockResolvedValueOnce(approvedVacation({ reviewer_id: 'someone-else' }));
    pgQuery.mockResolvedValueOnce([]);
    txClient.query
      .mockResolvedValueOnce({ rows: [{ status: 'approved' }] })
      .mockResolvedValueOnce({ rows: [{ id: 708, status: 'cancelled' }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    const res = makeRes();

    await leaveRequestsController.revokeApproval(adminReq(), res);

    const updateCall = txClient.query.mock.calls.find((c: unknown[]) => String(c[0]).includes('UPDATE leave_requests'));
    expect(updateCall![1]![4]).toBe('admin');
  });

  it('админ, который сам согласовывал → cancel_source=manager', async () => {
    pgQueryOne.mockResolvedValueOnce(approvedVacation({ reviewer_id: 'admin-uuid' }));
    pgQuery.mockResolvedValueOnce([]);
    txClient.query
      .mockResolvedValueOnce({ rows: [{ status: 'approved' }] })
      .mockResolvedValueOnce({ rows: [{ id: 708, status: 'cancelled' }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    const res = makeRes();

    await leaveRequestsController.revokeApproval(adminReq(), res);

    const updateCall = txClient.query.mock.calls.find((c: unknown[]) => String(c[0]).includes('UPDATE leave_requests'));
    expect(updateCall![1]![4]).toBe('manager');
  });

  it('ответ содержит ФИО отменившего (canceller)', async () => {
    pgQueryOne.mockResolvedValueOnce(approvedVacation());
    pgQuery
      .mockResolvedValueOnce([]) // гард периода
      .mockResolvedValueOnce([{ id: 'reviewer-uuid', full_name: 'Тихонович Юрий Витальевич' }]); // профили
    txClient.query
      .mockResolvedValueOnce({ rows: [{ status: 'approved' }] })
      .mockResolvedValueOnce({ rows: [{ id: 708, status: 'cancelled', cancelled_by: 'reviewer-uuid', cancel_source: 'manager' }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    const res = makeRes();

    await leaveRequestsController.revokeApproval(makeReq({ body: { reason: 'тест' } }), res);

    const data = (res._json as { data: { canceller: { full_name: string } | null; reviewer: unknown } }).data;
    expect(data.canceller?.full_name).toBe('Тихонович Юрий Витальевич');
    expect(data.reviewer).toBeNull();
  });
});

describe('leaveRequestsController.cancel (самоотмена сотрудником)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pgTx.mockImplementation(async (fn: (c: typeof txClient) => Promise<unknown>) => fn(txClient));
  });

  // Автор заявления = employee_id 7 (= makeReq().user.employee_id).
  const ownRequest = (over: Record<string, unknown> = {}) => ({
    id: 708, employee_id: 7, status: 'pending', request_type: 'vacation', ...over,
  });

  const okTx = () => {
    txClient.query
      .mockResolvedValueOnce({ rows: [{ status: 'pending', employee_id: 7 }] }) // FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 708, status: 'cancelled' }] }) // UPDATE
      .mockResolvedValueOnce({ rowCount: 0 }); // DELETE
  };

  it('400 — отпуск без причины', async () => {
    pgQueryOne.mockResolvedValueOnce(ownRequest());
    const res = makeRes();
    await leaveRequestsController.cancel(makeReq(), res);
    expect(res._status).toBe(400);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('400 — причина из одних пробелов для отпуска', async () => {
    pgQueryOne.mockResolvedValueOnce(ownRequest());
    const res = makeRes();
    await leaveRequestsController.cancel(makeReq({ body: { reason: '   ' } }), res);
    expect(res._status).toBe(400);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('400 — причина длиннее 500 символов', async () => {
    const res = makeRes();
    await leaveRequestsController.cancel(makeReq({ body: { reason: 'x'.repeat(501) } }), res);
    expect(res._status).toBe(400);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('успех — cancel_reason (trim) + cancel_source=employee', async () => {
    pgQueryOne.mockResolvedValueOnce(ownRequest());
    okTx();
    const res = makeRes();

    await leaveRequestsController.cancel(makeReq({ body: { reason: '  перенос на сентябрь  ' } }), res);

    expect(res._status).toBe(200);
    const updateCall = txClient.query.mock.calls.find((c: unknown[]) => String(c[0]).includes('UPDATE leave_requests'));
    expect(String(updateCall![0])).toContain("cancel_source = 'employee'");
    expect(updateCall![1]).toEqual([expect.any(String), '708', 'reviewer-uuid', 'перенос на сентябрь']);
  });

  it('не-отпуск без причины проходит, cancel_reason = null', async () => {
    pgQueryOne.mockResolvedValueOnce(ownRequest({ request_type: 'remote' }));
    okTx();
    const res = makeRes();

    await leaveRequestsController.cancel(makeReq(), res);

    expect(res._status).toBe(200);
    const updateCall = txClient.query.mock.calls.find((c: unknown[]) => String(c[0]).includes('UPDATE leave_requests'));
    expect(updateCall![1]![3]).toBeNull();
  });

  it('409 — статус успел смениться внутри транзакции (гонка с approve/reject)', async () => {
    pgQueryOne.mockResolvedValueOnce(ownRequest());
    txClient.query.mockResolvedValueOnce({ rows: [{ status: 'rejected', employee_id: 7 }] }); // FOR UPDATE
    const res = makeRes();

    await leaveRequestsController.cancel(makeReq({ body: { reason: 'причина' } }), res);

    expect(res._status).toBe(409);
    const updateCall = txClient.query.mock.calls.find((c: unknown[]) => String(c[0]).includes('UPDATE leave_requests'));
    expect(updateCall).toBeUndefined();
  });

  it('отмена уже одобренного отпуска разрешена (удаляет корректировки)', async () => {
    pgQueryOne.mockResolvedValueOnce(ownRequest({ status: 'approved' }));
    txClient.query
      .mockResolvedValueOnce({ rows: [{ status: 'approved', employee_id: 7 }] })
      .mockResolvedValueOnce({ rows: [{ id: 708, status: 'cancelled' }] })
      .mockResolvedValueOnce({ rowCount: 3 });
    const res = makeRes();

    await leaveRequestsController.cancel(makeReq({ body: { reason: 'заболел' } }), res);

    expect(res._status).toBe(200);
    const deleteCall = txClient.query.mock.calls.find((c: unknown[]) => String(c[0]).includes('DELETE FROM attendance_adjustments'));
    expect(deleteCall![1]).toEqual([['708', '708:time_correction']]);
  });

  it('400 — повторная отмена уже отменённого', async () => {
    pgQueryOne.mockResolvedValueOnce(ownRequest({ status: 'cancelled' }));
    const res = makeRes();
    await leaveRequestsController.cancel(makeReq({ body: { reason: 'причина' } }), res);
    expect(res._status).toBe(400);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('403 — чужое заявление', async () => {
    pgQueryOne.mockResolvedValueOnce(ownRequest({ employee_id: 999 }));
    const res = makeRes();
    await leaveRequestsController.cancel(makeReq({ body: { reason: 'причина' } }), res);
    expect(res._status).toBe(403);
    expect(pgTx).not.toHaveBeenCalled();
  });
});

describe('leaveRequestsController.approve/reject (анти-гонка со самоотменой)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveApprovalMock.mockResolvedValue('auto_approved');
    pgTx.mockImplementation(async (fn: (c: typeof txClient) => Promise<unknown>) => fn(txClient));
  });

  it('approve после отмены → 409, корректировки не создаются', async () => {
    mockRequestRow({ start_date: '2026-05-30', end_date: '2026-05-30' });
    // UPDATE ... WHERE status='pending' не нашёл строку (сотрудник успел отменить).
    txClient.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = makeRes();

    await leaveRequestsController.approve(makeReq(), res);

    expect(res._status).toBe(409);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('reject после отмены → 409', async () => {
    pgQueryOne
      .mockResolvedValueOnce({ id: 708, employee_id: 247, status: 'pending', request_type: 'remote' })
      .mockResolvedValueOnce(null); // UPDATE ... WHERE status='pending' → 0 строк
    const res = makeRes();

    await leaveRequestsController.reject(makeReq({ body: { comment: 'нет' } }), res);

    expect(res._status).toBe(409);
  });
});
