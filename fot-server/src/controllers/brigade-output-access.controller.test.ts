import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

/** Вкладка «Выработка» (миграция 342): валидация, зона админа компании, аудит в транзакции, обновление профиля. */

const { h } = vi.hoisted(() => ({
  h: {
    query: vi.fn(),
    queryOne: vi.fn(),
    client: { query: vi.fn() },
    canAccess: vi.fn(),
    canWrite: vi.fn(),
    load: vi.fn(),
    set: vi.fn(),
    audit: vi.fn(),
    emit: vi.fn(),
  },
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: h.queryOne,
  withTransaction: async <T>(fn: (client: unknown) => Promise<T>) => fn(h.client),
}));
vi.mock('../services/audit.service.js', () => ({ auditService: { logFromRequestWithClient: h.audit } }));
vi.mock('../services/data-scope.service.js', () => ({
  canAccessEmployeeInScope: h.canAccess,
  canWriteEmployeeInScope: h.canWrite,
}));
vi.mock('../services/payroll/brigade-output-access.service.js', () => ({
  loadBrigadeOutputGrant: h.load,
  setBrigadeOutputGrant: h.set,
}));
vi.mock('../socket/io-instance.js', () => ({ getIo: () => ({ to: () => ({ emit: h.emit }) }) }));

const { brigadeOutputAccessController } = await import('./brigade-output-access.controller.js');

const EMPLOYEE = 1429;

const makeReq = (id: unknown, body: unknown = {}): AuthenticatedRequest => ({
  params: { id: String(id) },
  body,
  user: { id: 'admin-user', employee_id: 1, role_code: 'admin', is_admin: true },
} as unknown as AuthenticatedRequest);

const makeRes = () => {
  const res = { statusCode: 200, body: null as unknown } as {
    statusCode: number; body: any; status: (c: number) => unknown; json: (b: unknown) => unknown;
  };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((payload: unknown) => { res.body = payload; return res; });
  return res;
};

const put = async (body: unknown, id: unknown = EMPLOYEE) => {
  const res = makeRes();
  await brigadeOutputAccessController.set(makeReq(id, body), res as unknown as Response);
  return res;
};

const get = async (id: unknown = EMPLOYEE) => {
  const res = makeRes();
  await brigadeOutputAccessController.get(makeReq(id), res as unknown as Response);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  h.queryOne.mockImplementation(async (_sql: string, params: unknown[]) => (
    params[0] === EMPLOYEE ? { id: EMPLOYEE, full_name: 'Потапов Максим Олегович' } : null
  ));
  h.query.mockResolvedValue([{ id: 'profile-potapov' }]);
  h.canAccess.mockResolvedValue(true);
  h.canWrite.mockResolvedValue(true);
  h.load.mockResolvedValue(false);
  h.set.mockResolvedValue(true);
});

describe('GET /admin/employees/:id/brigade-output-access', () => {
  it('отдаёт галочку', async () => {
    h.load.mockResolvedValue(true);
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ granted: true });
  });

  it('некорректный id — 400, нет сотрудника — 404, вне зоны — 403, галочка не читается', async () => {
    expect((await get('abc')).statusCode).toBe(400);
    expect((await get(404404)).statusCode).toBe(404);
    h.canAccess.mockResolvedValue(false);
    expect((await get()).statusCode).toBe(403);
    expect(h.load).not.toHaveBeenCalled();
  });

  it('ошибка базы — 500, а не «нет доступа»: панель не затрёт неизвестное значение', async () => {
    h.load.mockRejectedValue(new Error('db down'));
    expect((await get()).statusCode).toBe(500);
  });
});

describe('PUT /admin/employees/:id/brigade-output-access', () => {
  it('поставить: аудит в той же транзакции, сотруднику — обновление профиля', async () => {
    const res = await put({ granted: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ granted: true });
    expect(h.set).toHaveBeenCalledWith(h.client, EMPLOYEE, true, 'admin-user');
    expect(h.audit).toHaveBeenCalledWith(
      h.client, expect.anything(), 'admin-user', 'EMPLOYEE_BRIGADE_OUTPUT_ACCESS_CHANGED',
      expect.objectContaining({ entityId: String(EMPLOYEE), details: expect.objectContaining({ granted: true }) }),
    );
    expect(h.emit).toHaveBeenCalledWith('profile:access_changed');
  });

  it('без изменений — ни аудита, ни оповещения', async () => {
    h.set.mockResolvedValue(false);
    expect((await put({ granted: true })).statusCode).toBe(200);
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('выдать вне зоны — 403 без записи; снять можно и вне зоны', async () => {
    h.canWrite.mockResolvedValue(false);
    expect((await put({ granted: true })).statusCode).toBe(403);
    expect(h.set).not.toHaveBeenCalled();
    expect((await put({ granted: false })).statusCode).toBe(200);
    expect(h.set).toHaveBeenCalledWith(h.client, EMPLOYEE, false, 'admin-user');
  });

  it('некорректные id и тело — 400, нет сотрудника — 404', async () => {
    expect((await put({ granted: true }, 'abc')).statusCode).toBe(400);
    expect((await put({ granted: 'yes' })).statusCode).toBe(400);
    expect((await put({})).statusCode).toBe(400);
    expect((await put({ granted: true }, 404404)).statusCode).toBe(404);
    expect(h.set).not.toHaveBeenCalled();
  });

  it('сбой оповещения не превращает сохранение в ошибку', async () => {
    h.query.mockRejectedValue(new Error('io down'));
    expect((await put({ granted: true })).statusCode).toBe(200);
  });
});
