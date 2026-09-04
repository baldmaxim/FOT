import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  queryOne: vi.fn(),
  query: vi.fn(),
  execute: vi.fn(),
  txQuery: vi.fn(),
  canAccessEmployeeInScope: vi.fn(),
  resolveScope: vi.fn(),
  logFromRequest: vi.fn(),
  isConfigured: vi.fn(),
  changeDepartment: vi.fn(),
  invalidate: vi.fn(),
  openDismiss: vi.fn(),
  openRehire: vi.fn(),
  executeOp: vi.fn(),
  DismissalSigurError: class DismissalSigurError extends Error {
    status: number;
    code: string;
    movedToArchive: boolean;
    blocked: boolean;
    constructor(message: string, status: number, code: string, movedToArchive: boolean, blocked: boolean) {
      super(message);
      this.status = status;
      this.code = code;
      this.movedToArchive = movedToArchive;
      this.blocked = blocked;
    }
  },
}));

vi.mock('../config/postgres.js', () => ({
  queryOne: h.queryOne,
  query: h.query,
  execute: h.execute,
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) => fn({ query: h.txQuery }),
}));
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: h.logFromRequest, log: vi.fn() },
}));
vi.mock('../services/audit-context.helpers.js', () => ({ loadEmployeeFullName: vi.fn() }));
vi.mock('../services/employee-changes.service.js', () => ({
  DomainValidationError: class extends Error {},
  employeeChangesService: { changeDepartment: h.changeDepartment },
}));
vi.mock('../services/employee-mapper.service.js', () => ({
  loadStructureCache: vi.fn().mockResolvedValue({ departments: new Map(), positions: new Map() }),
  decryptEmployee: (row: unknown) => row,
}));
vi.mock('../services/employee-cache.service.js', () => ({
  employeeCache: { invalidate: h.invalidate },
}));
vi.mock('../services/employee-archive-department.service.js', () => ({
  isProtectedArchiveDepartment: vi.fn().mockResolvedValue(false),
}));
vi.mock('../services/sigur-linked-employees.service.js', () => ({
  syncLinkedEmployeeFromSigur: vi.fn(),
}));
vi.mock('../services/sigur.service.js', () => ({
  sigurService: {
    isConfigured: h.isConfigured,
    updateEmployee: vi.fn(),
    blockEmployee: vi.fn(),
    unblockEmployee: vi.fn(),
    getDepartmentById: vi.fn(),
  },
}));
vi.mock('../services/data-scope.service.js', () => ({
  canAccessEmployeeInScope: h.canAccessEmployeeInScope,
  canAccessDepartmentInScope: vi.fn().mockResolvedValue(true),
  resolveRequestDataScope: h.resolveScope,
}));
vi.mock('../services/employee-department-access.service.js', () => ({
  upsertTechnicalDepartmentAccess: vi.fn(),
}));
vi.mock('../services/realtime-broadcast.service.js', () => ({ emitDomainChange: vi.fn() }));
vi.mock('../services/recipients.service.js', () => ({
  getEmployeeOwnerAndSupervisor: vi.fn().mockResolvedValue([]),
  getUserIdsByEmployeeIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('../services/employee-lifecycle-operations.service.js', () => ({
  DismissalSigurError: h.DismissalSigurError,
  EMPLOYEE_LIFECYCLE_COLUMNS: 'id, employment_status, org_department_id, sigur_employee_id, dismissal_date, hire_date',
  openDismissOperation: h.openDismiss,
  openRehireOperation: h.openRehire,
  executeOperation: h.executeOp,
}));

import { applyDismissalImmediately, cancelDismissal, fire, rehire } from './employee-lifecycle.controller.js';
import type { AuthenticatedRequest } from '../types/index.js';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status: vi.fn(function (this: { statusCode: number }, c: number) { res.statusCode = c; return res; }),
    json: vi.fn(function (this: { body: unknown }, b: unknown) { res.body = b; return res; }),
  };
  return res;
};

const makeReq = (body: Record<string, unknown> = {}): AuthenticatedRequest => ({
  user: { id: 'admin-1' },
  params: { id: '77' },
  body,
  ip: '127.0.0.1',
  headers: {},
  socket: {},
}) as unknown as AuthenticatedRequest;

const ACTIVE_EMPLOYEE = {
  id: 77,
  employment_status: 'active',
  hire_date: '2020-01-01',
  org_department_id: 'dept-1',
  sigur_employee_id: 555,
  dismissal_date: null,
};

const FIRED_EMPLOYEE = {
  ...ACTIVE_EMPLOYEE,
  employment_status: 'fired',
  org_department_id: 'arch-1',
  dismissal_date: '2026-05-10',
};

const DISMISS_OP = { id: 'op-dismiss-1', kind: 'dismiss', from_department_id: 'dept-1' };
const REHIRE_OP = { id: 'op-rehire-1', kind: 'rehire', target_department_id: 'dept-2' };

const CLAIMED_AT = '2026-05-20 20:00:05.123+00';

/** queryOne: SELECT сотрудника; остальное — по тексту запроса. */
const routeQueryOne = (employee: Record<string, unknown> = { ...ACTIVE_EMPLOYEE }) => {
  h.queryOne.mockImplementation(async (sql: string) => {
    // is_active/is_assignable нужны проверке назначаемости целевого отдела
    // (department-assignability.service): без них отдел выглядит неактивным.
    if (sql.includes('FROM org_departments')) {
      return { id: 'dept-2', sigur_department_id: 42, name: 'Бригада', is_active: true, is_assignable: true };
    }
    if (sql.trim().startsWith('SELECT')) return { ...employee };
    return { ...employee };
  });
};

describe('fire — порог 23:00 МСК', () => {
  beforeEach(() => {
    Object.values(h).forEach(fn => { if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset(); });
    vi.useFakeTimers();
    h.canAccessEmployeeInScope.mockResolvedValue(true);
    h.isConfigured.mockResolvedValue(true);
    h.execute.mockResolvedValue(undefined);
    h.openDismiss.mockResolvedValue({ ...DISMISS_OP });
    h.executeOp.mockResolvedValue({ ...ACTIVE_EMPLOYEE, employment_status: 'fired', org_department_id: 'arch-1' });
    // Отложенное увольнение: CAS-UPDATE + вставка события в одной транзакции.
    h.txQuery.mockImplementation(async (sql: string) => (
      sql.includes('UPDATE employees')
        ? { rows: [{ ...ACTIVE_EMPLOYEE, dismissal_date: '2026-05-20' }], rowCount: 1 }
        : { rows: [], rowCount: 1 }
    ));
    routeQueryOne();
  });
  afterEach(() => vi.useRealTimers());

  it('сегодня до 23:00 МСК → откладывает, операцию не открывает', async () => {
    vi.setSystemTime(new Date('2026-05-20T15:00:00Z')); // 18:00 МСК
    const res = makeRes();
    await fire(makeReq({ dismissalDate: '2026-05-20' }), res as never);

    expect(res.statusCode).toBe(200);
    expect(h.openDismiss).not.toHaveBeenCalled();
    expect(h.executeOp).not.toHaveBeenCalled();
    expect(h.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'admin-1', 'FIRE_EMPLOYEE_SCHEDULED',
      expect.objectContaining({ details: expect.objectContaining({ applies_after: '23:00 MSK' }) }),
    );
  });

  it('сегодня в 23:00 МСК → применяет сразу через durable-операцию', async () => {
    vi.setSystemTime(new Date('2026-05-20T20:00:00Z')); // 23:00 МСК
    const res = makeRes();
    await fire(makeReq({ dismissalDate: '2026-05-20' }), res as never);

    expect(res.statusCode).toBe(200);
    expect(h.openDismiss).toHaveBeenCalledWith(expect.objectContaining({
      employeeId: 77, dismissalDate: '2026-05-20', source: 'manual', claimedAt: null, sigurSteps: 'full',
    }));
    expect(h.executeOp).toHaveBeenCalledWith(expect.objectContaining({ id: 'op-dismiss-1' }), undefined);
    // Событие истории пишет операция — контроллер его не дублирует.
    expect(h.execute).not.toHaveBeenCalledWith(expect.stringContaining('employee_dismissal_events'), expect.anything());
    expect(h.txQuery).not.toHaveBeenCalled();
    expect(h.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'admin-1', 'FIRE_EMPLOYEE',
      expect.objectContaining({ details: expect.objectContaining({ from_department_id: 'dept-1' }) }),
    );
  });

  it('прошедшая дата → применяет сразу', async () => {
    vi.setSystemTime(new Date('2026-05-20T09:00:00Z')); // 12:00 МСК
    const res = makeRes();
    await fire(makeReq({ dismissalDate: '2026-05-19' }), res as never);

    expect(h.executeOp).toHaveBeenCalled();
  });

  it('будущая дата → откладывает', async () => {
    vi.setSystemTime(new Date('2026-05-20T09:00:00Z'));
    const res = makeRes();
    await fire(makeReq({ dismissalDate: '2026-05-25' }), res as never);

    expect(h.executeOp).not.toHaveBeenCalled();
  });

  it('отложенное увольнение: CAS по active + отсутствию claim, revision + событие в той же транзакции', async () => {
    vi.setSystemTime(new Date('2026-05-20T09:00:00Z'));
    const res = makeRes();
    await fire(makeReq({ dismissalDate: '2026-05-25' }), res as never);

    const updateCall = h.txQuery.mock.calls.find(([sql]) => String(sql).includes('UPDATE employees'));
    expect(updateCall).toBeDefined();
    expect(String(updateCall![0])).toContain("employment_status = 'active'");
    expect(String(updateCall![0])).toContain('dismissal_apply_started_at IS NULL');
    // Назначение даты — lifecycle-переход: версия растёт, stale-решение синка станет noop.
    expect(String(updateCall![0])).toContain('lifecycle_revision = lifecycle_revision + 1');
    // Повтор с той же датой не должен пройти как изменение.
    expect(String(updateCall![0])).toContain('dismissal_date IS DISTINCT FROM $1::date');
    // Событие истории пишется тем же соединением — иначе правка и история разъезжаются.
    expect(h.txQuery.mock.calls.some(([sql]) => String(sql).includes('employee_dismissal_events'))).toBe(true);
    expect(h.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('employee_dismissal_events'),
      expect.anything(),
    );
  });

  it('повтор с той же датой → 200 без события и без новой версии (идемпотентно)', async () => {
    vi.setSystemTime(new Date('2026-05-20T09:00:00Z'));
    h.txQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE employees')) return { rows: [], rowCount: 0 };
      if (sql.trim().startsWith('SELECT')) return { rows: [{ ...ACTIVE_EMPLOYEE, dismissal_date: '2026-05-25' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const res = makeRes();
    await fire(makeReq({ dismissalDate: '2026-05-25' }), res as never);

    expect(res.statusCode).toBe(200);
    expect(h.txQuery.mock.calls.some(([sql]) => String(sql).includes('employee_dismissal_events'))).toBe(false);
    expect(h.logFromRequest).not.toHaveBeenCalled();
  });

  it('гонка: сотрудника уже уволили/увольняют → 409, событие не пишется', async () => {
    vi.setSystemTime(new Date('2026-05-20T09:00:00Z'));
    h.txQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    const res = makeRes();
    await fire(makeReq({ dismissalDate: '2026-05-25' }), res as never);

    expect(res.statusCode).toBe(409);
    expect(h.txQuery.mock.calls.some(([sql]) => String(sql).includes('employee_dismissal_events'))).toBe(false);
    expect(h.logFromRequest).not.toHaveBeenCalled();
  });

  it('00:30 МСК (21:30 UTC прошлых суток) — считает дату по МСК', async () => {
    vi.setSystemTime(new Date('2026-05-19T21:30:00Z')); // 00:30 МСК 20-го
    const res = makeRes();
    await fire(makeReq({ dismissalDate: '2026-05-20' }), res as never);

    // По UTC это «завтра», по МСК — «сегодня до 23:00»: в обоих случаях откладываем,
    // но применяться должно с 23:00 МСК 20-го, а не 19-го.
    expect(h.executeOp).not.toHaveBeenCalled();
  });

  it('ошибка Sigur внутри операции → ответ с кодом частичного применения, операция остаётся pending', async () => {
    vi.setSystemTime(new Date('2026-05-20T20:00:00Z'));
    h.executeOp.mockRejectedValue(new h.DismissalSigurError('block failed', 502, 'SIGUR_PARTIAL_FAILURE', true, false));
    const res = makeRes();
    await fire(makeReq({ dismissalDate: '2026-05-20' }), res as never);

    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ success: false, code: 'SIGUR_PARTIAL_FAILURE' });
    expect(h.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'admin-1', 'FIRE_EMPLOYEE',
      expect.objectContaining({ details: expect.objectContaining({ partial_failure: true, movedToArchive: true }) }),
    );
  });
});

describe('applyDismissalImmediately — обёртка над durable-операцией', () => {
  beforeEach(() => {
    Object.values(h).forEach(fn => { if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset(); });
    h.openDismiss.mockResolvedValue({ ...DISMISS_OP });
    h.executeOp.mockResolvedValue({ ...ACTIVE_EMPLOYEE, employment_status: 'fired' });
  });

  const callApply = (overrides: Record<string, unknown> = {}) =>
    applyDismissalImmediately({
      employeeId: 77,
      existing: { ...ACTIVE_EMPLOYEE } as never,
      dismissalDate: '2026-05-20',
      userId: 'admin-1',
      ...overrides,
    });

  it('ручной вызов: операция открывается с claim (claimedAt=null), source=manual, затем исполняется', async () => {
    const result = await callApply();

    expect(h.openDismiss).toHaveBeenCalledWith({
      employeeId: 77,
      dismissalDate: '2026-05-20',
      source: 'manual',
      createdBy: 'admin-1',
      connection: undefined,
      claimedAt: null,
      sigurSteps: 'full',
    });
    expect(h.executeOp).toHaveBeenCalledWith(expect.objectContaining({ id: 'op-dismiss-1' }), undefined);
    expect(result.fromDepartmentId).toBe('dept-1');
    expect(result.employee).toMatchObject({ employment_status: 'fired' });
  });

  it('планировщик передал claimedAt → source=scheduler, claim не перезахватывается', async () => {
    await callApply({ claimedAt: CLAIMED_AT });

    expect(h.openDismiss).toHaveBeenCalledWith(expect.objectContaining({ claimedAt: CLAIMED_AT, source: 'scheduler' }));
  });

  it('явный source (contractor_admin) сохраняется', async () => {
    await callApply({ source: 'contractor_admin' });

    expect(h.openDismiss).toHaveBeenCalledWith(expect.objectContaining({ source: 'contractor_admin' }));
  });

  it('операция уже выполняется (409 при открытии) → ошибка со status, исполнение не запускается', async () => {
    h.openDismiss.mockRejectedValue(Object.assign(new Error('уже применяется'), { status: 409, code: 'OPERATION_IN_PROGRESS' }));

    await expect(callApply()).rejects.toMatchObject({ status: 409, code: 'OPERATION_IN_PROGRESS' });
    expect(h.executeOp).not.toHaveBeenCalled();
  });

  it('ошибка Sigur при исполнении → DismissalSigurError наружу с признаками шагов', async () => {
    h.executeOp.mockRejectedValue(new h.DismissalSigurError('sigur down', 500, 'SIGUR_WRITE_FAILED', false, false));

    await expect(callApply()).rejects.toMatchObject({ code: 'SIGUR_WRITE_FAILED', movedToArchive: false });
  });
});

describe('cancelDismissal — гонка с планировщиком', () => {
  beforeEach(() => {
    Object.values(h).forEach(fn => { if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset(); });
    h.canAccessEmployeeInScope.mockResolvedValue(true);
    h.execute.mockResolvedValue(undefined);
  });

  it('claim не выставлен → отменяет и поднимает lifecycle_revision', async () => {
    h.queryOne.mockImplementation(async (sql: string) => {
      if (sql.trim().startsWith('SELECT')) return { ...ACTIVE_EMPLOYEE, dismissal_date: '2026-05-20' };
      return { ...ACTIVE_EMPLOYEE, dismissal_date: null };
    });
    const res = makeRes();
    await cancelDismissal(makeReq(), res as never);

    expect(res.statusCode).toBe(200);
    const updateSql = h.queryOne.mock.calls[1][0] as string;
    expect(updateSql).toContain('dismissal_apply_started_at IS NULL');
    expect(updateSql).toContain('lifecycle_revision = lifecycle_revision + 1');
  });

  it('планировщик уже захватил запись (UPDATE вернул 0 строк) → 409', async () => {
    h.queryOne.mockImplementation(async (sql: string) => {
      if (sql.trim().startsWith('SELECT')) return { ...ACTIVE_EMPLOYEE, dismissal_date: '2026-05-20' };
      return null;
    });
    const res = makeRes();
    await cancelDismissal(makeReq(), res as never);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ success: false });
  });
});

describe('rehire — durable-операция восстановления', () => {
  beforeEach(() => {
    Object.values(h).forEach(fn => { if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset(); });
    h.canAccessEmployeeInScope.mockResolvedValue(true);
    h.resolveScope.mockResolvedValue('all');
    h.isConfigured.mockResolvedValue(true);
    h.openRehire.mockResolvedValue({ ...REHIRE_OP });
    h.executeOp.mockResolvedValue({ ...ACTIVE_EMPLOYEE, org_department_id: 'dept-2', dismissal_date: null });
    routeQueryOne({ ...FIRED_EMPLOYEE });
  });

  it('уволенный → операция открывается ДО Sigur с целью из отдела, исполняется, аудит с operation_id', async () => {
    const res = makeRes();
    await rehire(makeReq({ org_department_id: 'dept-2' }), res as never);

    expect(res.statusCode).toBe(200);
    expect(h.openRehire).toHaveBeenCalledWith({
      employeeId: 77,
      targetDepartmentId: 'dept-2',
      targetSigurDepartmentId: 42,
      createdBy: 'admin-1',
    });
    expect(h.executeOp).toHaveBeenCalledWith(expect.objectContaining({ id: 'op-rehire-1' }), undefined);
    // Контроллер сам ничего не пишет в employees/историю — всё внутри операции.
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.changeDepartment).not.toHaveBeenCalled();
    expect(h.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'admin-1', 'REHIRE_EMPLOYEE',
      expect.objectContaining({
        details: expect.objectContaining({
          operation_id: 'op-rehire-1', source: 'sigur', detached_from_sigur: false, prev_dismissal_date: '2026-05-10',
        }),
      }),
    );
  });

  it('сотрудник не уволен → 409, операция не открывается', async () => {
    routeQueryOne({ ...ACTIVE_EMPLOYEE });
    const res = makeRes();
    await rehire(makeReq({ org_department_id: 'dept-2' }), res as never);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'NOT_FIRED' });
    expect(h.openRehire).not.toHaveBeenCalled();
    expect(h.executeOp).not.toHaveBeenCalled();
  });

  it('ошибка Sigur при исполнении → 502 OPERATION_PENDING, операция сохранена, аудит pending', async () => {
    h.executeOp.mockRejectedValue(new Error('sigur down'));
    const res = makeRes();
    await rehire(makeReq({ org_department_id: 'dept-2' }), res as never);

    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ success: false, code: 'OPERATION_PENDING' });
    expect(h.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'admin-1', 'REHIRE_EMPLOYEE',
      expect.objectContaining({ details: expect.objectContaining({ operation_id: 'op-rehire-1', pending: true }) }),
    );
  });

  it('операцию уже выполняет другой исполнитель → 409 из исполнителя пробрасывается', async () => {
    h.executeOp.mockRejectedValue(Object.assign(new Error('выполняется'), { status: 409, code: 'OPERATION_IN_PROGRESS' }));
    const res = makeRes();
    await rehire(makeReq({ org_department_id: 'dept-2' }), res as never);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'OPERATION_IN_PROGRESS' });
  });

  it('открытие вернуло 409 (rehire в другой отдел уже идёт) → 409, исполнение не запускается', async () => {
    h.openRehire.mockRejectedValue(Object.assign(new Error('другой отдел'), { status: 409, code: 'OPERATION_IN_PROGRESS' }));
    const res = makeRes();
    await rehire(makeReq({ org_department_id: 'dept-2' }), res as never);

    expect(res.statusCode).toBe(409);
    expect(h.executeOp).not.toHaveBeenCalled();
  });

  it('отвязка от Sigur внутри операции отражается в аудите (detached_from_sigur)', async () => {
    h.executeOp.mockResolvedValue({ ...ACTIVE_EMPLOYEE, org_department_id: 'dept-2', sigur_employee_id: null });
    const res = makeRes();
    await rehire(makeReq({ org_department_id: 'dept-2' }), res as never);

    expect(res.statusCode).toBe(200);
    expect(h.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'admin-1', 'REHIRE_EMPLOYEE',
      expect.objectContaining({
        details: expect.objectContaining({ source: 'portal', detached_from_sigur: true, previous_sigur_employee_id: 555 }),
      }),
    );
  });
});
