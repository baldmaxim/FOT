import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  queryOne: vi.fn(),
  query: vi.fn(),
  execute: vi.fn(),
  txQuery: vi.fn(),
  canAccessEmployeeInScope: vi.fn(),
  logFromRequest: vi.fn(),
  blockEmployee: vi.fn(),
  updateSigurEmployee: vi.fn(),
  isConfigured: vi.fn(),
  ensureArchiveSigur: vi.fn(),
  ensureLocalArchive: vi.fn(),
  changeDepartment: vi.fn(),
  deactivateAccess: vi.fn(),
  invalidate: vi.fn(),
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
  ensureLocalArchiveDepartment: h.ensureLocalArchive,
  isProtectedArchiveDepartment: vi.fn().mockResolvedValue(false),
}));
vi.mock('../services/sigur-linked-employees.service.js', () => ({
  ensureArchiveSigurDepartment: h.ensureArchiveSigur,
  syncLinkedEmployeeFromSigur: vi.fn(),
}));
vi.mock('../services/sigur.service.js', () => ({
  sigurService: {
    isConfigured: h.isConfigured,
    updateEmployee: h.updateSigurEmployee,
    blockEmployee: h.blockEmployee,
    unblockEmployee: vi.fn(),
    getDepartmentById: vi.fn(),
  },
}));
vi.mock('../services/data-scope.service.js', () => ({
  canAccessEmployeeInScope: h.canAccessEmployeeInScope,
  canAccessDepartmentInScope: vi.fn(),
  resolveRequestDataScope: vi.fn(),
}));
vi.mock('../services/employee-department-access.service.js', () => ({
  upsertTechnicalDepartmentAccess: vi.fn(),
  deactivateAllDepartmentAccessForEmployee: h.deactivateAccess,
}));
vi.mock('../services/realtime-broadcast.service.js', () => ({ emitDomainChange: vi.fn() }));
vi.mock('../services/recipients.service.js', () => ({
  getEmployeeOwnerAndSupervisor: vi.fn().mockResolvedValue([]),
  getUserIdsByEmployeeIds: vi.fn().mockResolvedValue([]),
}));

import { applyDismissalImmediately, cancelDismissal, fire } from './employee-lifecycle.controller.js';
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

const CLAIMED_AT = '2026-05-20 20:00:05.123+00';

const isClaimSql = (sql: string): boolean =>
  /UPDATE employees/i.test(sql) && sql.includes('dismissal_apply_started_at = now()');

/** queryOne: SELECT сотрудника, CAS-claim увольнения, дальше — по тексту запроса. */
const routeQueryOne = (
  updated: Record<string, unknown> | null = { ...ACTIVE_EMPLOYEE },
  claimResult: { claimed_at: string } | null = { claimed_at: CLAIMED_AT },
) => {
  h.queryOne.mockImplementation(async (sql: string) => {
    if (sql.trim().startsWith('SELECT')) return { ...ACTIVE_EMPLOYEE };
    if (isClaimSql(sql)) return claimResult;
    return updated;
  });
};

describe('fire — порог 23:00 МСК', () => {
  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    vi.useFakeTimers();
    h.canAccessEmployeeInScope.mockResolvedValue(true);
    h.isConfigured.mockResolvedValue(true);
    h.ensureArchiveSigur.mockResolvedValue({ sigurDepartmentId: 9, localDepartmentId: 'arch-1' });
    h.ensureLocalArchive.mockResolvedValue({ id: 'arch-1' });
    h.execute.mockResolvedValue(undefined);
    // Отложенное увольнение: CAS-UPDATE + вставка события в одной транзакции.
    h.txQuery.mockImplementation(async (sql: string) => (
      sql.includes('UPDATE employees')
        ? { rows: [{ ...ACTIVE_EMPLOYEE, dismissal_date: '2026-05-20' }], rowCount: 1 }
        : { rows: [], rowCount: 1 }
    ));
    routeQueryOne();
  });
  afterEach(() => vi.useRealTimers());

  it('сегодня до 23:00 МСК → откладывает, Sigur не трогает', async () => {
    vi.setSystemTime(new Date('2026-05-20T15:00:00Z')); // 18:00 МСК
    const res = makeRes();
    await fire(makeReq({ dismissalDate: '2026-05-20' }), res as never);

    expect(res.statusCode).toBe(200);
    expect(h.blockEmployee).not.toHaveBeenCalled();
    expect(h.updateSigurEmployee).not.toHaveBeenCalled();
    expect(h.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'admin-1', 'FIRE_EMPLOYEE_SCHEDULED',
      expect.objectContaining({ details: expect.objectContaining({ applies_after: '23:00 MSK' }) }),
    );
  });

  it('сегодня в 23:00 МСК → применяет сразу (блокирует карту)', async () => {
    vi.setSystemTime(new Date('2026-05-20T20:00:00Z')); // 23:00 МСК
    const res = makeRes();
    await fire(makeReq({ dismissalDate: '2026-05-20' }), res as never);

    expect(res.statusCode).toBe(200);
    expect(h.blockEmployee).toHaveBeenCalledWith(555, undefined);
    expect(h.logFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'admin-1', 'FIRE_EMPLOYEE', expect.anything(),
    );
  });

  it('прошедшая дата → применяет сразу', async () => {
    vi.setSystemTime(new Date('2026-05-20T09:00:00Z')); // 12:00 МСК
    const res = makeRes();
    await fire(makeReq({ dismissalDate: '2026-05-19' }), res as never);

    expect(h.blockEmployee).toHaveBeenCalled();
  });

  it('будущая дата → откладывает', async () => {
    vi.setSystemTime(new Date('2026-05-20T09:00:00Z'));
    const res = makeRes();
    await fire(makeReq({ dismissalDate: '2026-05-25' }), res as never);

    expect(h.blockEmployee).not.toHaveBeenCalled();
  });

  it('отложенное увольнение: CAS по active + отсутствию claim, событие в той же транзакции', async () => {
    vi.setSystemTime(new Date('2026-05-20T09:00:00Z'));
    const res = makeRes();
    await fire(makeReq({ dismissalDate: '2026-05-25' }), res as never);

    const updateCall = h.txQuery.mock.calls.find(([sql]) => String(sql).includes('UPDATE employees'));
    expect(updateCall).toBeDefined();
    expect(String(updateCall![0])).toContain("employment_status = 'active'");
    expect(String(updateCall![0])).toContain('dismissal_apply_started_at IS NULL');
    // Событие истории пишется тем же соединением — иначе правка и история разъезжаются.
    expect(h.txQuery.mock.calls.some(([sql]) => String(sql).includes('employee_dismissal_events'))).toBe(true);
    expect(h.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('employee_dismissal_events'),
      expect.anything(),
    );
  });

  it('гонка: сотрудника уже уволили/увольняют → 409, событие не пишется', async () => {
    vi.setSystemTime(new Date('2026-05-20T09:00:00Z'));
    h.txQuery.mockImplementation(async (sql: string) => (
      sql.includes('UPDATE employees') ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 1 }
    ));
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
    expect(h.blockEmployee).not.toHaveBeenCalled();
  });
});

describe('applyDismissalImmediately — CAS-claim увольнения', () => {
  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    h.isConfigured.mockResolvedValue(true);
    h.ensureArchiveSigur.mockResolvedValue({ sigurDepartmentId: 9, localDepartmentId: 'arch-1' });
    h.ensureLocalArchive.mockResolvedValue({ id: 'arch-1' });
    h.changeDepartment.mockResolvedValue('applied');
    h.execute.mockResolvedValue(undefined);
    routeQueryOne();
  });

  const callApply = (overrides: Record<string, unknown> = {}) =>
    applyDismissalImmediately({
      employeeId: 77,
      existing: { ...ACTIVE_EMPLOYEE } as never,
      dismissalDate: '2026-05-20',
      userId: 'admin-1',
      ...overrides,
    });

  it('ручной вызов: claim и dismissal_date пишутся одним UPDATE через CAS', async () => {
    await callApply();

    const claimCall = h.queryOne.mock.calls.find(c => isClaimSql(String(c[0])));
    expect(claimCall).toBeTruthy();
    const sql = String(claimCall![0]);
    // Атомарно: маркер + дата в одном UPDATE (падение между Sigur и локальной
    // записью не оставит сотрудника active без dismissal_date).
    expect(sql).toContain('dismissal_apply_started_at = now()');
    expect(sql).toContain('dismissal_date = $2');
    // CAS: чужой свежий claim не перезаписывается.
    expect(sql).toContain('dismissal_apply_started_at IS NULL');
    expect(sql).toMatch(/dismissal_apply_started_at < now\(\)/);
    expect(claimCall![1]).toEqual([77, '2026-05-20', '30']);
  });

  it('claim не захвачен (чужой активный) → 409, Sigur не трогается', async () => {
    routeQueryOne({ ...ACTIVE_EMPLOYEE }, null);

    await expect(callApply()).rejects.toMatchObject({ status: 409 });
    expect(h.updateSigurEmployee).not.toHaveBeenCalled();
    expect(h.blockEmployee).not.toHaveBeenCalled();
  });

  it('планировщик передал claimedAt → метод НЕ перезахватывает claim (нет ложного 409)', async () => {
    routeQueryOne({ ...ACTIVE_EMPLOYEE }, null); // CAS вернул бы конфликт, но он не должен вызываться

    await expect(callApply({ claimedAt: CLAIMED_AT })).resolves.toBeTruthy();
    const claimCall = h.queryOne.mock.calls.find(c => isClaimSql(String(c[0])));
    expect(claimCall).toBeUndefined();
  });

  it('полная ошибка Sigur (перенос не выполнен) → снимает СВОЙ claim и восстанавливает прежний dismissal_date', async () => {
    h.updateSigurEmployee.mockRejectedValue(new Error('sigur down'));

    await expect(callApply()).rejects.toMatchObject({ code: 'SIGUR_WRITE_FAILED' });

    const release = h.execute.mock.calls.find(c => String(c[0]).includes('dismissal_apply_started_at = NULL'));
    expect(release).toBeTruthy();
    // Освобождение только собственного claim по точному timestamp + возврат прежней даты (null).
    expect(String(release![0])).toContain('dismissal_apply_started_at = $2::timestamptz');
    expect(release![1]).toEqual([77, CLAIMED_AT, null]);
  });

  it('частичная ошибка Sigur (перенесён, но не заблокирован) → claim НЕ снимается (повтор после lease)', async () => {
    h.blockEmployee.mockRejectedValue(new Error('block failed'));

    await expect(callApply()).rejects.toMatchObject({ code: 'SIGUR_PARTIAL_FAILURE' });

    const release = h.execute.mock.calls.find(c => String(c[0]).includes('dismissal_apply_started_at = NULL'));
    expect(release).toBeUndefined();
  });
});

describe('cancelDismissal — гонка с планировщиком', () => {
  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    h.canAccessEmployeeInScope.mockResolvedValue(true);
    h.execute.mockResolvedValue(undefined);
  });

  it('claim не выставлен → отменяет', async () => {
    h.queryOne.mockImplementation(async (sql: string) => {
      if (sql.trim().startsWith('SELECT')) return { ...ACTIVE_EMPLOYEE, dismissal_date: '2026-05-20' };
      return { ...ACTIVE_EMPLOYEE, dismissal_date: null };
    });
    const res = makeRes();
    await cancelDismissal(makeReq(), res as never);

    expect(res.statusCode).toBe(200);
    const updateSql = h.queryOne.mock.calls[1][0] as string;
    expect(updateSql).toContain('dismissal_apply_started_at IS NULL');
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
