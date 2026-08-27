import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

const { editableEmployeesMock } = vi.hoisted(() => ({
  editableEmployeesMock: vi.fn(async (): Promise<Set<number> | 'all'> => 'all'),
}));
vi.mock('../services/data-scope.service.js', () => ({
  canAccessEmployeeInScope: vi.fn(async () => true),
  canEditEmployeeInScope: vi.fn(async () => true),
  resolveAccessibleDepartmentIds: vi.fn(async () => []),
  resolveEditableDepartmentIds: vi.fn(async () => []),
  resolveEditableEmployeeIds: editableEmployeesMock,
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
  // Материализация берёт advisory-лок квоты (employee, YYYYMM) на tx-клиенте.
  quotaLockKeys: (employeeId: number, workDate: string) => {
    const [y, m] = workDate.split('-');
    return [employeeId, Number(`${y}${m}`)];
  },
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
const { routedApproversMock } = vi.hoisted(() => ({ routedApproversMock: vi.fn(async (): Promise<string[]> => []) }));
vi.mock('../services/recipients.service.js', () => ({
  getLeaveRequestRecipients: vi.fn(async () => []),
  getEmployeeUserId: vi.fn(async () => 'emp-user-uuid'),
  resolveRoutedLeaveApprovers: routedApproversMock,
}));
// Детерминированное «сегодня» (Europe/Moscow) для проверок будущности отпуска.
vi.mock('../utils/date.utils.js', () => ({ moscowTodayIso: vi.fn(() => '2026-06-29') }));
vi.mock('../services/employee-direct-reports.service.js', () => ({ listDirectSubordinates: vi.fn(async () => []) }));
// leave-request-history.service НЕ мокаем: он пишет через client.query того же
// tx-клиента, что и остальной код, — так тесты видят INSERT в leave_request_history.
import { resolveAccessibleDepartmentIds, resolveManagedDepartmentIds } from '../services/data-scope.service.js';
const { selectableObjectsMock } = vi.hoisted(() => ({
  selectableObjectsMock: vi.fn(async () => [] as Array<{ object_id: string; object_name: string }>),
}));
vi.mock('../services/employee-skud-object-access.service.js', () => ({
  listSelectableObjectsForEmployee: selectableObjectsMock,
}));
vi.mock('../services/timesheet-object.service.js', () => ({ OBJECT_ADJUSTMENT_SOURCE_TYPE: 'manual_object' }));
// hrAcknowledge проверяет право по маркеру семейства заявления (отпуск/увольнение).
const { pageAccessMock } = vi.hoisted(() => ({
  pageAccessMock: vi.fn(async (_req: unknown, _page: string, _action: string) => true),
}));
vi.mock('../services/access-control.service.js', () => ({
  resolveEffectivePageAccess: pageAccessMock,
}));

import {
  leaveRequestsController,
  validateLeaveRequestPeriod,
  formatLeaveDateLabel,
  MAX_MATERIALIZED_LEAVE_DAYS,
} from './leave-requests.controller.js';
import { notificationService } from '../services/notification.service.js';
import { emitDomainChange } from '../services/realtime-broadcast.service.js';
import { pushService } from '../services/push.service.js';

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

// Текущая строка заявки: её отдаёт и предчтение (queryOne), и блокирующее
// чтение внутри транзакции (SELECT ... FOR UPDATE на tx-клиенте).
let currentRequestRow: Record<string, unknown> = {};

function mockRequestRow(over: Record<string, unknown>) {
  currentRequestRow = {
    id: 708, employee_id: 247, status: 'pending', request_type: 'remote',
    start_date: '2026-05-30', end_date: '2026-05-30', selected_dates: null,
    correction_date: null, correction_status: null, correction_hours: null,
    correction_object_id: null, correction_object_name: null, reason: null,
    ...over,
  };
  // queryOne: 1) предчтение заявки, 2) автор (user_profiles). Третий вызов (отдел
  // сотрудника для схлопывания выходных) остаётся неопределённым — как и раньше.
  pgQueryOne
    .mockResolvedValueOnce(currentRequestRow)
    .mockResolvedValueOnce({ id: 'author-uuid' });
}

/**
 * Дефолтное поведение tx-клиента для решения по заявке: блокирующее чтение отдаёт
 * текущую строку, UPDATE — её же в целевом статусе, гард закрытого табеля — пусто.
 */
function setDecisionTxDefaults(status: 'approved' | 'rejected' = 'approved') {
  txClient.query.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes('FOR UPDATE')) return { rows: [currentRequestRow], rowCount: 1 };
    if (text.includes('timesheet_approvals') || text.includes('WITH RECURSIVE pairs')) {
      return { rows: [], rowCount: 0 };
    }
    if (text.includes('UPDATE leave_requests')) {
      return { rows: [{ ...currentRequestRow, status }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

// Очередь mockResolvedValueOnce переживает clearAllMocks: остатки теста, который
// вышел раньше, чем успел их израсходовать, иначе съезжают в следующий describe.
beforeEach(() => {
  pgQueryOne.mockReset();
  pgQuery.mockReset();
  txClient.query.mockReset();
});

describe('leaveRequestsController.approve', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveApprovalMock.mockResolvedValue('auto_approved');
    editableEmployeesMock.mockResolvedValue('all');
    pgQuery.mockResolvedValue([] as never);
    pgTx.mockImplementation(async (fn: (c: typeof txClient) => Promise<unknown>) => fn(txClient));
    // Гард закрытого табеля ходит в timesheet_approvals — на blanket-моке он бы
    // увидел «замок» в каждой строке, поэтому для него отвечаем пусто.
    setDecisionTxDefaults('approved');
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
    mockRequestRow({
      request_type: 'work',
      start_date: '2026-06-06', end_date: '2026-06-06', selected_dates: ['2026-06-06'],
    });
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

  it('409 — материализация в закрытый табель запрещена, корректировка не создаётся', async () => {
    mockRequestRow({
      request_type: 'time_correction',
      start_date: '2026-06-01', end_date: '2026-06-01',
      correction_date: '2026-06-01', correction_status: 'work', correction_hours: 8,
    });
    txClient.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes('FOR UPDATE')) return { rows: [currentRequestRow], rowCount: 1 };
      if (text.includes('WITH RECURSIVE pairs')) {
        return {
          rows: [{
            employee_id: 247, work_date: '2026-06-01', id: 5,
            start_date: '2026-06-01', end_date: '2026-06-15', status: 'approved',
          }],
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const res = makeRes();

    await leaveRequestsController.approve(makeReq(), res);

    expect(res._status).toBe(409);
    expect(upsertSpy).not.toHaveBeenCalled();
    // Ключевое: заявление не должно быть согласовано «в обмен» на 409 — раньше
    // UPDATE шёл до гарда, а withTransaction коммитил возврат конфликта.
    const updateCall = txClient.query.mock.calls.find(c => String(c[0]).includes('UPDATE leave_requests'));
    expect(updateCall).toBeUndefined();
  });

  it('админ НЕ согласовывает день в закрытом табеле — гард касается и его', async () => {
    mockRequestRow({
      request_type: 'time_correction',
      start_date: '2026-06-01', end_date: '2026-06-01',
      correction_date: '2026-06-01', correction_status: 'work', correction_hours: 8,
    });
    txClient.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes('FOR UPDATE')) return { rows: [currentRequestRow], rowCount: 1 };
      if (text.includes('WITH RECURSIVE pairs')) {
        return {
          rows: [{
            employee_id: 247, work_date: '2026-06-01', id: 5,
            start_date: '2026-06-01', end_date: '2026-06-15', status: 'approved',
          }],
        };
      }
      if (text.includes('UPDATE leave_requests')) {
        return { rows: [{ ...currentRequestRow, status: 'approved' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const res = makeRes();
    const req = makeReq();
    (req.user as { is_admin?: boolean }).is_admin = true;

    await leaveRequestsController.approve(req, res);

    // Раньше здесь ожидался 200: у админа была привилегия писать в закрытый период,
    // и материализация заявления молча меняла часы уже сданного табеля. Теперь путь
    // один для всех — «Открыть табель → правки → Закрыть табель».
    expect(res._status).toBe(409);
    expect((res._json as { code?: string }).code).toBe('TIMESHEET_PERIOD_CLOSED');
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('корректировку материализует из блокирующего чтения: часы, изменённые параллельно, не устаревают', async () => {
    // Гонка: предчтение увидело 10ч, следом согласующий сохранил 9ч
    // (PATCH /:id/correction-hours). В табель должны уйти 9ч из SELECT ... FOR UPDATE.
    mockRequestRow({
      request_type: 'time_correction',
      start_date: '2026-06-01', end_date: '2026-06-01',
      correction_date: '2026-06-01', correction_status: 'work', correction_hours: 10,
      correction_object_id: 'obj-1', correction_object_name: 'Объект 1',
    });
    const freshRow = { ...currentRequestRow, correction_hours: '9.00' };
    txClient.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes('FOR UPDATE')) return { rows: [freshRow], rowCount: 1 };
      if (text.includes('UPDATE leave_requests')) {
        return { rows: [{ ...freshRow, status: 'approved' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const res = makeRes();

    await leaveRequestsController.approve(makeReq(), res);

    expect(res._status).toBe(200);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy.mock.calls[0][0]).toMatchObject({
      employee_id: 247,
      work_date: '2026-06-01',
      // work + явные часы > 0 → 'manual' (часы авторитетны, не из СКУД)
      status: 'manual',
      hours_override: '9.00',
      source_type: 'manual_object',
      source_id: 'obj-1',
    });
    // Резолвер approval_status тоже должен видеть свежие часы.
    expect(resolveApprovalMock).toHaveBeenCalledWith(247, '2026-06-01', 'manual', '9.00', false, null, txClient);
  });

  it('одобряющий — ответственный за выходные: 2-й этап схлопывается в approved', async () => {
    resolveApprovalMock.mockResolvedValueOnce('pending');
    responsiblesByEmpMock.mockResolvedValue(new Map([[247, [7]]]));
    weekendResponsibleMock.mockResolvedValueOnce(7); // ответственный = одобряющий (employee_id 7)
    mockRequestRow({
      request_type: 'work',
      start_date: '2026-06-06', end_date: '2026-06-06', selected_dates: ['2026-06-06'],
    });
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

describe('leaveRequestsController.updateCorrectionHours', () => {
  // Реальный req несёт headers/socket — их читает аудит (ip/user-agent).
  const makeHoursReq = (body: unknown) => makeReq({
    body: body as AuthenticatedRequest['body'],
    headers: { 'user-agent': 'vitest' },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Partial<AuthenticatedRequest>);

  const CORRECTION_ROW = {
    id: 708, employee_id: 247, request_type: 'time_correction', status: 'pending',
  };

  // Диспетчер по SQL, а не позиционная очередь: между FOR UPDATE и UPDATE теперь
  // идут advisory-лок и перепроверка замка закрытого периода, и любая новая
  // внутритранзакционная проверка сдвигала бы жёсткую последовательность.
  const mockTxFlow = (locked: unknown, updated: unknown, closedPeriod = false) => {
    txClient.query.mockReset();
    txClient.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes('pg_advisory')) return { rows: [], rowCount: 0 };
      if (text.includes('WITH RECURSIVE pairs')) {
        return closedPeriod
          ? {
            rows: [{
              employee_id: 247, work_date: '2026-06-01', id: 5,
              start_date: '2026-06-01', end_date: '2026-06-15', status: 'approved',
            }],
            rowCount: 1,
          }
          : { rows: [], rowCount: 0 };
      }
      if (text.includes('FOR UPDATE')) {
        return { rows: locked ? [locked] : [], rowCount: locked ? 1 : 0 };
      }
      if (text.includes('UPDATE leave_requests')) {
        return { rows: updated ? [updated] : [], rowCount: updated ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    pgTx.mockImplementation(async (fn: (c: typeof txClient) => Promise<unknown>) => fn(txClient));
    txClient.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it.each([10.3, 25, -1, '9', undefined, null, Number.NaN])('400 на некорректных часах: %s', async (hours) => {
    const res = makeRes();

    await leaveRequestsController.updateCorrectionHours(makeHoursReq({ hours }), res);

    expect(res._status).toBe(400);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('404, если заявления нет', async () => {
    pgQueryOne.mockResolvedValueOnce(null);
    const res = makeRes();

    await leaveRequestsController.updateCorrectionHours(makeHoursReq({ hours: 9 }), res);

    expect(res._status).toBe(404);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('400 на заявлении не типа time_correction', async () => {
    pgQueryOne.mockResolvedValueOnce({ ...CORRECTION_ROW, request_type: 'remote' });
    const res = makeRes();

    await leaveRequestsController.updateCorrectionHours(makeHoursReq({ hours: 9 }), res);

    expect(res._status).toBe(400);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('403, если нет прав на сотрудника', async () => {
    pgQueryOne.mockResolvedValueOnce(CORRECTION_ROW);
    const { canEditEmployeeInScope } = await import('../services/data-scope.service.js');
    vi.mocked(canEditEmployeeInScope).mockResolvedValueOnce(false);
    const res = makeRes();

    await leaveRequestsController.updateCorrectionHours(makeHoursReq({ hours: 9 }), res);

    expect(res._status).toBe(403);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('409, если статус сменился между предчтением и локом (параллельный approve)', async () => {
    pgQueryOne.mockResolvedValueOnce(CORRECTION_ROW);
    mockTxFlow({ status: 'approved', correction_hours: '10.00' }, null);
    const res = makeRes();

    await leaveRequestsController.updateCorrectionHours(makeHoursReq({ hours: 9 }), res);

    expect(res._status).toBe(409);
    expect(txClient.query.mock.calls.some(c => String(c[0]).includes('UPDATE leave_requests'))).toBe(false);
    expect(txClient.query.mock.calls.some(c => String(c[0]).includes('audit_logs'))).toBe(false);
    await Promise.resolve();
    expect(vi.mocked(emitDomainChange)).not.toHaveBeenCalled();
  });

  it('409, если условный UPDATE не задел ни одной строки (гонка с approve)', async () => {
    pgQueryOne.mockResolvedValueOnce(CORRECTION_ROW);
    mockTxFlow({ status: 'pending', correction_hours: '10.00' }, null);
    const res = makeRes();

    await leaveRequestsController.updateCorrectionHours(makeHoursReq({ hours: 9 }), res);

    expect(res._status).toBe(409);
    expect(txClient.query.mock.calls.some(c => String(c[0]).includes('audit_logs'))).toBe(false);
    await Promise.resolve();
    expect(vi.mocked(emitDomainChange)).not.toHaveBeenCalled();
  });

  it('успех: пишет часы, аудит «было → стало» в той же транзакции и шлёт realtime', async () => {
    pgQueryOne.mockResolvedValueOnce(CORRECTION_ROW);
    mockTxFlow(
      { status: 'pending', correction_hours: '10.00' },
      { id: 708, employee_id: 247, correction_hours: '9.00' },
    );
    const res = makeRes();

    await leaveRequestsController.updateCorrectionHours(makeHoursReq({ hours: 9 }), res);

    expect(res._status).toBe(200);
    const updateCall = txClient.query.mock.calls.find(c => String(c[0]).includes('UPDATE leave_requests'));
    expect(updateCall?.[1]).toEqual([9, '708', 'pending']);
    // pending: строки в табеле ещё нет — трогать attendance_adjustments нечего.
    expect(txClient.query.mock.calls.some(c => String(c[0]).includes('UPDATE attendance_adjustments'))).toBe(false);

    const auditCall = txClient.query.mock.calls.find(c => String(c[0]).includes('audit_logs'));
    expect(auditCall).toBeDefined();
    expect(auditCall?.[1]?.[1]).toBe('UPDATE_LEAVE_REQUEST_CORRECTION_HOURS');
    // details пишутся числами: numeric из pg («10.00») нормализуется.
    expect(JSON.parse(String(auditCall?.[1]?.[4]))).toMatchObject({ old_hours: 10, new_hours: 9 });

    const historyCall = txClient.query.mock.calls.find(c => String(c[0]).includes('leave_request_history'));
    expect(historyCall?.[1]?.[1]).toBe('hours_changed');
    expect(JSON.parse(String(historyCall?.[1]?.[3]))).toEqual({ hours: 10 });
    expect(JSON.parse(String(historyCall?.[1]?.[4]))).toEqual({ hours: 9 });

    await vi.waitFor(() => expect(vi.mocked(emitDomainChange)).toHaveBeenCalled());
    expect(vi.mocked(emitDomainChange).mock.calls[0][0]).toMatchObject({
      event: 'leave_request:changed',
      payload: { entityId: 708, employeeId: 247, action: 'update_hours' },
    });
  });

  it('сбой аудита откатывает правку: 500 и никакого realtime', async () => {
    pgQueryOne.mockResolvedValueOnce(CORRECTION_ROW);
    txClient.query.mockReset();
    txClient.query
      .mockResolvedValueOnce({ rows: [{ status: 'pending', correction_hours: '10.00' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 708, correction_hours: '9.00' }], rowCount: 1 })
      .mockRejectedValueOnce(new Error('audit insert failed'));
    const res = makeRes();

    await leaveRequestsController.updateCorrectionHours(makeHoursReq({ hours: 9 }), res);

    expect(res._status).toBe(500);
    await Promise.resolve();
    expect(vi.mocked(emitDomainChange)).not.toHaveBeenCalled();
  });

  // --- Согласованная корректировка: часы уже уехали в табель ---

  const APPROVED_ROW = {
    id: 708, employee_id: 247, request_type: 'time_correction', status: 'approved',
    reviewer_id: 'reviewer-uuid',
    start_date: '2026-06-01', end_date: '2026-06-01',
    selected_dates: null, correction_date: '2026-06-01', correction_status: 'work',
    correction_object_id: 'obj-1',
  };

  it('approved: 403, если правит не согласовавший и не админ', async () => {
    pgQueryOne.mockResolvedValueOnce({ ...APPROVED_ROW, reviewer_id: 'other-uuid' });
    const res = makeRes();

    await leaveRequestsController.updateCorrectionHours(makeHoursReq({ hours: 9 }), res);

    expect(res._status).toBe(403);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('approved: 409, если день попал в сданный табель — БД не трогаем', async () => {
    pgQueryOne.mockResolvedValueOnce(APPROVED_ROW);
    pgQuery.mockResolvedValueOnce([{ ok: 1 }]); // hasLockedTimesheetDates
    const res = makeRes();

    await leaveRequestsController.updateCorrectionHours(makeHoursReq({ hours: 9 }), res);

    expect(res._status).toBe(409);
    expect((res._json as { error: string }).error).toContain('табеле');
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('approved: точечно переписывает объектную строку табеля и пишет историю', async () => {
    pgQueryOne.mockResolvedValueOnce(APPROVED_ROW);
    pgQuery.mockResolvedValueOnce([]); // табель не сдан
    mockTxFlow(
      { status: 'approved', correction_hours: '10.00' },
      { id: 708, employee_id: 247, correction_hours: '9.00' },
    );
    const res = makeRes();

    await leaveRequestsController.updateCorrectionHours(makeHoursReq({ hours: 9 }), res);

    expect(res._status).toBe(200);
    const adjCall = txClient.query.mock.calls.find(c => String(c[0]).includes('UPDATE attendance_adjustments'));
    expect(adjCall).toBeDefined();
    // work + часы > 0 → 'manual', строка ищется по объекту; approval_status не в SET.
    expect(adjCall?.[1]).toEqual([9, 'manual', 247, '2026-06-01', 'manual_object', 'obj-1']);
    expect(String(adjCall?.[0])).not.toContain('approval_status');

    const historyCall = txClient.query.mock.calls.find(c => String(c[0]).includes('leave_request_history'));
    expect(historyCall?.[1]?.[1]).toBe('hours_changed');
  });

  it('approved без объекта (легаси): правит day-level строку заявления', async () => {
    pgQueryOne.mockResolvedValueOnce({ ...APPROVED_ROW, correction_object_id: null });
    pgQuery.mockResolvedValueOnce([]);
    mockTxFlow(
      { status: 'approved', correction_hours: '10.00' },
      { id: 708, employee_id: 247, correction_hours: '9.00' },
    );
    const res = makeRes();

    await leaveRequestsController.updateCorrectionHours(makeHoursReq({ hours: 9 }), res);

    expect(res._status).toBe(200);
    const adjCall = txClient.query.mock.calls.find(c => String(c[0]).includes('UPDATE attendance_adjustments'));
    expect(adjCall?.[1]).toEqual([9, 'manual', '708:time_correction']);
  });

  it('approved: 0 строк в табеле → 409 и откат (день переписан вручную)', async () => {
    pgQueryOne.mockResolvedValueOnce(APPROVED_ROW);
    pgQuery.mockResolvedValueOnce([]);
    // Диспетчер по SQL: позиционная очередь сломалась бы о advisory-лок и
    // перепроверку замка, которые идут между FOR UPDATE и записью.
    txClient.query.mockReset();
    txClient.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes('pg_advisory')) return { rows: [], rowCount: 0 };
      if (text.includes('WITH RECURSIVE pairs')) return { rows: [], rowCount: 0 };
      if (text.includes('FOR UPDATE')) {
        return { rows: [{ status: 'approved', correction_hours: '10.00' }], rowCount: 1 };
      }
      if (text.includes('UPDATE leave_requests')) {
        return { rows: [{ id: 708, correction_hours: '9.00' }], rowCount: 1 };
      }
      // Ключевое для теста: строки табеля нет — день переписан вручную.
      if (text.includes('UPDATE attendance_adjustments')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });
    const res = makeRes();

    await leaveRequestsController.updateCorrectionHours(makeHoursReq({ hours: 9 }), res);

    expect(res._status).toBe(409);
    expect(txClient.query.mock.calls.some(c => String(c[0]).includes('audit_logs'))).toBe(false);
    await Promise.resolve();
    expect(vi.mocked(emitDomainChange)).not.toHaveBeenCalled();
  });

  it('approved: 0 часов на «рабочем дне» оставляет статус work (не manual)', async () => {
    pgQueryOne.mockResolvedValueOnce({ ...APPROVED_ROW, correction_object_id: null });
    pgQuery.mockResolvedValueOnce([]);
    mockTxFlow(
      { status: 'approved', correction_hours: '10.00' },
      { id: 708, employee_id: 247, correction_hours: '0.00' },
    );
    const res = makeRes();

    await leaveRequestsController.updateCorrectionHours(makeHoursReq({ hours: 0 }), res);

    expect(res._status).toBe(200);
    const adjCall = txClient.query.mock.calls.find(c => String(c[0]).includes('UPDATE attendance_adjustments'));
    expect(adjCall?.[1]).toEqual([0, 'work', '708:time_correction']);
  });
});

describe('leaveRequestsController.updateRequestType', () => {
  // Реальный req несёт headers/socket — их читает аудит (ip/user-agent).
  const makeTypeReq = (body: unknown) => makeReq({
    body: body as AuthenticatedRequest['body'],
    headers: { 'user-agent': 'vitest' },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Partial<AuthenticatedRequest>);

  // «Сегодня» в тестах — 2026-06-29 (moscowTodayIso замокан выше).
  const LOCKED_PENDING = {
    id: 708, employee_id: 247, status: 'pending', request_type: 'vacation',
    start_date: '2026-09-14', end_date: '2026-09-15', selected_dates: null,
  };
  const LOCKED_APPROVED = { ...LOCKED_PENDING, status: 'approved' };
  const UPDATED_ROW = {
    id: 708, employee_id: 247, request_type: 'unpaid',
    start_date: '2026-09-14', end_date: '2026-09-15', selected_dates: null,
  };

  /**
   * Роутер SQL внутри транзакции: FOR UPDATE → (проверка закрытого табеля) →
   * UPDATE leave_requests → (UPDATE attendance_adjustments) → INSERT audit_logs.
   * Маршрутизация по тексту запроса, а не по порядку — набор шагов зависит от статуса.
   */
  const mockTx = (opts: {
    locked: unknown;
    updated?: unknown;
    periodLocked?: boolean;
    adjustedRows?: number;
  }) => {
    txClient.query.mockReset();
    txClient.query.mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q.includes('FOR UPDATE')) {
        return { rows: opts.locked ? [opts.locked] : [], rowCount: opts.locked ? 1 : 0 };
      }
      if (q.includes('timesheet_approvals')) {
        return opts.periodLocked ? { rows: [{ ok: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (q.includes('UPDATE leave_requests')) {
        return { rows: opts.updated ? [opts.updated] : [], rowCount: opts.updated ? 1 : 0 };
      }
      if (q.includes('UPDATE attendance_adjustments')) {
        return { rows: [], rowCount: opts.adjustedRows ?? 0 };
      }
      return { rows: [], rowCount: 1 }; // audit_logs
    });
  };

  const calledWith = (fragment: string) =>
    txClient.query.mock.calls.some(c => String(c[0]).includes(fragment));
  const callWith = (fragment: string) =>
    txClient.query.mock.calls.find(c => String(c[0]).includes(fragment));

  beforeEach(() => {
    vi.clearAllMocks();
    pgTx.mockImplementation(async (fn: (c: typeof txClient) => Promise<unknown>) => fn(txClient));
    txClient.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it.each(['sick_leave', '', 5, undefined, null])('400 на недопустимом целевом типе: %s', async (target) => {
    const res = makeRes();

    await leaveRequestsController.updateRequestType(
      makeTypeReq({ request_type: target, expected_request_type: 'vacation' }), res);

    expect(res._status).toBe(400);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it.each(['sick_leave', '', 5, undefined, null])('400 на недопустимом expected_request_type: %s', async (expected) => {
    const res = makeRes();

    await leaveRequestsController.updateRequestType(
      makeTypeReq({ request_type: 'unpaid', expected_request_type: expected }), res);

    expect(res._status).toBe(400);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('400 на no-op: целевой тип равен expected', async () => {
    const res = makeRes();

    await leaveRequestsController.updateRequestType(
      makeTypeReq({ request_type: 'unpaid', expected_request_type: 'unpaid' }), res);

    expect(res._status).toBe(400);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('404, если заявления нет', async () => {
    mockTx({ locked: null });
    const res = makeRes();

    await leaveRequestsController.updateRequestType(
      makeTypeReq({ request_type: 'unpaid', expected_request_type: 'vacation' }), res);

    expect(res._status).toBe(404);
    expect(calledWith('UPDATE leave_requests')).toBe(false);
  });

  it('400, если текущий тип заявления не из трёх типов вкладки', async () => {
    mockTx({ locked: { ...LOCKED_PENDING, request_type: 'sick_leave' } });
    const res = makeRes();

    await leaveRequestsController.updateRequestType(
      makeTypeReq({ request_type: 'unpaid', expected_request_type: 'vacation' }), res);

    expect(res._status).toBe(400);
    expect(calledWith('UPDATE leave_requests')).toBe(false);
  });

  it.each(['rejected', 'cancelled'])('409, если под блокировкой заявление в статусе %s', async (status) => {
    mockTx({ locked: { ...LOCKED_PENDING, status } });
    const res = makeRes();

    await leaveRequestsController.updateRequestType(
      makeTypeReq({ request_type: 'unpaid', expected_request_type: 'vacation' }), res);

    expect(res._status).toBe(409);
    expect(calledWith('UPDATE leave_requests')).toBe(false);
    expect(calledWith('audit_logs')).toBe(false);
    expect(vi.mocked(emitDomainChange)).not.toHaveBeenCalled();
  });

  it('409 stale-UI: первый HR уже сменил vacation → unpaid, второй с устаревшим expected шлёт educational_leave', async () => {
    // Второй PATCH стартует ПОСЛЕ завершения первого: под локом уже unpaid,
    // но редактор второго HR открывался на vacation — ловит именно expected_request_type.
    mockTx({ locked: { ...LOCKED_PENDING, request_type: 'unpaid' } });
    const res = makeRes();

    await leaveRequestsController.updateRequestType(
      makeTypeReq({ request_type: 'educational_leave', expected_request_type: 'vacation' }), res);

    expect(res._status).toBe(409);
    expect((res._json as { error: string }).error).toContain('Категория уже изменена');
    expect(calledWith('UPDATE leave_requests')).toBe(false);
    expect(calledWith('audit_logs')).toBe(false);
    expect(vi.mocked(emitDomainChange)).not.toHaveBeenCalled();
  });

  it('409 stale-UI: оба меняют на unpaid — второй тоже получает конфликт', async () => {
    mockTx({ locked: { ...LOCKED_PENDING, request_type: 'unpaid' } });
    const res = makeRes();

    await leaveRequestsController.updateRequestType(
      makeTypeReq({ request_type: 'unpaid', expected_request_type: 'vacation' }), res);

    expect(res._status).toBe(409);
    expect(calledWith('UPDATE leave_requests')).toBe(false);
  });

  it('409, если условный UPDATE не задел ни одной строки', async () => {
    mockTx({ locked: LOCKED_PENDING, updated: null });
    const res = makeRes();

    await leaveRequestsController.updateRequestType(
      makeTypeReq({ request_type: 'unpaid', expected_request_type: 'vacation' }), res);

    expect(res._status).toBe(409);
    expect(calledWith('audit_logs')).toBe(false);
    expect(vi.mocked(emitDomainChange)).not.toHaveBeenCalled();
  });

  it('pending: успех vacation → unpaid, табель не трогаем, broadcast без employeeId', async () => {
    mockTx({ locked: LOCKED_PENDING, updated: UPDATED_ROW });
    const res = makeRes();

    await leaveRequestsController.updateRequestType(
      makeTypeReq({ request_type: 'unpaid', expected_request_type: 'vacation' }), res);

    expect(res._status).toBe(200);
    const updateCall = callWith('UPDATE leave_requests');
    // Меняется только request_type (+updated_at); даты/selected_dates не передаются.
    expect(String(updateCall![0])).not.toMatch(/start_date|end_date|selected_dates/);
    expect(updateCall![1]).toEqual(['unpaid', '708', 'pending', 'vacation']);
    // pending не материализован — строк табеля нет, трогать нечего.
    expect(calledWith('UPDATE attendance_adjustments')).toBe(false);

    const auditCall = callWith('audit_logs');
    expect(auditCall?.[1]?.[1]).toBe('UPDATE_LEAVE_REQUEST_TYPE');
    expect(JSON.parse(String(auditCall?.[1]?.[4]))).toMatchObject({
      employee_id: 247, old_type: 'vacation', new_type: 'unpaid',
      request_status: 'pending', adjusted_days: 0,
    });

    expect(vi.mocked(emitDomainChange)).toHaveBeenCalledWith({
      event: 'leave_request:changed',
      broadcast: true,
      payload: { entityId: 708, action: 'update_type' }, // ровно эти поля: без employeeId
    });
  });

  it('pending с прошедшими датами по-прежнему правится (гард даты — только у approved)', async () => {
    mockTx({
      locked: { ...LOCKED_PENDING, start_date: '2026-05-01', end_date: '2026-05-05' },
      updated: UPDATED_ROW,
    });
    const res = makeRes();

    await leaveRequestsController.updateRequestType(
      makeTypeReq({ request_type: 'unpaid', expected_request_type: 'vacation' }), res);

    expect(res._status).toBe(200);
    expect(calledWith('UPDATE attendance_adjustments')).toBe(false);
  });

  it('approved (будущий отпуск): unpaid → vacation переписывает дни табеля от имени HR', async () => {
    mockTx({
      locked: { ...LOCKED_APPROVED, request_type: 'unpaid', selected_dates: ['2026-09-14', '2026-09-15'] },
      updated: { ...UPDATED_ROW, request_type: 'vacation', selected_dates: ['2026-09-14', '2026-09-15'] },
      adjustedRows: 2,
    });
    const res = makeRes();

    await leaveRequestsController.updateRequestType(
      makeTypeReq({ request_type: 'vacation', expected_request_type: 'unpaid' }), res);

    expect(res._status).toBe(200);
    expect(callWith('UPDATE leave_requests')![1]).toEqual(['vacation', '708', 'approved', 'unpaid']);

    const adjCall = callWith('UPDATE attendance_adjustments');
    expect(adjCall).toBeDefined();
    // Точечный UPDATE: approval_status/approved_by/created_by остаются нетронутыми.
    expect(String(adjCall![0])).not.toMatch(/approval_status|approved_by|created_by/);
    expect(adjCall![1]).toEqual(['vacation', 'reviewer-uuid', '708']);

    expect(JSON.parse(String(callWith('audit_logs')?.[1]?.[4]))).toMatchObject({
      old_type: 'unpaid', new_type: 'vacation', request_status: 'approved', adjusted_days: 2,
    });
  });

  it('approved: 400, если отпуск начинается сегодня', async () => {
    mockTx({ locked: { ...LOCKED_APPROVED, start_date: '2026-06-29', end_date: '2026-07-05' } });
    const res = makeRes();

    await leaveRequestsController.updateRequestType(
      makeTypeReq({ request_type: 'unpaid', expected_request_type: 'vacation' }), res);

    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toContain('уже начался');
    expect(calledWith('UPDATE leave_requests')).toBe(false);
    expect(calledWith('UPDATE attendance_adjustments')).toBe(false);
  });

  it('гонка approve ↔ смена категории: под локом строка уже approved с прошедшей датой → 400 без правок', async () => {
    // Редактор HR открывался на pending; пока он сохранял, руководитель согласовал
    // заявление и материализовал прошедшие дни. Гард обязан сработать по locked,
    // а не по предчтению — иначе табель закрытого периода переписался бы молча.
    mockTx({ locked: { ...LOCKED_APPROVED, start_date: '2026-05-01', end_date: '2026-05-05' } });
    const res = makeRes();

    await leaveRequestsController.updateRequestType(
      makeTypeReq({ request_type: 'unpaid', expected_request_type: 'vacation' }), res);

    expect(res._status).toBe(400);
    expect(calledWith('UPDATE leave_requests')).toBe(false);
    expect(calledWith('UPDATE attendance_adjustments')).toBe(false);
    expect(calledWith('audit_logs')).toBe(false);
    expect(vi.mocked(emitDomainChange)).not.toHaveBeenCalled();
  });

  it('approved: 409, если дни попали в сданный/закрытый табель', async () => {
    mockTx({ locked: LOCKED_APPROVED, periodLocked: true });
    const res = makeRes();

    await leaveRequestsController.updateRequestType(
      makeTypeReq({ request_type: 'unpaid', expected_request_type: 'vacation' }), res);

    expect(res._status).toBe(409);
    expect((res._json as { error: string }).error).toContain('табеле');
    expect(calledWith('UPDATE leave_requests')).toBe(false);
    expect(calledWith('UPDATE attendance_adjustments')).toBe(false);
  });

  it.each([0, 1])('approved: 409 и откат, если строк табеля %s вместо числа дней заявления', async (adjustedRows) => {
    mockTx({ locked: LOCKED_APPROVED, updated: UPDATED_ROW, adjustedRows }); // 14-15.09 = 2 дня
    const res = makeRes();

    await leaveRequestsController.updateRequestType(
      makeTypeReq({ request_type: 'unpaid', expected_request_type: 'vacation' }), res);

    expect(res._status).toBe(409);
    expect((res._json as { error: string }).error).toContain('не совпадают');
    expect(calledWith('audit_logs')).toBe(false);
    expect(vi.mocked(emitDomainChange)).not.toHaveBeenCalled();
  });

  it('approved: сбой аудита после правки табеля откатывает всё — 500 и никакого realtime', async () => {
    mockTx({ locked: LOCKED_APPROVED, updated: UPDATED_ROW, adjustedRows: 2 });
    const original = txClient.query.getMockImplementation()!;
    txClient.query.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes('audit_logs')) throw new Error('audit insert failed');
      return original(sql);
    });
    const res = makeRes();

    await leaveRequestsController.updateRequestType(
      makeTypeReq({ request_type: 'unpaid', expected_request_type: 'vacation' }), res);

    expect(res._status).toBe(500);
    expect(calledWith('UPDATE attendance_adjustments')).toBe(true);
    expect(vi.mocked(emitDomainChange)).not.toHaveBeenCalled();
  });
});

describe('leaveRequestsController.approve (материализация после смены категории)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveApprovalMock.mockResolvedValue('auto_approved');
    responsiblesByEmpMock.mockResolvedValue(new Map([[247, [7]]])); // зритель 7 — ответственный
    pgTx.mockImplementation(async (fn: (c: typeof txClient) => Promise<unknown>) => fn(txClient));
  });

  // Предчтение и RETURNING несут ОДИНАКОВЫЙ (уже новый) тип: смена категории
  // состоялась ДО approve. Из-за AND request_type=$5 устаревшее предчтение дало
  // бы 409, а не материализацию.
  const mockChangedRequest = (row: Record<string, unknown>) => {
    const full = {
      id: 708, employee_id: 247, status: 'pending',
      correction_date: null, correction_status: null, correction_hours: null,
      correction_object_id: null, correction_object_name: null, reason: null,
      ...row,
    };
    currentRequestRow = full;
    pgQuery.mockResolvedValue([] as never); // отделы routed-сотрудников (buildDecisionContext)
    pgQueryOne
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce({ id: 'author-uuid' }); // автор корректировок
    txClient.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes('FOR UPDATE')) return { rows: [full], rowCount: 1 };
      if (text.includes('UPDATE leave_requests')) {
        return { rows: [{ ...full, status: 'approved' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
  };

  it('после vacation → unpaid (диапазон 1–3 июня, selected_dates=null): три дня со статусом unpaid', async () => {
    mockChangedRequest({
      request_type: 'unpaid',
      start_date: '2026-06-01', end_date: '2026-06-03', selected_dates: null,
    });
    const res = makeRes();

    await leaveRequestsController.approve(makeReq(), res);

    expect(res._status).toBe(200);
    expect(upsertSpy).toHaveBeenCalledTimes(3);
    const calls = upsertSpy.mock.calls.map(c => c[0] as { work_date: string; status: string });
    expect(calls.map(c => c.work_date).sort()).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
    expect(calls.every(c => c.status === 'unpaid')).toBe(true);
  });

  it('после unpaid → vacation (selected_dates=[1,3 июня]): только два выбранных дня со статусом vacation', async () => {
    mockChangedRequest({
      request_type: 'vacation',
      start_date: '2026-06-01', end_date: '2026-06-03',
      selected_dates: ['2026-06-01', '2026-06-03'],
    });
    const res = makeRes();

    await leaveRequestsController.approve(makeReq(), res);

    expect(res._status).toBe(200);
    expect(upsertSpy).toHaveBeenCalledTimes(2);
    const calls = upsertSpy.mock.calls.map(c => c[0] as { work_date: string; status: string });
    expect(calls.map(c => c.work_date).sort()).toEqual(['2026-06-01', '2026-06-03']);
    expect(calls.every(c => c.status === 'vacation')).toBe(true);
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

describe('leaveRequestsController.create (корректировка — один раз на день)', () => {
  const CORRECTION_DAY = '2026-08-07';
  const INSERTED_ROW = {
    id: 901,
    employee_id: 247,
    request_type: 'time_correction',
    status: 'pending',
    start_date: CORRECTION_DAY,
    end_date: CORRECTION_DAY,
    correction_date: CORRECTION_DAY,
    correction_status: 'work',
    correction_hours: 8,
    correction_object_id: 'obj-1',
    correction_object_name: 'Объект 1',
  };

  // txClient отвечает по содержимому SQL: порядок вызовов проверяем отдельно,
  // а не через цепочку mockResolvedValueOnce (она ломается, когда до INSERT не дошли).
  const setupTx = (blockingStatus: string | null) => {
    txClient.query.mockReset();
    txClient.query.mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (text.includes('SELECT status FROM leave_requests')) {
        return blockingStatus
          ? { rows: [{ status: blockingStatus }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (text.includes('INSERT INTO leave_requests')) return { rows: [INSERTED_ROW], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
  };

  const makeCorrectionReq = (bodyOver: Record<string, unknown> = {}) => makeReq({
    body: {
      request_type: 'time_correction',
      start_date: CORRECTION_DAY,
      end_date: CORRECTION_DAY,
      correction_date: CORRECTION_DAY,
      correction_status: 'work',
      correction_hours: 8,
      correction_object_id: 'obj-1',
      ...bodyOver,
    },
    user: { ...makeReq().user, employee_id: 247 },
  } as Partial<AuthenticatedRequest>);

  const insertCalls = () =>
    txClient.query.mock.calls.filter(c => String(c[0]).includes('INSERT INTO leave_requests'));

  beforeEach(() => {
    vi.clearAllMocks();
    resolveApprovalMock.mockResolvedValue('auto_approved');
    pgTx.mockImplementation(async (fn: (c: typeof txClient) => Promise<unknown>) => fn(txClient));
    // mockReset, а не mockResolvedValueOnce в каждом тесте: в кейсах с невалидной датой
    // сервис не вызывается, и неизрасходованная одноразовая реализация утекла бы дальше.
    selectableObjectsMock.mockReset();
    selectableObjectsMock.mockResolvedValue([{ object_id: 'obj-1', object_name: 'Объект 1' }]);
    setupTx(null);
  });

  it.each(['pending', 'approved', 'rejected'])(
    '409 CORRECTION_ALREADY_REQUESTED, если на этот день уже есть заявление в статусе %s',
    async (status) => {
      setupTx(status);
      const res = makeRes();

      await leaveRequestsController.create(makeCorrectionReq(), res);

      expect(res._status).toBe(409);
      expect((res._json as { code: string }).code).toBe('CORRECTION_ALREADY_REQUESTED');
      expect((res._json as { error: string }).error).toContain('07.08.2026');
      expect(insertCalls()).toHaveLength(0);
    },
  );

  it('отменённое заявление день освобождает — новая корректировка создаётся', async () => {
    setupTx(null); // cancelled не попадает в выборку блокирующих статусов
    const res = makeRes();

    await leaveRequestsController.create(makeCorrectionReq(), res);

    expect(res._status).toBe(200);
    expect((res._json as { success: boolean }).success).toBe(true);
    expect(insertCalls()).toHaveLength(1);
    // В выборке блокирующих статусов cancelled отсутствует.
    const dupCall = txClient.query.mock.calls.find(c => String(c[0]).includes('SELECT status FROM leave_requests'));
    expect((dupCall?.[1] as unknown[])[2]).toEqual(['pending', 'approved', 'rejected']);
  });

  it('гард применяется только к time_correction: work на тот же день проходит', async () => {
    const res = makeRes();

    await leaveRequestsController.create(makeReq({
      body: {
        request_type: 'work',
        start_date: CORRECTION_DAY,
        end_date: CORRECTION_DAY,
        selected_dates: [CORRECTION_DAY],
        reason: 'работа в выходной',
      },
      user: { ...makeReq().user, employee_id: 247 },
    } as Partial<AuthenticatedRequest>), res);

    expect(res._status).toBe(200);
    expect(txClient.query.mock.calls.some(c => String(c[0]).includes('pg_advisory_xact_lock'))).toBe(false);
  });

  it('порядок в транзакции: advisory-лок → выборка дубля → INSERT', async () => {
    const res = makeRes();

    await leaveRequestsController.create(makeCorrectionReq(), res);

    const sqls = txClient.query.mock.calls.map(c => String(c[0]));
    const lockIdx = sqls.findIndex(t => t.includes('pg_advisory_xact_lock'));
    const dupIdx = sqls.findIndex(t => t.includes('SELECT status FROM leave_requests'));
    const insIdx = sqls.findIndex(t => t.includes('INSERT INTO leave_requests'));
    expect(lockIdx).toBe(0);
    expect(lockIdx).toBeLessThan(dupIdx);
    expect(dupIdx).toBeLessThan(insIdx);
  });

  it('ключ лока и выборка дубля построены на employee_id и дате YYYY-MM-DD', async () => {
    const res = makeRes();

    await leaveRequestsController.create(makeCorrectionReq(), res);

    const lockCall = txClient.query.mock.calls.find(c => String(c[0]).includes('pg_advisory_xact_lock'));
    expect((lockCall?.[1] as string[])[0]).toBe(`leave_request:time_correction:247:${CORRECTION_DAY}`);
    const dupCall = txClient.query.mock.calls.find(c => String(c[0]).includes('SELECT status FROM leave_requests'));
    expect((dupCall?.[1] as unknown[]).slice(0, 2)).toEqual([247, CORRECTION_DAY]);
  });

  it('400 на correction_date в виде timestamp — контракт строго YYYY-MM-DD', async () => {
    const res = makeRes();

    await leaveRequestsController.create(makeCorrectionReq({
      correction_date: '2026-08-07T00:00:00.000Z',
    }), res);

    expect(res._status).toBe(400);
    expect(pgTx).not.toHaveBeenCalled();
    expect(selectableObjectsMock).not.toHaveBeenCalled();
  });

  it('400, если correction_date не совпадает с периодом заявления', async () => {
    const res = makeRes();

    await leaveRequestsController.create(makeCorrectionReq({ correction_date: '2026-08-08' }), res);

    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toContain('на один день');
    expect(pgTx).not.toHaveBeenCalled();
    expect(selectableObjectsMock).not.toHaveBeenCalled();
  });

  it('400 (не 500) на нестроковой correction_date', async () => {
    const res = makeRes();

    await leaveRequestsController.create(makeCorrectionReq({ correction_date: 20260807 }), res);

    expect(res._status).toBe(400);
    expect(pgTx).not.toHaveBeenCalled();
    expect(selectableObjectsMock).not.toHaveBeenCalled();
  });
});

describe('leaveRequestsController.create (заявление на увольнение)', () => {
  const dismissalRow = {
    id: 950, employee_id: 247, request_type: 'dismissal', status: 'pending',
    start_date: '2026-07-15', end_date: '2026-07-15', selected_dates: null, reason: null,
  };

  const makeCreateReq = (body: Record<string, unknown>) => makeReq({
    body,
    user: { ...makeReq().user, id: 'author-user-uuid', employee_id: 247 },
  } as Partial<AuthenticatedRequest>);

  beforeEach(() => {
    vi.clearAllMocks();
    pgQueryOne.mockReset();
    pgTx.mockImplementation(async (fn: (c: typeof txClient) => Promise<unknown>) => fn(txClient));
    txClient.query.mockResolvedValue({ rows: [dismissalRow], rowCount: 1 });
    // org_department_id сотрудника для маршрутизации получателей
    pgQueryOne.mockResolvedValue({ org_department_id: 'dep-1' });
    routedApproversMock.mockResolvedValue(['manager-user-uuid']);
    vi.mocked(pushService.sendLeaveRequestNotification).mockResolvedValue(['manager-user-uuid']);
  });

  // clearAllMocks не чистит очередь mockResolvedValueOnce — недобранные значения
  // утекли бы в следующий describe и подменили бы там строку заявления.
  afterEach(() => {
    pgQueryOne.mockReset();
    pgQuery.mockReset();
    txClient.query.mockReset();
  });

  it('создаётся на одну дату', async () => {
    const res = makeRes();

    await leaveRequestsController.create(makeCreateReq({
      request_type: 'dismissal', start_date: '2026-07-15', end_date: '2026-07-15',
    }), res);

    expect(res._status).toBe(200);
    expect((res._json as { data: { request_type: string } }).data.request_type).toBe('dismissal');
    // Табель не трогаем ни при создании, ни при согласовании.
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('отклоняет период из нескольких дней', async () => {
    const res = makeRes();

    await leaveRequestsController.create(makeCreateReq({
      request_type: 'dismissal', start_date: '2026-07-15', end_date: '2026-07-20',
    }), res);

    expect(res._status).toBe(400);
    expect(txClient.query).not.toHaveBeenCalled();
  });

  it('отклоняет selected_dates — непустой массив и значение неверного типа', async () => {
    for (const selected of [['2026-07-15'], '2026-07-15', 42, { from: '2026-07-15' }]) {
      const res = makeRes();
      await leaveRequestsController.create(makeCreateReq({
        request_type: 'dismissal', start_date: '2026-07-15', end_date: '2026-07-15',
        selected_dates: selected,
      }), res);
      expect(res._status).toBe(400);
    }
    expect(txClient.query).not.toHaveBeenCalled();
  });

  it('пустой selected_dates и null допустимы — это «дат нет»', async () => {
    for (const selected of [[], null, undefined]) {
      const res = makeRes();
      await leaveRequestsController.create(makeCreateReq({
        request_type: 'dismissal', start_date: '2026-07-15', end_date: '2026-07-15',
        selected_dates: selected,
      }), res);
      expect(res._status).toBe(200);
    }
  });

  it('уведомление уходит ответственному по маршруту, автору — нет', async () => {
    // Ответственный по маршруту + сам автор (не должен получить уведомление о себе).
    routedApproversMock.mockResolvedValue(['manager-user-uuid', 'author-user-uuid']);
    const res = makeRes();

    await leaveRequestsController.create(makeCreateReq({
      request_type: 'dismissal', start_date: '2026-07-15', end_date: '2026-07-15',
    }), res);

    await vi.waitFor(() => expect(pushService.sendLeaveRequestNotification).toHaveBeenCalled());
    const pushArgs = vi.mocked(pushService.sendLeaveRequestNotification).mock.calls[0];
    expect(pushArgs[4]).toEqual(['manager-user-uuid']);
    expect(routedApproversMock).toHaveBeenCalledWith(247, 'dep-1');

    await vi.waitFor(() => expect(notificationService.createMany).toHaveBeenCalled());
    const created = vi.mocked(notificationService.createMany).mock.calls[0][0] as Array<{ userId: string }>;
    expect(created.map(n => n.userId)).toEqual(['manager-user-uuid']);

    // Realtime получает и автора — ему нужно обновить свой список заявлений.
    await vi.waitFor(() => expect(emitDomainChange).toHaveBeenCalled());
    const emit = vi.mocked(emitDomainChange).mock.calls[0][0] as { targetUserIds: string[] };
    expect(emit.targetUserIds).toContain('author-user-uuid');
    expect(emit.targetUserIds).toContain('manager-user-uuid');
  });

  it('без ответственного уведомления не рассылаются (никакого supervisor-fallback)', async () => {
    routedApproversMock.mockResolvedValue([]);
    vi.mocked(pushService.sendLeaveRequestNotification).mockResolvedValue([]);
    const res = makeRes();

    await leaveRequestsController.create(makeCreateReq({
      request_type: 'dismissal', start_date: '2026-07-15', end_date: '2026-07-15',
    }), res);

    await vi.waitFor(() => expect(pushService.sendLeaveRequestNotification).toHaveBeenCalled());
    // Пустой массив, а не undefined: push не должен откатываться к supervisor_id.
    expect(vi.mocked(pushService.sendLeaveRequestNotification).mock.calls[0][4]).toEqual([]);
    await vi.waitFor(() => expect(notificationService.createMany).toHaveBeenCalledWith([]));
  });
});

describe('leaveRequestsController.approve (заявление на увольнение)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pgQueryOne.mockReset();
    pgTx.mockImplementation(async (fn: (c: typeof txClient) => Promise<unknown>) => fn(txClient));
    // Гард закрытого табеля ходит в timesheet_approvals — на blanket-моке он бы
    // увидел «замок» в каждой строке, поэтому для него отвечаем пусто.
    vi.mocked(resolveAccessibleDepartmentIds).mockResolvedValue([]);
    pgQuery.mockResolvedValue([] as never);
  });

  afterEach(() => {
    pgQueryOne.mockReset();
    pgQuery.mockReset();
    txClient.query.mockReset();
  });

  const DISMISSAL_ROW = {
    id: 708, employee_id: 247, status: 'pending', request_type: 'dismissal',
    start_date: '2026-07-15', end_date: '2026-07-15', selected_dates: null,
    correction_date: null, correction_status: null, correction_hours: null,
    correction_object_id: null, correction_object_name: null, reason: null,
  };

  const mockDismissalRow = () => {
    currentRequestRow = DISMISSAL_ROW;
    pgQueryOne
      .mockResolvedValueOnce(DISMISSAL_ROW) // предчтение заявления
      .mockResolvedValueOnce({ id: 'author-uuid' }); // автор (user_profiles)
    setDecisionTxDefaults('approved');
  };

  it('ответственный согласовывает, табель и карточка сотрудника не меняются', async () => {
    responsiblesByEmpMock.mockResolvedValue(new Map([[247, [7]]])); // viewer employee_id = 7
    mockDismissalRow();
    const res = makeRes();

    await leaveRequestsController.approve(makeReq(), res);

    expect(res._status).toBe(200);
    expect(upsertSpy).not.toHaveBeenCalled();
    // Проверяем именно ЗАПИСЬ: read-only гард закрытого табеля читает employees и
    // employee_assignments, но ничего не меняет.
    const sql = txClient.query.mock.calls.map(c => String(c[0]));
    const mutates = (table: string) => sql.some(s => /(UPDATE|INSERT INTO|DELETE FROM)/i.test(s) && s.includes(table));
    expect(mutates('employees')).toBe(false);
    expect(mutates('attendance_adjustments')).toBe(false);
  });

  it('посторонний руководитель получает 403', async () => {
    responsiblesByEmpMock.mockResolvedValue(new Map([[247, [999]]]));
    mockDismissalRow();
    const res = makeRes();

    await leaveRequestsController.approve(makeReq(), res);

    expect(res._status).toBe(403);
    expect(txClient.query).not.toHaveBeenCalled();
  });
});

describe('formatLeaveDateLabel', () => {
  it('однодневное заявление показывается одной датой', () => {
    expect(formatLeaveDateLabel({
      request_type: 'dismissal', start_date: '2026-07-15', end_date: '2026-07-15',
      correction_date: null, selected_dates: null,
    })).toBe('15.07.2026');
  });

  it('период остаётся диапазоном', () => {
    expect(formatLeaveDateLabel({
      request_type: 'vacation', start_date: '2026-07-01', end_date: '2026-07-15',
      correction_date: null, selected_dates: null,
    })).toBe('01.07.2026 — 15.07.2026');
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

  const mockDismissalDeptQueries = () => {
    pgQuery
      .mockResolvedValueOnce([{ id: 102, full_name: 'Увольняется У.', org_department_id: 'dep-1' }])
      .mockResolvedValueOnce([{ id: 5, employee_id: 102, request_type: 'dismissal', status: 'pending', reviewer_id: null }])
      .mockResolvedValueOnce([{ id: 102, full_name: 'Увольняется У.', org_department_id: 'dep-1', department_name: 'ЦТ', position_name: null }])
      .mockResolvedValue([]);
  };

  it('ответственный видит заявление на увольнение', async () => {
    responsiblesByEmpMock.mockResolvedValue(new Map([[102, [7]]]));
    mockDismissalDeptQueries();
    const res = makeRes();

    await leaveRequestsController.getDepartment(makeReq(), res);

    expect(res._status).toBe(200);
    expect((res._json as { data: Array<{ id: number }> }).data.map(r => r.id)).toEqual([5]);
  });

  it('посторонний руководитель не видит заявление на увольнение', async () => {
    responsiblesByEmpMock.mockResolvedValue(new Map([[102, [999]]]));
    mockDismissalDeptQueries();
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
    // Гард закрытого табеля ходит в timesheet_approvals — на blanket-моке он бы
    // увидел «замок» в каждой строке, поэтому для него отвечаем пусто.
    txClient.query.mockImplementation(async (sql: string) => (
      String(sql).includes('timesheet_approvals')
        ? { rows: [], rowCount: 0 }
        : { rows: [{ id: 708, status: 'approved' }], rowCount: 1 }
    ));
  });

  it('не-ответственный получает 403 на одобрение routed-заявки (vacation)', async () => {
    // Единственный queryOne до отказа — предчтение заявки; отделы routed-сотрудников
    // резолвятся пакетно через query.
    pgQueryOne
      .mockResolvedValueOnce({
        id: 708, employee_id: 247, status: 'pending', request_type: 'vacation',
        start_date: '2026-06-01', end_date: '2026-06-01', selected_dates: null,
        correction_date: null, correction_status: null, correction_hours: null,
        correction_object_id: null, correction_object_name: null, reason: null,
      });
    pgQuery.mockResolvedValue([] as never);
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
      });
    pgQuery.mockResolvedValue([] as never);
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
    // Гард закрытого табеля ходит в timesheet_approvals — на blanket-моке он бы
    // увидел «замок» в каждой строке, поэтому для него отвечаем пусто.
    txClient.query.mockImplementation(async (sql: string) => (
      String(sql).includes('timesheet_approvals')
        ? { rows: [], rowCount: 0 }
        : { rows: [{ id: 708, status: 'approved' }], rowCount: 1 }
    ));
  });

  const mockVacationRow = (over: Record<string, unknown>) => {
    const full = {
      id: 708, employee_id: 247, status: 'pending', request_type: 'vacation',
      start_date: '2026-07-31', end_date: '2026-07-31', selected_dates: null,
      correction_date: null, correction_status: null, correction_hours: null,
      correction_object_id: null, correction_object_name: null, reason: null,
      ...over,
    };
    currentRequestRow = full;
    pgQuery.mockResolvedValue([] as never);
    pgQueryOne
      .mockResolvedValueOnce(full) // предчтение
      .mockResolvedValueOnce({ id: 'author-uuid' }); // автор корректировок
    setDecisionTxDefaults('approved');
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

  /**
   * Диспетчер по SQL вместо позиционной очереди: внутри транзакции появились
   * advisory-лок и перепроверка замка закрытого периода (pre-check через пул сам по
   * себе не защищает — между ним и удалением строк табель успевает закрыться).
   */
  const mockRevokeTx = (updated: Record<string, unknown> = { id: 708, status: 'cancelled' }) => {
    txClient.query.mockReset();
    txClient.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes('pg_advisory')) return { rows: [], rowCount: 0 };
      if (text.includes('WITH RECURSIVE pairs')) return { rows: [], rowCount: 0 };
      if (text.includes('FOR UPDATE')) return { rows: [{ status: 'approved' }], rowCount: 1 };
      if (text.includes('UPDATE leave_requests')) return { rows: [updated], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
  };

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
    mockRevokeTx();
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

    const historyCall = txClient.query.mock.calls.find((c: unknown[]) => String(c[0]).includes('leave_request_history'));
    expect(historyCall![1]).toEqual([708, 'revoked', 'reviewer-uuid', null, null, 'тест']);

    expect(notificationService.createMany).toHaveBeenCalledTimes(1);
  });

  it('корректировка табеля: отменяется без правила «только будущее», объектная строка тоже удаляется', async () => {
    // Дата в прошлом — для time_correction это норма: сдерживает только гард табеля.
    pgQueryOne.mockResolvedValueOnce(approvedVacation({
      request_type: 'time_correction',
      start_date: '2026-06-01', end_date: '2026-06-01',
      correction_date: '2026-06-01', correction_object_id: 'obj-1',
    }));
    pgQuery.mockResolvedValueOnce([]); // табель не сдан
    mockRevokeTx();
    const res = makeRes();

    await leaveRequestsController.revokeApproval(makeReq({ body: { reason: 'ошибочно согласовал' } }), res);

    expect(res._status).toBe(200);
    const deletes = txClient.query.mock.calls.filter((c: unknown[]) => String(c[0]).includes('DELETE FROM attendance_adjustments'));
    expect(deletes).toHaveLength(2);
    // Объектная корректировка лежит под source_id объекта — по id заявления её не найти.
    expect(deletes[1][1]).toEqual([247, '2026-06-01', 'manual_object', 'obj-1']);
  });

  it('корректировка табеля в сданном периоде → 409, БД не трогаем', async () => {
    pgQueryOne.mockResolvedValueOnce(approvedVacation({
      request_type: 'time_correction',
      start_date: '2026-06-01', end_date: '2026-06-01', correction_date: '2026-06-01',
    }));
    pgQuery.mockResolvedValueOnce([{ ok: 1 }]);
    const res = makeRes();

    await leaveRequestsController.revokeApproval(makeReq(), res);

    expect(res._status).toBe(409);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('админ может отменить начавшийся отпуск, если период не закрыт', async () => {
    pgQueryOne.mockResolvedValueOnce(approvedVacation({ start_date: '2026-01-01', end_date: '2026-01-03' }));
    pgQuery.mockResolvedValueOnce([]); // гард: период не закрыт
    mockRevokeTx();
    const res = makeRes();

    await leaveRequestsController.revokeApproval(adminReq(), res);

    expect(res._status).toBe(200);
    expect(pgTx).toHaveBeenCalledTimes(1);
  });

  it('админ, который сам не согласовывал → cancel_source=admin', async () => {
    pgQueryOne.mockResolvedValueOnce(approvedVacation({ reviewer_id: 'someone-else' }));
    pgQuery.mockResolvedValueOnce([]);
    mockRevokeTx();
    const res = makeRes();

    await leaveRequestsController.revokeApproval(adminReq(), res);

    const updateCall = txClient.query.mock.calls.find((c: unknown[]) => String(c[0]).includes('UPDATE leave_requests'));
    expect(updateCall![1]![4]).toBe('admin');
  });

  it('админ, который сам согласовывал → cancel_source=manager', async () => {
    pgQueryOne.mockResolvedValueOnce(approvedVacation({ reviewer_id: 'admin-uuid' }));
    pgQuery.mockResolvedValueOnce([]);
    mockRevokeTx();
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
    mockRevokeTx({ id: 708, status: 'cancelled', cancelled_by: 'reviewer-uuid', cancel_source: 'manager' });
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
      // Дальше: SELECT удаляемых строк (гард закрытого табеля), сам DELETE, история.
      .mockResolvedValue({ rows: [], rowCount: 0 });
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

  it('pending-корректировка с объектом: чужую ручную строку табеля не удаляем', async () => {
    // Материализации ещё не было — совпадающая (сотрудник, дата, объект) строка
    // принадлежит ручной правке табеля руководителя, её трогать нельзя.
    pgQueryOne.mockResolvedValueOnce(ownRequest({
      request_type: 'time_correction', correction_date: '2026-06-01', correction_object_id: 'obj-1',
    }));
    okTx();
    const res = makeRes();

    await leaveRequestsController.cancel(makeReq(), res);

    expect(res._status).toBe(200);
    const deletes = txClient.query.mock.calls.filter((c: unknown[]) => String(c[0]).includes('DELETE FROM attendance_adjustments'));
    expect(deletes).toHaveLength(1);
    expect(deletes[0][1]).toEqual([['708', '708:time_correction']]);
  });

  it('approved-корректировка с объектом: объектная строка тоже удаляется', async () => {
    pgQueryOne.mockResolvedValueOnce(ownRequest({
      status: 'approved', request_type: 'time_correction',
      correction_date: '2026-06-01', correction_object_id: 'obj-1',
    }));
    txClient.query
      .mockResolvedValueOnce({ rows: [{ status: 'approved', employee_id: 7 }] })
      .mockResolvedValueOnce({ rows: [{ id: 708, status: 'cancelled' }] })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    const res = makeRes();

    await leaveRequestsController.cancel(makeReq(), res);

    expect(res._status).toBe(200);
    const deletes = txClient.query.mock.calls.filter((c: unknown[]) => String(c[0]).includes('DELETE FROM attendance_adjustments'));
    expect(deletes).toHaveLength(2);
    expect(deletes[1][1]).toEqual([7, '2026-06-01', 'manual_object', 'obj-1']);
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
      // SELECT удаляемых строк (гард закрытого табеля), затем DELETE и история.
      .mockResolvedValue({ rows: [], rowCount: 3 });
    const res = makeRes();

    await leaveRequestsController.cancel(makeReq({ body: { reason: 'заболел' } }), res);

    expect(res._status).toBe(200);
    const deleteCall = txClient.query.mock.calls.find((c: unknown[]) => String(c[0]).includes('DELETE FROM attendance_adjustments'));
    expect(deleteCall![1]).toEqual([['708', '708:time_correction']]);
  });

  it('409 — отмена трогает строки закрытого табеля', async () => {
    pgQueryOne.mockResolvedValueOnce(ownRequest({ status: 'approved' }));
    txClient.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes('FOR UPDATE')) return { rows: [{ status: 'approved', employee_id: 7 }] };
      if (text.includes('UPDATE leave_requests')) return { rows: [{ id: 708, status: 'cancelled' }] };
      // Удаляемая строка табеля есть...
      if (text.includes('SELECT work_date::text')) return { rows: [{ work_date: '2026-06-01' }] };
      // ...и она в закрытом периоде.
      if (text.includes('WITH RECURSIVE pairs')) {
        return {
          rows: [{
            employee_id: 7, work_date: '2026-06-01', id: 5,
            start_date: '2026-06-01', end_date: '2026-06-15', status: 'approved',
          }],
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const res = makeRes();

    await leaveRequestsController.cancel(makeReq({ body: { reason: 'заболел' } }), res);

    expect(res._status).toBe(409);
    const deletes = txClient.query.mock.calls.filter((c: unknown[]) => String(c[0]).includes('DELETE FROM attendance_adjustments'));
    expect(deletes).toHaveLength(0);
  });

  it('200 — период закрыт, но удалять в нём нечего', async () => {
    pgQueryOne.mockResolvedValueOnce(ownRequest({ status: 'approved' }));
    txClient.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes('FOR UPDATE')) return { rows: [{ status: 'approved', employee_id: 7 }] };
      if (text.includes('UPDATE leave_requests')) return { rows: [{ id: 708, status: 'cancelled' }] };
      return { rows: [], rowCount: 0 }; // строк табеля от заявления нет
    });
    const res = makeRes();

    await leaveRequestsController.cancel(makeReq({ body: { reason: 'заболел' } }), res);

    expect(res._status).toBe(200);
    // Гард замка вообще не запускался: затрагиваемых строк нет.
    const lockChecks = txClient.query.mock.calls.filter((c: unknown[]) => String(c[0]).includes('WITH RECURSIVE pairs'));
    expect(lockChecks).toHaveLength(0);
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

  it('approve после отмены → 409, ничего не пишется', async () => {
    mockRequestRow({ start_date: '2026-05-30', end_date: '2026-05-30' });
    // Сотрудник успел отменить: блокирующее чтение видит cancelled.
    txClient.query.mockImplementation(async (sql: string) => (
      String(sql).includes('FOR UPDATE')
        ? { rows: [{ ...currentRequestRow, status: 'cancelled' }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    ));
    const res = makeRes();

    await leaveRequestsController.approve(makeReq(), res);

    expect(res._status).toBe(409);
    expect(upsertSpy).not.toHaveBeenCalled();
    // Раньше UPDATE шёл до всех проверок; теперь до записи дело не доходит.
    expect(txClient.query.mock.calls.some(c => String(c[0]).includes('UPDATE leave_requests'))).toBe(false);
  });

  it('reject после отмены → 409', async () => {
    pgQueryOne.mockResolvedValueOnce({ id: 708, employee_id: 247, status: 'pending', request_type: 'remote' });
    txClient.query.mockImplementation(async (sql: string) => (
      String(sql).includes('FOR UPDATE')
        ? { rows: [{ id: 708, status: 'cancelled', request_type: 'remote' }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    ));
    const res = makeRes();

    await leaveRequestsController.reject(makeReq({ body: { comment: 'нет' } }), res);

    expect(res._status).toBe(409);
    // История не пишется, если отклонение не состоялось.
    expect(txClient.query.mock.calls.some(c => String(c[0]).includes('leave_request_history'))).toBe(false);
  });

  it('approve при параллельной смене категории → 409: тип сверяется по заблокированной строке', async () => {
    // Право проверено по vacation из предчтения; HR успел сменить категорию —
    // блокирующее чтение отдаёт unpaid, решение не проходит и UPDATE не выполняется.
    responsiblesByEmpMock.mockResolvedValue(new Map([[247, [7]]]));
    pgQuery.mockResolvedValue([] as never);
    pgQueryOne
      .mockResolvedValueOnce({
        id: 708, employee_id: 247, status: 'pending', request_type: 'vacation',
        start_date: '2026-06-01', end_date: '2026-06-03', selected_dates: null,
        correction_date: null, correction_status: null, correction_hours: null,
        correction_object_id: null, correction_object_name: null, reason: null,
      })
      .mockResolvedValueOnce({ id: 'author-uuid' });
    txClient.query.mockImplementation(async (sql: string) => (
      String(sql).includes('FOR UPDATE')
        ? {
          rows: [{
            id: 708, employee_id: 247, status: 'pending', request_type: 'unpaid',
            start_date: '2026-06-01', end_date: '2026-06-03', selected_dates: null,
            correction_date: null, correction_status: null, correction_hours: null,
            correction_object_id: null, correction_object_name: null, reason: null,
          }],
          rowCount: 1,
        }
        : { rows: [], rowCount: 0 }
    ));
    const res = makeRes();

    await leaveRequestsController.approve(makeReq(), res);

    expect(res._status).toBe(409);
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(txClient.query.mock.calls.some(c => String(c[0]).includes('UPDATE leave_requests'))).toBe(false);
  });

  it('reject при параллельной смене категории → 409: тип сверяется по заблокированной строке', async () => {
    responsiblesByEmpMock.mockResolvedValue(new Map([[247, [7]]]));
    pgQuery.mockResolvedValue([] as never);
    pgQueryOne
      .mockResolvedValueOnce({ id: 708, employee_id: 247, status: 'pending', request_type: 'vacation' });
    txClient.query.mockImplementation(async (sql: string) => (
      String(sql).includes('FOR UPDATE')
        ? { rows: [{ id: 708, status: 'pending', request_type: 'unpaid' }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    ));
    const res = makeRes();

    await leaveRequestsController.reject(makeReq({ body: { comment: 'нет' } }), res);

    expect(res._status).toBe(409);
    expect(txClient.query.mock.calls.some(c => String(c[0]).includes('UPDATE leave_requests'))).toBe(false);
  });
});

describe('leaveRequestsController.bulkApprove / bulkReject', () => {
  // Заявки пакета: ключ — id. remote (не routed) → право по edit-скоупу.
  const makeRow = (id: number, over: Record<string, unknown> = {}) => ({
    id, employee_id: 240 + id, status: 'pending', request_type: 'remote',
    start_date: '2026-06-01', end_date: '2026-06-01', selected_dates: null,
    correction_date: null, correction_status: null, correction_hours: null,
    correction_object_id: null, correction_object_name: null, reason: null,
    ...over,
  });

  let rowsById: Map<number, Record<string, unknown>>;
  let lockedTimesheetEmployeeIds: Set<number>;

  const wireMocks = () => {
    // Пакетная выборка preflight + отделы routed-сотрудников.
    pgQuery.mockImplementation((async (sql: string, params: unknown[]) => {
      const text = String(sql);
      if (text.includes('FROM leave_requests')) {
        const ids = (params?.[0] as number[]) ?? [];
        return ids.map(id => rowsById.get(Number(id))).filter(Boolean);
      }
      if (text.includes('FROM employees')) {
        const ids = (params?.[0] as number[]) ?? [];
        return ids.map(id => ({ id, org_department_id: 'dep-1' }));
      }
      return [];
    }) as never);

    // Предчтение заявки внутри ядра + автор + отдел для схлопывания выходных.
    pgQueryOne.mockImplementation((async (sql: string, params: unknown[]) => {
      const text = String(sql);
      if (text.includes('FROM leave_requests')) return rowsById.get(Number(params?.[0])) ?? null;
      if (text.includes('user_profiles')) return { id: 'author-uuid' };
      if (text.includes('FROM employees')) return { org_department_id: 'dep-1' };
      return null;
    }) as never);

    txClient.query.mockImplementation(async (sql: string, params: unknown[]) => {
      const text = String(sql);
      if (text.includes('FOR UPDATE')) {
        const row = rowsById.get(Number(params?.[0]));
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      // Гард закрытого табеля: «замок» только для перечисленных сотрудников
      // (запрос идёт парами employee_id[] / work_date[] в $1/$2).
      if (text.includes('WITH RECURSIVE pairs')) {
        const askedEmployeeIds = (params?.[0] as number[]) ?? [];
        const locked = askedEmployeeIds
          .filter(employeeId => lockedTimesheetEmployeeIds.has(Number(employeeId)))
          .map(employeeId => ({
            employee_id: employeeId, work_date: '2026-06-01', id: 5,
            start_date: '2026-06-01', end_date: '2026-06-15', status: 'approved',
          }));
        return { rows: locked, rowCount: locked.length };
      }
      if (text.includes('UPDATE leave_requests')) {
        const row = rowsById.get(Number(params?.[3]));
        return row ? { rows: [{ ...row, status: 'approved' }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    rowsById = new Map([1, 2, 3].map(id => [id, makeRow(id)] as const));
    lockedTimesheetEmployeeIds = new Set<number>();
    resolveApprovalMock.mockResolvedValue('auto_approved');
    editableEmployeesMock.mockResolvedValue('all');
    responsiblesByEmpMock.mockResolvedValue(new Map());
    weekendResponsibleMock.mockResolvedValue(null);
    pgTx.mockImplementation(async (fn: (c: typeof txClient) => Promise<unknown>) => fn(txClient));
    wireMocks();
  });

  const bulkReq = (body: Record<string, unknown>) => makeReq({ body: body as AuthenticatedRequest['body'] });

  const summaryOf = (res: { _json: unknown }) => (res._json as {
    data: {
      processed_count: number; processed_ids: number[];
      skipped_not_pending: number; skipped_no_access: number;
      skipped_locked: number; locked_ids: number[];
      skipped_failed: number; failed_ids: number[];
    };
  }).data;

  // Инвариант контракта: каждая входная заявка попала ровно в одну категорию.
  const expectCoversInput = (s: ReturnType<typeof summaryOf>, uniqueInputCount: number) => {
    expect(
      s.processed_count + s.skipped_not_pending + s.skipped_no_access + s.skipped_locked + s.skipped_failed,
    ).toBe(uniqueInputCount);
  };

  it('все заявки доступны → processed_ids совпадают со входом', async () => {
    const res = makeRes();

    await leaveRequestsController.bulkApprove(bulkReq({ ids: [1, 2, 3] }), res);

    const summary = summaryOf(res);
    expect(res._status).toBe(200);
    expect(summary.processed_count).toBe(3);
    expect(summary.processed_ids.sort()).toEqual([1, 2, 3]);
    expectCoversInput(summary, 3);
    // Материализация прошла по каждой заявке, счётчик pending разослан один раз.
    expect(upsertSpy).toHaveBeenCalledTimes(3);
  });

  it('смесь: обработанная + чужая + доступная → в processed_ids только доступная', async () => {
    rowsById.set(1, makeRow(1, { status: 'approved' })); // уже обработана
    rowsById.set(2, makeRow(2)); // чужая: сотрудник вне edit-скоупа
    editableEmployeesMock.mockResolvedValue(new Set([243])); // доступен только сотрудник заявки 3
    const res = makeRes();

    await leaveRequestsController.bulkApprove(bulkReq({ ids: [1, 2, 3] }), res);

    const summary = summaryOf(res);
    expect(summary.processed_ids).toEqual([3]);
    expect(summary.skipped_not_pending).toBe(1);
    expect(summary.skipped_no_access).toBe(1);
    expectCoversInput(summary, 3);
  });

  it('повторы в ids схлопываются: [1, 1, 2] — это две заявки', async () => {
    const res = makeRes();

    await leaveRequestsController.bulkApprove(bulkReq({ ids: [1, 1, 2] }), res);

    const summary = summaryOf(res);
    expect(summary.processed_ids.sort()).toEqual([1, 2]);
    expectCoversInput(summary, 2);
  });

  it('закрытый табель по одному сотруднику → skipped_locked, остальные согласованы', async () => {
    lockedTimesheetEmployeeIds.add(242); // сотрудник заявки 2
    const res = makeRes();

    await leaveRequestsController.bulkApprove(bulkReq({ ids: [1, 2, 3] }), res);

    const summary = summaryOf(res);
    expect(summary.processed_ids.sort()).toEqual([1, 3]);
    expect(summary.skipped_locked).toBe(1);
    expect(summary.locked_ids).toEqual([2]);
    expectCoversInput(summary, 3);
  });

  it('смена категории между предчтением и локом → skipped_failed, пакет не прерывается', async () => {
    // Заявка 2 в блокирующем чтении приходит уже с другим типом.
    txClient.query.mockImplementation(async (sql: string, params: unknown[]) => {
      const text = String(sql);
      if (text.includes('FOR UPDATE')) {
        const id = Number(params?.[0]);
        const row = rowsById.get(id);
        if (!row) return { rows: [], rowCount: 0 };
        return { rows: [id === 2 ? { ...row, request_type: 'unpaid' } : row], rowCount: 1 };
      }
      if (text.includes('UPDATE leave_requests')) {
        const row = rowsById.get(Number(params?.[3]));
        return row ? { rows: [{ ...row, status: 'approved' }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });
    const res = makeRes();

    await leaveRequestsController.bulkApprove(bulkReq({ ids: [1, 2, 3] }), res);

    const summary = summaryOf(res);
    expect(summary.processed_ids.sort()).toEqual([1, 3]);
    expect(summary.skipped_failed).toBe(1);
    expect(summary.failed_ids).toEqual([2]);
    expectCoversInput(summary, 3);
  });

  it('исключение на одной заявке не прерывает остальные', async () => {
    upsertSpy.mockRejectedValueOnce(new Error('insert failed')); // упадёт первая заявка
    const res = makeRes();

    await leaveRequestsController.bulkApprove(bulkReq({ ids: [1, 2, 3] }), res);

    const summary = summaryOf(res);
    expect(summary.processed_count).toBe(2);
    expect(summary.skipped_failed).toBe(1);
    expect(summary.failed_ids).toEqual([1]);
    expectCoversInput(summary, 3);
  });

  it('ошибка realtime после коммита не уменьшает processed_count', async () => {
    vi.mocked(emitDomainChange).mockImplementation(() => { throw new Error('socket down'); });
    const res = makeRes();

    await leaveRequestsController.bulkApprove(bulkReq({ ids: [1, 2] }), res);

    expect(summaryOf(res).processed_count).toBe(2);
    vi.mocked(emitDomainChange).mockReset();
  });

  it('пустой ids и превышение лимита пакета → 400', async () => {
    const empty = makeRes();
    await leaveRequestsController.bulkApprove(bulkReq({ ids: [] }), empty);
    expect(empty._status).toBe(400);

    const tooMany = makeRes();
    await leaveRequestsController.bulkApprove(
      bulkReq({ ids: Array.from({ length: 101 }, (_, i) => i + 1) }),
      tooMany,
    );
    expect(tooMany._status).toBe(400);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('бюджет дней табеля превышен → 400 до единой транзакции', async () => {
    // Четыре отпуска по 366 дней — 1464 дня при лимите 1000.
    rowsById = new Map([1, 2, 3, 4].map(id => [id, makeRow(id, {
      request_type: 'vacation', start_date: '2026-01-01', end_date: '2026-12-31',
    })] as const));
    responsiblesByEmpMock.mockResolvedValue(new Map([1, 2, 3, 4].map(id => [240 + id, [7]] as const)));
    const res = makeRes();

    await leaveRequestsController.bulkApprove(bulkReq({ ids: [1, 2, 3, 4] }), res);

    expect(res._status).toBe(400);
    expect(pgTx).not.toHaveBeenCalled();
  });

  it('routed-тип: решает только назначенный ответственный', async () => {
    rowsById = new Map([1, 2].map(id => [id, makeRow(id, { request_type: 'vacation' })] as const));
    // Зритель (employee_id 7) ответственный только за сотрудника заявки 1.
    responsiblesByEmpMock.mockResolvedValue(new Map([[241, [7]], [242, [999]]]));
    const res = makeRes();

    await leaveRequestsController.bulkApprove(bulkReq({ ids: [1, 2] }), res);

    const summary = summaryOf(res);
    expect(summary.processed_ids).toEqual([1]);
    expect(summary.skipped_no_access).toBe(1);
    expectCoversInput(summary, 2);
  });

  it('без прав на запись (кадровая служба: read-скоуп ≠ право решать) → всё пропущено', async () => {
    editableEmployeesMock.mockResolvedValue(new Set<number>());
    const res = makeRes();

    await leaveRequestsController.bulkApprove(bulkReq({ ids: [1, 2, 3] }), res);

    const summary = summaryOf(res);
    expect(summary.processed_count).toBe(0);
    expect(summary.skipped_no_access).toBe(3);
    expect(pgTx).not.toHaveBeenCalled();
    expectCoversInput(summary, 3);
  });

  it('bulkReject: отклоняет доступные, табель не трогает, общий комментарий сохраняется', async () => {
    rowsById.set(2, makeRow(2, { status: 'cancelled' }));
    const res = makeRes();

    await leaveRequestsController.bulkReject(bulkReq({ ids: [1, 2, 3], comment: '  не согласовано  ' }), res);

    const summary = summaryOf(res);
    expect(summary.processed_ids.sort()).toEqual([1, 3]);
    expect(summary.skipped_not_pending).toBe(1);
    expectCoversInput(summary, 3);
    expect(upsertSpy).not.toHaveBeenCalled();
    const updateCall = txClient.query.mock.calls.find(c => String(c[0]).includes("status = 'rejected'"));
    expect(updateCall![1][2]).toBe('не согласовано'); // trim общего комментария
  });

  it('bulkReject: бюджет дней не применяется (записей в табель нет)', async () => {
    rowsById = new Map([1, 2, 3, 4].map(id => [id, makeRow(id, {
      request_type: 'vacation', start_date: '2026-01-01', end_date: '2026-12-31',
    })] as const));
    responsiblesByEmpMock.mockResolvedValue(new Map([1, 2, 3, 4].map(id => [240 + id, [7]] as const)));
    const res = makeRes();

    await leaveRequestsController.bulkReject(bulkReq({ ids: [1, 2, 3, 4] }), res);

    expect(res._status).toBe(200);
    expect(summaryOf(res).processed_count).toBe(4);
  });
});

describe('leaveRequestsController.getVacations / getDismissals (вкладки отдела кадров)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pgQuery.mockReset();
    pgQuery.mockResolvedValue([] as never);
  });

  it('getVacations: только типы отпусков, рабочие исключены', async () => {
    const res = makeRes();
    await leaveRequestsController.getVacations(makeReq(), res);

    expect(res._status).toBe(200);
    const [sql, params] = pgQuery.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toEqual(['vacation', 'unpaid', 'educational_leave']);
    expect(sql).toContain("sr.code = 'worker'");
  });

  it('getDismissals: только dismissal, рабочие включены, статус — опциональный фильтр', async () => {
    const res = makeRes();
    await leaveRequestsController.getDismissals(makeReq({ query: { status: 'pending' } } as never), res);

    expect(res._status).toBe(200);
    const [sql, params] = pgQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([['dismissal'], 'pending']);
    expect(sql).not.toContain("sr.code = 'worker'");
    expect(sql).toContain('lr.status = $2');
  });
});

describe('leaveRequestsController.hrAcknowledge (право по типу заявления)', () => {
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  beforeEach(() => {
    vi.clearAllMocks();
    pgQueryOne.mockReset();
    pageAccessMock.mockReset();
    routedApproversMock.mockReset();
    routedApproversMock.mockResolvedValue([]);
  });

  const mockRow = (request_type: string) => {
    const row = { id: 708, employee_id: 247, request_type };
    pgQueryOne
      .mockResolvedValueOnce(row) // чтение заявления
      .mockResolvedValueOnce({ ...row, hr_acknowledged_at: '2026-06-29T00:00:00Z' }) // UPDATE ... RETURNING
      .mockResolvedValueOnce({ org_department_id: 'dep-1' }); // отдел (маршрут увольнения)
  };

  it('увольнение при праве /leave-dismissals → 200, проверяется именно этот маркер', async () => {
    pageAccessMock.mockImplementation(async (_r, page) => page === '/leave-dismissals');
    mockRow('dismissal');
    const res = makeRes();

    await leaveRequestsController.hrAcknowledge(makeReq(), res);

    expect(res._status).toBe(200);
    expect(pageAccessMock).toHaveBeenCalledWith(expect.anything(), '/leave-dismissals', 'edit');
    expect(pgQueryOne.mock.calls.some(c => String(c[0]).includes('UPDATE leave_requests'))).toBe(true);
  });

  it('увольнение при праве только /leave-vacations → 403 без записи', async () => {
    pageAccessMock.mockImplementation(async (_r, page) => page === '/leave-vacations');
    mockRow('dismissal');
    const res = makeRes();

    await leaveRequestsController.hrAcknowledge(makeReq(), res);

    expect(res._status).toBe(403);
    expect(pgQueryOne.mock.calls.some(c => String(c[0]).includes('UPDATE leave_requests'))).toBe(false);
  });

  it('отпуск при праве только /leave-dismissals → 403', async () => {
    pageAccessMock.mockImplementation(async (_r, page) => page === '/leave-dismissals');
    mockRow('vacation');
    const res = makeRes();

    await leaveRequestsController.hrAcknowledge(makeReq(), res);

    expect(res._status).toBe(403);
    expect(pageAccessMock).toHaveBeenCalledWith(expect.anything(), '/leave-vacations', 'edit');
  });

  it('больничный → 400 (отметка только для отпусков и увольнений)', async () => {
    pageAccessMock.mockResolvedValue(true);
    mockRow('sick_leave');
    const res = makeRes();

    await leaveRequestsController.hrAcknowledge(makeReq(), res);

    expect(res._status).toBe(400);
    expect(pageAccessMock).not.toHaveBeenCalled();
  });

  it('увольнение: realtime уходит согласующему из маршрута, а не supervisor_id', async () => {
    pageAccessMock.mockResolvedValue(true);
    routedApproversMock.mockResolvedValue(['routed-approver-uuid']);
    mockRow('dismissal');
    const res = makeRes();

    await leaveRequestsController.hrAcknowledge(makeReq(), res);
    await flush();

    expect(res._status).toBe(200);
    const emit = vi.mocked(emitDomainChange).mock.calls.find(c => c[0].payload?.action === 'hr_acknowledge');
    expect(emit).toBeDefined();
    expect(emit![0].targetUserIds).toEqual(
      expect.arrayContaining(['routed-approver-uuid', 'emp-user-uuid', 'reviewer-uuid']),
    );
  });
});
