/**
 * Блокировка сотрудника Sigur: обязательная причина, строгая запись журнала
 * в одной транзакции с вызовом Sigur, без обходов через PUT и создание.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const h = vi.hoisted(() => ({
  updateEmployee: vi.fn(),
  createEmployee: vi.fn(),
  getProfile: vi.fn(),
  logWithClient: vi.fn(),
  logFromRequest: vi.fn(),
  clientQuery: vi.fn(),
  blockInfo: vi.fn(),
}));

vi.mock('../services/sigur-live-employees-crud.service.js', () => ({
  batchMoveSigurEmployees: vi.fn(),
  batchMoveSigurEmployeesStreaming: vi.fn(),
  createSigurEmployee: h.createEmployee,
  deleteSigurEmployee: vi.fn(),
  moveSigurEmployee: vi.fn(),
  updateSigurEmployee: h.updateEmployee,
}));
vi.mock('../services/sigur-live-admin.service.js', () => ({
  getSigurEmployeeProfile: h.getProfile,
  getSigurEmployeeCardStatuses: vi.fn(),
  listSigurAccessPointOptions: vi.fn(),
  listSigurDepartmentCounts: vi.fn(),
  listSigurDepartmentsTree: vi.fn(),
  listOrgDepartmentsAsSigurTree: vi.fn(),
  listSigurEmployees: vi.fn(),
}));
vi.mock('../services/sigur-employee-block.service.js', () => ({ getSigurEmployeeBlockInfo: h.blockInfo }));
vi.mock('../services/audit.service.js', () => ({
  auditService: {
    logFromRequest: h.logFromRequest,
    logFromRequestWithClient: h.logWithClient,
  },
}));
vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({ query: h.clientQuery })),
}));

const { sigurAdminController } = await import('./sigur-admin.controller.js');

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: { success: boolean; error?: string; data?: unknown } };
};

const makeReq = (params: Record<string, string>, body: Record<string, unknown> = {}) => ({
  user: { id: 'user-1' },
  params,
  query: {},
  body,
  ip: '127.0.0.1',
  get: () => 'vitest',
  headers: {},
}) as unknown as AuthenticatedRequest;

const PROFILE = { sigurEmployeeId: 90329, profile: { blocked: false } };
const BLOCKED_PROFILE = { sigurEmployeeId: 90329, profile: { blocked: true } };

describe('sigurAdminController.blockEmployee', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.getProfile.mockResolvedValue(PROFILE);
    h.updateEmployee.mockResolvedValue(BLOCKED_PROFILE);
    h.logWithClient.mockResolvedValue(undefined);
    h.clientQuery.mockResolvedValue({ rows: [] });
  });

  it.each([
    [{ sigurEmployeeId: '0' }, { reason: 'Нарушение' }],
    [{ sigurEmployeeId: '-1' }, { reason: 'Нарушение' }],
    [{ sigurEmployeeId: '90329' }, {}],
    [{ sigurEmployeeId: '90329' }, { reason: '   ' }],
    [{ sigurEmployeeId: '90329' }, { reason: 42 }],
    [{ sigurEmployeeId: '90329' }, { reason: 'x'.repeat(501) }],
  ])('%o %o → 400 без журнала и Sigur', async (params, body) => {
    const res = makeRes();
    await sigurAdminController.blockEmployee(makeReq(params, body), res);

    expect(res.statusCode).toBe(400);
    expect(h.logWithClient).not.toHaveBeenCalled();
    expect(h.updateEmployee).not.toHaveBeenCalled();
  });

  it('пишет причину под локом профиля, затем блокирует в Sigur', async () => {
    const res = makeRes();
    await sigurAdminController.blockEmployee(
      makeReq({ sigurEmployeeId: '90329' }, { reason: '  Нарушение пропускного режима  ' }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: BLOCKED_PROFILE });
    expect(h.clientQuery).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      ['blacklist:sigur:90329'],
    );
    expect(h.logWithClient).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'user-1',
      'UPDATE_EMPLOYEE',
      {
        entityType: 'sigur_employee',
        entityId: '90329',
        details: { action: 'block', reason: 'Нарушение пропускного режима' },
      },
    );
    expect(h.updateEmployee).toHaveBeenCalledWith(90329, { blocked: true }, undefined);
    expect(h.logWithClient.mock.invocationCallOrder[0]).toBeLessThan(h.updateEmployee.mock.invocationCallOrder[0]);
  });

  it('уже заблокирован → 409, причина и автор не перезаписываются', async () => {
    h.getProfile.mockResolvedValue(BLOCKED_PROFILE);
    const res = makeRes();

    await sigurAdminController.blockEmployee(makeReq({ sigurEmployeeId: '90329' }, { reason: 'Повтор' }), res);

    expect(res.statusCode).toBe(409);
    expect(h.logWithClient).not.toHaveBeenCalled();
    expect(h.updateEmployee).not.toHaveBeenCalled();
  });

  it('сбой записи журнала → Sigur не вызывается, ответ не успешный', async () => {
    h.logWithClient.mockRejectedValue(new Error('insert failed'));
    const res = makeRes();

    await sigurAdminController.blockEmployee(makeReq({ sigurEmployeeId: '90329' }, { reason: 'Нарушение' }), res);

    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
    expect(h.updateEmployee).not.toHaveBeenCalled();
  });

  it('сбой Sigur → ошибка из транзакции (запись откатится), ответ не успешный', async () => {
    h.updateEmployee.mockRejectedValue(new Error('Sigur unavailable'));
    const res = makeRes();

    await sigurAdminController.blockEmployee(makeReq({ sigurEmployeeId: '90329' }, { reason: 'Нарушение' }), res);

    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

describe('обходы блокировки без причины', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('PUT сотрудника: blocked из body не доходит до Sigur', async () => {
    h.updateEmployee.mockResolvedValue(PROFILE);
    const res = makeRes();

    await sigurAdminController.updateEmployee(
      makeReq({ sigurEmployeeId: '90329' }, { name: 'Бозоров Шерзод Исакулович', blocked: true }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const input = h.updateEmployee.mock.calls[0][1] as Record<string, unknown>;
    expect(input).not.toHaveProperty('blocked');
  });

  it('создание сразу заблокированным → 400, карточка не создаётся', async () => {
    const res = makeRes();

    await sigurAdminController.createEmployee(
      makeReq({}, { name: 'Иванов Иван', departmentId: 10, blocked: true }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(h.createEmployee).not.toHaveBeenCalled();
  });
});

describe('sigurAdminController.getEmployeeBlockInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it.each(['0', '-1', 'abc'])('ID %s → 400', async id => {
    const res = makeRes();
    await sigurAdminController.getEmployeeBlockInfo(makeReq({ sigurEmployeeId: id }), res);
    expect(res.statusCode).toBe(400);
    expect(h.blockInfo).not.toHaveBeenCalled();
  });

  it('отдаёт причину; ошибка сервиса → 500, а не «причины нет»', async () => {
    const info = { blockedAt: '2026-10-07T07:04:17.799Z', blockedByName: 'Гладкая Наталья Васильевна', reason: 'Нарушение' };
    h.blockInfo.mockResolvedValueOnce(info);
    const ok = makeRes();
    await sigurAdminController.getEmployeeBlockInfo(makeReq({ sigurEmployeeId: '150712' }), ok);
    expect(ok.body).toEqual({ success: true, data: info });

    h.blockInfo.mockRejectedValueOnce(new Error('db down'));
    const failed = makeRes();
    await sigurAdminController.getEmployeeBlockInfo(makeReq({ sigurEmployeeId: '150712' }), failed);
    expect(failed.statusCode).toBe(500);
    expect(failed.body.success).toBe(false);
  });
});
