import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  queryOne: vi.fn(),
  query: vi.fn(),
  execute: vi.fn(),
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

import { cancelDismissal, fire } from './employee-lifecycle.controller.js';
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

/** queryOne: сначала SELECT сотрудника, дальше — по тексту запроса. */
const routeQueryOne = (updated: Record<string, unknown> | null = { ...ACTIVE_EMPLOYEE }) => {
  h.queryOne.mockImplementation(async (sql: string) => {
    if (sql.trim().startsWith('SELECT')) return { ...ACTIVE_EMPLOYEE };
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

  it('00:30 МСК (21:30 UTC прошлых суток) — считает дату по МСК', async () => {
    vi.setSystemTime(new Date('2026-05-19T21:30:00Z')); // 00:30 МСК 20-го
    const res = makeRes();
    await fire(makeReq({ dismissalDate: '2026-05-20' }), res as never);

    // По UTC это «завтра», по МСК — «сегодня до 23:00»: в обоих случаях откладываем,
    // но применяться должно с 23:00 МСК 20-го, а не 19-го.
    expect(h.blockEmployee).not.toHaveBeenCalled();
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
