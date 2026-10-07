import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const { pgQuery, pgQueryOne } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
}));
vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
}));

const { accessibleMock, editableMock, scopedMock } = vi.hoisted(() => ({
  accessibleMock: vi.fn(async (): Promise<'all' | string[]> => 'all'),
  editableMock: vi.fn(async (): Promise<'all' | string[]> => 'all'),
  scopedMock: vi.fn(async (_req: unknown, deptId: string | null) => deptId),
}));
vi.mock('../services/data-scope.service.js', () => ({
  resolveAccessibleDepartmentIds: accessibleMock,
  resolveEditableDepartmentIds: editableMock,
  resolveScopedDepartmentId: scopedMock,
  resolveWritableScopedDepartmentId: scopedMock,
  resolveTimesheetEditableDepartmentIds: editableMock,
}));

vi.mock('../services/employee-direct-reports.service.js', () => ({
  listDirectSubordinates: vi.fn(async () => []),
}));

vi.mock('../services/correction-approval-settings.service.js', () => ({
  correctionApprovalSettingsService: {
    getRequiredDepartmentIds: vi.fn(async () => new Set(['D1'])),
    setRequiredDepartmentIds: vi.fn(async (ids: string[]) => ids),
  },
}));

const { routeMock } = vi.hoisted(() => ({
  routeMock: vi.fn(async () => new Map<number, number[]>()),
}));
vi.mock('../services/approval-routing.service.js', () => ({
  resolveResponsibleEmployeeIdsForRows: routeMock,
}));

vi.mock('../services/audit.service.js', () => ({
  AUDIT_ACTIONS: {
    UPDATE_TIMESHEET_ENTRY: 'UPDATE_TIMESHEET_ENTRY',
    CORRECTION_APPROVAL_SETTINGS_CHANGED: 'CORRECTION_APPROVAL_SETTINGS_CHANGED',
  },
  auditService: { logFromRequest: vi.fn(async () => undefined) },
}));
// Транзакция решения: колбэк исполняется на фейковом tx-клиенте. Исключение внутри
// пробрасывается без «коммита» — как ROLLBACK + rethrow у настоящего withTransaction.
const { txClient, commits } = vi.hoisted(() => ({
  txClient: { query: vi.fn() },
  commits: { count: 0 },
}));
vi.mock('./timesheet.controller.js', () => {
  const inTx = async (fn: (client: typeof txClient) => Promise<unknown>): Promise<unknown> => {
    const out = await fn(txClient);
    commits.count += 1;
    return out;
  };
  return {
    reapproveAdjustmentsForRange: vi.fn(async () => 0),
    reapproveEmployeeMonthTail: vi.fn(async () => []),
    reportQuotaTailTransitions: vi.fn(async () => undefined),
    withEmployeeMonthQuotaLock: vi.fn(
      (_employeeId: number, _workDate: string, fn: (client: typeof txClient) => Promise<unknown>) => inTx(fn),
    ),
    withQuotaLocks: vi.fn((_pairs: unknown, fn: (client: typeof txClient) => Promise<unknown>) => inTx(fn)),
  };
});
// Закрытых периодов нет: решение не упирается в гард табеля (тест может задать замок).
const { closedLocksMock } = vi.hoisted(() => ({
  closedLocksMock: vi.fn(async (..._args: unknown[]) => new Map<string, unknown>()),
}));
vi.mock('../services/timesheet-version.service.js', () => ({
  loadClosedTimesheetLocks: closedLocksMock,
}));

// Трекинг перехода «готов к утверждению» проверяется своим тестом — здесь сквозной;
// фиксируем, с какими месяцами он вызван и записала ли мутация что-нибудь.
const { trackingMock, publishEffectsMock, tracked } = vi.hoisted(() => {
  const tracked = { changed: [] as boolean[] };
  return {
    tracked,
    trackingMock: vi.fn(async (
      _exec: unknown,
      _months: unknown,
      mutate: () => Promise<{ value: unknown; changed: boolean }>,
    ) => {
      const out = await mutate();
      tracked.changed.push(out.changed);
      return { value: out.value, effects: { affected: [], notifications: [], pushes: [] } };
    }),
    publishEffectsMock: vi.fn(async () => undefined),
  };
});
vi.mock('../services/timesheet-pending-decisions-tracking.service.js', () => ({
  NO_PENDING_DECISION_EFFECTS: { affected: [], notifications: [], pushes: [] },
  withPendingDecisionTracking: trackingMock,
  publishPendingDecisionEffects: publishEffectsMock,
}));
vi.mock('../services/realtime-broadcast.service.js', () => ({ emitDomainChange: vi.fn() }));
vi.mock('../services/recipients.service.js', () => ({
  getLeaveRequestRecipients: vi.fn(async () => []),
  getUserIdsByEmployeeIds: vi.fn(async () => []),
}));

const { skudObjectsMock } = vi.hoisted(() => ({
  skudObjectsMock: vi.fn(async (): Promise<Map<number, string[]>> => new Map()),
}));
vi.mock('../services/employee-skud-object-access.service.js', () => ({
  listRecentSkudObjectNamesByEmployee: skudObjectsMock,
}));

import { correctionApprovalController } from './correction-approval.controller.js';
import { emitDomainChange } from '../services/realtime-broadcast.service.js';
import { auditService } from '../services/audit.service.js';
import { reapproveEmployeeMonthTail } from './timesheet.controller.js';
import { lockKey } from '../services/timesheet-lock.service.js';

function makeReq(employeeId: number): AuthenticatedRequest {
  return {
    params: {},
    query: { start_date: '2026-06-01', end_date: '2026-06-30' },
    body: {},
    user: {
      id: `user-${employeeId}`,
      email: 'u@example.com',
      position_type: 'admin',
      employee_id: employeeId,
      department_id: null,
      is_approved: true,
      two_factor_enabled: false,
      two_factor_verified: true,
    },
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

function mockPendingQueries(): void {
  pgQuery
    .mockResolvedValueOnce([{
      id: 10,
      employee_id: 1,
      work_date: '2026-06-06',
      status: 'work',
      hours_override: null,
      reason: 'выходной',
      created_by: null,
      created_at: '2026-06-01T00:00:00Z',
    }])
    .mockResolvedValueOnce([{ id: 1, full_name: 'Сотрудник', org_department_id: 'D1' }]);
}

describe('correctionApprovalController.getPendingByDepartment routing visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessibleMock.mockResolvedValue('all');
    editableMock.mockResolvedValue('all');
  });

  it('admin/all не видит routed-строку, если он не назначенный ответственный', async () => {
    mockPendingQueries();
    routeMock.mockResolvedValueOnce(new Map([[10, [100]]]));
    const res = makeRes();

    await correctionApprovalController.getPendingByDepartment(makeReq(999), res);

    expect(res._status).toBe(200);
    expect((res._json as { data: unknown[] }).data).toEqual([]);
  });

  it('назначенный ответственный видит свою routed-строку', async () => {
    mockPendingQueries();
    routeMock.mockResolvedValueOnce(new Map([[10, [100]]]));
    pgQuery.mockResolvedValueOnce([{ id: 'D1', name: 'Цифровая трансформация' }]);
    const res = makeRes();

    await correctionApprovalController.getPendingByDepartment(makeReq(100), res);

    expect(res._status).toBe(200);
    const data = (res._json as { data: Array<{ items: Array<{ id: number }> }> }).data;
    expect(data).toHaveLength(1);
    expect(data[0].items.map(i => i.id)).toEqual([10]);
  });

  it('объекты по СКУД: helper зовётся только по видимым сотрудникам, item получает skud_objects', async () => {
    mockPendingQueries();
    routeMock.mockResolvedValueOnce(new Map([[10, [100]]]));
    pgQuery.mockResolvedValueOnce([{ id: 'D1', name: 'Цифровая трансформация' }]);
    skudObjectsMock.mockResolvedValueOnce(new Map([[1, ['ЖК Северный', 'Офис']]]));
    const res = makeRes();

    await correctionApprovalController.getPendingByDepartment(makeReq(100), res);

    expect(skudObjectsMock).toHaveBeenCalledWith([1]);
    const data = (res._json as { data: Array<{ items: Array<{ skud_objects?: string[] }> }> }).data;
    expect(data[0].items[0].skud_objects).toEqual(['ЖК Северный', 'Офис']);
  });

  it('объекты по СКУД: невидимые строки не попадают в helper, ошибка обогащения не валит очередь', async () => {
    mockPendingQueries();
    routeMock.mockResolvedValueOnce(new Map([[10, [100]]]));
    const res = makeRes();

    // viewer 999 не ответственный → строк нет → helper зовётся с пустым списком
    await correctionApprovalController.getPendingByDepartment(makeReq(999), res);
    expect(skudObjectsMock).toHaveBeenCalledWith([]);

    // сбой обогащения → очередь всё равно 200, skud_objects пустой
    vi.clearAllMocks();
    accessibleMock.mockResolvedValue('all');
    editableMock.mockResolvedValue('all');
    mockPendingQueries();
    routeMock.mockResolvedValueOnce(new Map([[10, [100]]]));
    pgQuery.mockResolvedValueOnce([{ id: 'D1', name: 'Цифровая трансформация' }]);
    skudObjectsMock.mockRejectedValueOnce(new Error('skud down'));
    const res2 = makeRes();

    await correctionApprovalController.getPendingByDepartment(makeReq(100), res2);

    expect(res2._status).toBe(200);
    const data = (res2._json as { data: Array<{ items: Array<{ skud_objects?: string[] }> }> }).data;
    expect(data[0].items[0].skud_objects).toEqual([]);
  });

  it('назначенный ответственный видит routed-строку даже без department-scope', async () => {
    accessibleMock.mockResolvedValueOnce([]);
    mockPendingQueries();
    routeMock.mockResolvedValueOnce(new Map([[10, [100]]]));
    pgQuery.mockResolvedValueOnce([{ id: 'D1', name: 'Цифровая трансформация' }]);
    const res = makeRes();

    await correctionApprovalController.getPendingByDepartment(makeReq(100), res);

    expect(res._status).toBe(200);
    const data = (res._json as { data: Array<{ items: Array<{ id: number }> }> }).data;
    expect(data).toHaveLength(1);
    expect(data[0].items.map(i => i.id)).toEqual([10]);
  });
});

function makeAdminReq(opts: { isAdmin?: boolean; mode?: 'pending' | 'history' } = {}): AuthenticatedRequest {
  return {
    params: {},
    query: {
      start_date: '2026-06-01',
      end_date: '2026-06-30',
      ...(opts.mode ? { mode: opts.mode } : {}),
    },
    body: {},
    user: {
      id: 'admin-user',
      email: 'a@example.com',
      position_type: 'admin',
      employee_id: 500,
      department_id: null,
      is_admin: opts.isAdmin ?? true,
      is_approved: true,
      two_factor_enabled: false,
      two_factor_verified: true,
    },
  } as unknown as AuthenticatedRequest;
}

// adjustments (с history-полями) + employees — общая база для getAllByResponsible.
function mockAllByResponsibleBase(): void {
  pgQuery
    .mockResolvedValueOnce([{
      id: 10,
      employee_id: 1,
      work_date: '2026-06-06',
      status: 'work',
      hours_override: null,
      reason: 'выходной',
      created_by: null,
      created_at: '2026-06-01T00:00:00Z',
      approval_status: 'pending',
      approved_by: null,
      approved_at: null,
      approval_comment: null,
    }])
    .mockResolvedValueOnce([{ id: 1, full_name: 'Сотрудник', org_department_id: 'D1' }]);
}

describe('correctionApprovalController.getAllByResponsible (админ-обзор по ответственным)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessibleMock.mockResolvedValue('all');
    editableMock.mockResolvedValue('all');
    routeMock.mockResolvedValue(new Map<number, number[]>());
  });

  it('не-админ → 403', async () => {
    const res = makeRes();
    await correctionApprovalController.getAllByResponsible(makeAdminReq({ isAdmin: false }), res);
    expect(res._status).toBe(403);
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('админ с пустым scope → 200 []', async () => {
    accessibleMock.mockResolvedValueOnce([]);
    const res = makeRes();
    await correctionApprovalController.getAllByResponsible(makeAdminReq(), res);
    expect(res._status).toBe(200);
    expect((res._json as { data: unknown[] }).data).toEqual([]);
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('группирует routed-строку под её ответственным', async () => {
    mockAllByResponsibleBase();
    routeMock.mockResolvedValueOnce(new Map([[10, [100]]]));
    pgQuery.mockResolvedValueOnce([{ id: 'D1', name: 'Отдел' }]);          // org_departments
    pgQuery.mockResolvedValueOnce([{ id: 100, full_name: 'Руководитель' }]); // имена ответственных
    const res = makeRes();

    await correctionApprovalController.getAllByResponsible(makeAdminReq(), res);

    expect(res._status).toBe(200);
    const data = (res._json as { data: Array<{
      responsible_employee_id: number | null;
      responsible_name: string | null;
      is_unassigned?: boolean;
      departments: Array<{ items: Array<{ id: number }> }>;
    }> }).data;
    expect(data).toHaveLength(1);
    expect(data[0].responsible_employee_id).toBe(100);
    expect(data[0].responsible_name).toBe('Руководитель');
    expect(data[0].is_unassigned).toBeFalsy();
    expect(data[0].departments[0].items.map(i => i.id)).toEqual([10]);
  });

  it('нерутированная строка → секция «Без назначенного ответственного»', async () => {
    mockAllByResponsibleBase();
    routeMock.mockResolvedValueOnce(new Map([[10, []]]));
    pgQuery.mockResolvedValueOnce([{ id: 'D1', name: 'Отдел' }]); // org_departments
    const res = makeRes();

    await correctionApprovalController.getAllByResponsible(makeAdminReq(), res);

    expect(res._status).toBe(200);
    const data = (res._json as { data: Array<{
      responsible_employee_id: number | null;
      is_unassigned?: boolean;
      departments: Array<{ items: Array<{ id: number }> }>;
    }> }).data;
    expect(data).toHaveLength(1);
    expect(data[0].responsible_employee_id).toBeNull();
    expect(data[0].is_unassigned).toBe(true);
    expect(data[0].departments[0].items.map(i => i.id)).toEqual([10]);
  });

  it('company-admin не получает строки вне своего scope', async () => {
    accessibleMock.mockResolvedValueOnce(['D2']); // сотрудник в D1 — вне scope
    mockAllByResponsibleBase();
    const res = makeRes();

    await correctionApprovalController.getAllByResponsible(makeAdminReq(), res);

    expect(res._status).toBe(200);
    expect((res._json as { data: unknown[] }).data).toEqual([]);
  });

  // Регресс на «could not determine data type of parameter $1»: pending-ветка SQL
  // передаёт 3 параметра, поэтому в тексте запроса не должно быть «дыры» в нумерации
  // ($1 обязан использоваться). Мокнутый query ловит только текст — но этого достаточно.
  it('mode=pending: SQL корректировок не имеет пропуска в плейсхолдерах ($1 используется)', async () => {
    mockAllByResponsibleBase();
    pgQuery.mockResolvedValueOnce([{ id: 'D1', name: 'Отдел' }]); // org_departments
    const res = makeRes();

    await correctionApprovalController.getAllByResponsible(makeAdminReq({ mode: 'pending' }), res);

    expect(res._status).toBe(200);
    const [sql, params] = pgQuery.mock.calls[0] as [string, unknown[]];
    // $N, фактически использованные в тексте запроса.
    const used = new Set([...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
    const maxRef = Math.max(...used);
    // Каждый $1..$maxRef должен присутствовать (иначе PG падает на Parse).
    for (let i = 1; i <= maxRef; i++) expect(used.has(i)).toBe(true);
    // И число переданных параметров совпадает с максимальным $N.
    expect(params).toHaveLength(maxRef);
    // pending-статусы биндятся через $1::text[].
    expect(sql).toContain('$1::text[]');
    expect(params[0]).toEqual(['pending']);
  });
});

describe('решение по дню «Работы в выходной»: заявка синхронизируется в транзакции решения', () => {
  // День 77 заявки 900 сотрудника 247 адресован ответственному за выходные 2063.
  const ADJ = { id: 77, employee_id: 247, work_date: '2026-06-06' };
  // Заявка, у которой сменился статус (строка RETURNING синхронизации).
  let syncedRow: { id: number; employee_id: number; status: string } = { id: 900, employee_id: 247, status: 'approved' };
  let failSync = false;
  let syncCommitsSeen: number[] = [];

  const reqAs = (employeeId: number, extra: { params?: Record<string, string>; body?: Record<string, unknown> } = {}) => {
    const req = makeReq(employeeId);
    return { ...req, params: extra.params ?? {}, body: extra.body ?? {} } as unknown as AuthenticatedRequest;
  };
  const txSql = () => txClient.query.mock.calls.map(c => String(c[0]));
  const syncCalls = () => txClient.query.mock.calls.filter(c => String(c[0]).includes('UPDATE leave_requests'));

  beforeEach(() => {
    vi.clearAllMocks();
    pgQuery.mockReset();
    pgQueryOne.mockReset();
    txClient.query.mockReset();
    commits.count = 0;
    failSync = false;
    syncCommitsSeen = [];
    syncedRow = { id: 900, employee_id: 247, status: 'approved' };
    accessibleMock.mockResolvedValue('all');
    editableMock.mockResolvedValue('all');
    routeMock.mockResolvedValue(new Map([[77, [2063]], [78, [2063]]]));
    txClient.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text.includes('UPDATE attendance_adjustments')) {
        const ids = Array.isArray(params?.[4]) ? params[4] as number[]
          : Array.isArray(params?.[0]) ? params[0] as number[]
            : Array.isArray(params?.[2]) ? params[2] as number[]
              : [ADJ.id];
        return { rows: ids.map(id => ({ id })), rowCount: ids.length };
      }
      if (text.includes('UPDATE leave_requests')) {
        syncCommitsSeen.push(commits.count);
        if (failSync) throw new Error('sync failed');
        return { rows: [syncedRow], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
  });

  // filterApprovableIds: отделы сотрудников строк.
  const mockApprovableEmployees = () => {
    pgQuery.mockResolvedValueOnce([{ id: ADJ.employee_id, org_department_id: 'D1' }]);
  };

  it('approveOne: день и заявка меняются одним tx-клиентом, до коммита; realtime — после', async () => {
    pgQueryOne.mockResolvedValueOnce({ ...ADJ, approval_status: 'pending' });
    mockApprovableEmployees();
    const res = makeRes();

    await correctionApprovalController.approveOne(reqAs(2063, { params: { id: '77' } }), res);

    expect(res._status).toBe(200);
    expect((res._json as { data: { approval_status: string } }).data.approval_status).toBe('approved');
    const sql = txSql();
    const adjIdx = sql.findIndex(s => s.includes('UPDATE attendance_adjustments'));
    const syncIdx = sql.findIndex(s => s.includes('UPDATE leave_requests'));
    expect(adjIdx).toBeGreaterThanOrEqual(0);
    expect(syncIdx).toBeGreaterThan(adjIdx);
    expect(syncCalls()[0][1]).toEqual([[77], 'user-2063', null]);
    // Синхронизация — внутри транзакции (до коммита), а не отдельным запросом через пул.
    expect(syncCommitsSeen).toEqual([0]);
    expect(commits.count).toBe(1);
    expect(pgQuery.mock.calls.some(c => String(c[0]).includes('UPDATE leave_requests'))).toBe(false);
    await vi.waitFor(() => expect(vi.mocked(emitDomainChange).mock.calls
      .some(c => c[0].event === 'leave_request:changed')).toBe(true));
    const leaveEmit = vi.mocked(emitDomainChange).mock.calls.find(c => c[0].event === 'leave_request:changed');
    expect(leaveEmit?.[0].payload).toMatchObject({ entityId: 900, employeeId: 247, action: 'approve' });
  });

  it('rejectOne: комментарий отказа уходит в заявку той же транзакцией', async () => {
    syncedRow = { id: 900, employee_id: 247, status: 'rejected' };
    pgQueryOne.mockResolvedValueOnce({ ...ADJ, approval_status: 'pending' });
    mockApprovableEmployees();
    const res = makeRes();

    await correctionApprovalController.rejectOne(
      reqAs(2063, { params: { id: '77' }, body: { comment: 'нет основания' } }), res,
    );

    expect(res._status).toBe(200);
    expect(syncCalls()[0][1]).toEqual([[77], 'user-2063', 'нет основания']);
    expect(syncCommitsSeen).toEqual([0]);
  });

  it('сбой синхронизации откатывает решение: 500, коммита нет, realtime и аудита нет', async () => {
    failSync = true;
    pgQueryOne.mockResolvedValueOnce({ ...ADJ, approval_status: 'pending' });
    mockApprovableEmployees();
    const res = makeRes();

    await correctionApprovalController.approveOne(reqAs(2063, { params: { id: '77' } }), res);

    expect(res._status).toBe(500);
    expect(commits.count).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(emitDomainChange).not.toHaveBeenCalled();
    expect(auditService.logFromRequest).not.toHaveBeenCalled();
  });

  describe('поданный табель ждёт решения, утверждённый — закрыт', () => {
    const lockOf = (employeeId: number, workDate: string, status: 'submitted' | 'approved') => new Map([[
      lockKey(employeeId, workDate),
      { id: 1831, start_date: '2026-06-01', end_date: '2026-06-15', status },
    ]]);

    beforeEach(() => {
      tracked.changed = [];
    });

    it('approveOne в поданном табеле проходит: хвост месяца в режиме decision, через трекинг', async () => {
      closedLocksMock.mockResolvedValueOnce(lockOf(247, '2026-06-06', 'submitted'));
      pgQueryOne.mockResolvedValueOnce({ ...ADJ, approval_status: 'pending' });
      mockApprovableEmployees();
      const res = makeRes();

      await correctionApprovalController.approveOne(reqAs(2063, { params: { id: '77' } }), res);

      expect(res._status).toBe(200);
      expect(txSql().some(s => s.includes('UPDATE attendance_adjustments'))).toBe(true);
      expect(reapproveEmployeeMonthTail).toHaveBeenCalledWith(247, '2026-06-06', txClient, 'decision');
      expect(trackingMock).toHaveBeenCalledWith(
        txClient, [{ employeeId: 247, workDate: '2026-06-06' }], expect.any(Function),
      );
      expect(tracked.changed).toEqual([true]);
      expect(publishEffectsMock).toHaveBeenCalledTimes(1);
    });

    it('rejectOne в поданном табеле тоже проходит', async () => {
      syncedRow = { id: 900, employee_id: 247, status: 'rejected' };
      closedLocksMock.mockResolvedValueOnce(lockOf(247, '2026-06-06', 'submitted'));
      pgQueryOne.mockResolvedValueOnce({ ...ADJ, approval_status: 'pending' });
      mockApprovableEmployees();
      const res = makeRes();

      await correctionApprovalController.rejectOne(reqAs(2063, { params: { id: '77' }, body: { comment: 'нет' } }), res);

      expect(res._status).toBe(200);
      expect((res._json as { data: { approval_status: string } }).data.approval_status).toBe('rejected');
    });

    it('approveOne в утверждённом табеле → 409 TIMESHEET_PERIOD_CLOSED, день не меняется', async () => {
      closedLocksMock.mockResolvedValueOnce(lockOf(247, '2026-06-06', 'approved'));
      pgQueryOne.mockResolvedValueOnce({ ...ADJ, approval_status: 'pending' });
      mockApprovableEmployees();
      const res = makeRes();

      await correctionApprovalController.approveOne(reqAs(2063, { params: { id: '77' } }), res);

      expect(res._status).toBe(409);
      expect((res._json as { code?: string }).code).toBe('TIMESHEET_PERIOD_CLOSED');
      expect(txSql().some(s => s.includes('UPDATE attendance_adjustments'))).toBe(false);
      expect(reapproveEmployeeMonthTail).not.toHaveBeenCalled();
      expect(tracked.changed).toEqual([false]);
    });

    it('повтор решения (день уже решён параллельно) → 409 ALREADY_PROCESSED без пересчёта и эффектов', async () => {
      pgQueryOne.mockResolvedValueOnce({ ...ADJ, approval_status: 'pending' });
      mockApprovableEmployees();
      txClient.query.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
      const res = makeRes();

      await correctionApprovalController.approveOne(reqAs(2063, { params: { id: '77' } }), res);

      expect(res._status).toBe(409);
      expect((res._json as { code?: string }).code).toBe('ALREADY_PROCESSED');
      expect(reapproveEmployeeMonthTail).not.toHaveBeenCalled();
      expect(tracked.changed).toEqual([false]);
      expect(auditService.logFromRequest).not.toHaveBeenCalled();
    });

    it('bulkApproveByIds: день поданного табеля решается, утверждённого — skipped_locked', async () => {
      closedLocksMock.mockResolvedValueOnce(new Map([
        ...lockOf(247, '2026-06-06', 'submitted'),
        ...lockOf(247, '2026-06-20', 'approved'),
      ]));
      pgQuery.mockResolvedValueOnce([
        { ...ADJ, approval_status: 'pending' },
        { id: 78, employee_id: 247, work_date: '2026-06-20', approval_status: 'pending' },
      ]);
      mockApprovableEmployees();
      const res = makeRes();

      await correctionApprovalController.bulkApproveByIds(reqAs(2063, { body: { ids: [77, 78] } }), res);

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({ data: { skipped_locked: 1, locked_ids: [78] } });
      const update = txClient.query.mock.calls.find(c => String(c[0]).includes('UPDATE attendance_adjustments'));
      expect(update?.[1]?.[4]).toEqual([77]);
    });

    it('revertOne в поданном табеле → 409: откат решения только через «Открыть»', async () => {
      closedLocksMock.mockResolvedValueOnce(lockOf(247, '2026-06-06', 'submitted'));
      pgQueryOne.mockResolvedValueOnce({ ...ADJ, approval_status: 'approved' });
      mockApprovableEmployees();
      const res = makeRes();

      await correctionApprovalController.revertOne(reqAs(2063, { params: { id: '77' } }), res);

      expect(res._status).toBe(409);
      expect(txSql().some(s => s.includes('UPDATE attendance_adjustments'))).toBe(false);
    });
  });

  it('bulkApproveByIds: все обработанные дни синхронизируются внутри транзакции', async () => {
    pgQuery
      .mockResolvedValueOnce([
        { ...ADJ, approval_status: 'pending' },
        { id: 78, employee_id: 247, work_date: '2026-06-13', approval_status: 'pending' },
      ]);
    mockApprovableEmployees();
    const res = makeRes();

    await correctionApprovalController.bulkApproveByIds(reqAs(2063, { body: { ids: [77, 78] } }), res);

    expect(res._status).toBe(200);
    expect((res._json as { data: { processed_count: number } }).data.processed_count).toBe(2);
    expect(syncCalls()[0][1]).toEqual([[77, 78], 'user-2063', null]);
    expect(syncCommitsSeen).toEqual([0]);
  });

  it('bulkRevertByIds: откат возвращает заявку в pending той же транзакцией', async () => {
    syncedRow = { id: 900, employee_id: 247, status: 'pending' };
    pgQuery.mockResolvedValueOnce([{ ...ADJ, approval_status: 'approved' }]);
    mockApprovableEmployees();
    const res = makeRes();

    await correctionApprovalController.bulkRevertByIds(reqAs(2063, { body: { ids: [77] } }), res);

    expect(res._status).toBe(200);
    expect(syncCalls()[0][1]).toEqual([[77], 'user-2063', null]);
    expect(syncCommitsSeen).toEqual([0]);
  });

  it('revertOne: одиночный откат тоже синхронизирует заявку (раньше не синхронизировал вовсе)', async () => {
    syncedRow = { id: 900, employee_id: 247, status: 'pending' };
    pgQueryOne.mockResolvedValueOnce({ ...ADJ, approval_status: 'approved' });
    mockApprovableEmployees();
    const res = makeRes();

    await correctionApprovalController.revertOne(reqAs(2063, { params: { id: '77' } }), res);

    expect(res._status).toBe(200);
    expect(syncCalls()[0][1]).toEqual([[77], 'user-2063', null]);
    expect(syncCommitsSeen).toEqual([0]);
    await vi.waitFor(() => expect(vi.mocked(emitDomainChange).mock.calls
      .some(c => c[0].event === 'leave_request:changed' && c[0].payload?.action === 'revert')).toBe(true));
  });

  it('согласование отдела: синхронизация внутри транзакции', async () => {
    pgQuery
      .mockResolvedValueOnce([{ id: ADJ.employee_id }]) // сотрудники отдела
      .mockResolvedValueOnce([ADJ]); // pending-кандидаты периода
    mockApprovableEmployees();
    const res = makeRes();

    await correctionApprovalController.bulkApprove(
      reqAs(2063, { body: { department_id: 'D1', start_date: '2026-06-01', end_date: '2026-06-30' } }), res,
    );

    expect(res._status).toBe(200);
    expect((res._json as { data: { approved_count: number } }).data.approved_count).toBe(1);
    expect(syncCalls()[0][1]).toEqual([[77], 'user-2063', null]);
    expect(syncCommitsSeen).toEqual([0]);
  });

  it('сценарий: день заявки виден только ответственному, его решение закрывает заявку', async () => {
    // Другой админ строку не видит (routed-строка — только ответственному).
    mockPendingQueries();
    routeMock.mockResolvedValueOnce(new Map([[10, [2063]]]));
    const adminRes = makeRes();
    await correctionApprovalController.getPendingByDepartment(makeReq(999), adminRes);
    expect((adminRes._json as { data: unknown[] }).data).toEqual([]);

    // Ответственный её видит…
    mockPendingQueries();
    routeMock.mockResolvedValueOnce(new Map([[10, [2063]]]));
    pgQuery.mockResolvedValueOnce([{ id: 'D1', name: 'Отдел по управлению персоналом' }]);
    const respRes = makeRes();
    await correctionApprovalController.getPendingByDepartment(makeReq(2063), respRes);
    const groups = (respRes._json as { data: Array<{ items: Array<{ id: number }> }> }).data;
    expect(groups[0].items.map(i => i.id)).toEqual([10]);

    // …и его решение переводит заявку в approved с ним как согласующим.
    routeMock.mockResolvedValueOnce(new Map([[10, [2063]]]));
    pgQueryOne.mockResolvedValueOnce({ id: 10, employee_id: 1, work_date: '2026-06-06', approval_status: 'pending' });
    pgQuery.mockResolvedValueOnce([{ id: 1, org_department_id: 'D1' }]);
    syncedRow = { id: 900, employee_id: 1, status: 'approved' };
    const approveRes = makeRes();
    await correctionApprovalController.approveOne(reqAs(2063, { params: { id: '10' } }), approveRes);

    expect(approveRes._status).toBe(200);
    expect(syncCalls()[0][1]).toEqual([[10], 'user-2063', null]);
  });
});
