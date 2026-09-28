import { readFileSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Вкладка «Зарплата» в панели назначений: выдача, смена и снятие персонального доступа
 * (миграция 288). Аудит — в транзакции записи и только при реальном изменении; меню
 * обновляется у ВСЕХ учёток сотрудника (профилей бывает два).
 */

const h = vi.hoisted(() => {
  const txClient = { query: vi.fn() };
  const emit = vi.fn();
  return {
    txClient,
    emit,
    to: vi.fn(() => ({ emit })),
    query: vi.fn(),
    queryOne: vi.fn(),
    withTransaction: vi.fn(async (fn: (c: unknown) => unknown) => fn(txClient)),
    auditWithClient: vi.fn(async (..._args: unknown[]) => undefined),
  };
});

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: h.queryOne,
  withTransaction: h.withTransaction,
}));
vi.mock('../socket/io-instance.js', () => ({ getIo: () => ({ to: h.to }) }));
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequestWithClient: h.auditWithClient },
}));

import { payrollAccessController } from './payroll-access.controller.js';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: any };
};

const makeReq = (params: Record<string, string>, body: unknown = {}): AuthenticatedRequest => ({
  user: { id: 'admin-1', is_admin: true },
  params,
  body,
} as unknown as AuthenticatedRequest);

/** Текущая строка гранта в «БД» для SELECT … FOR UPDATE. */
const currentGrant = (level: 'view' | 'edit' | null) => {
  h.txClient.query.mockImplementation(async (sql: string) => (
    sql.includes('FOR UPDATE') ? { rows: level ? [{ access_level: level }] : [] } : { rows: [] }
  ));
};

const txSql = () => h.txClient.query.mock.calls.map(([sql]) => String(sql));

beforeEach(() => {
  vi.clearAllMocks();
  h.queryOne.mockResolvedValue({ id: 42, full_name: 'Бухгалтер Б.Б.' });
  h.query.mockImplementation(async (sql: string) => (
    sql.includes('user_profiles') ? [{ id: 'profile-a' }, { id: 'profile-b' }] : []
  ));
  currentGrant(null);
});

describe('GET /admin/employees/:id/payroll-access', () => {
  it('возвращает текущий уровень', async () => {
    h.query.mockResolvedValueOnce([{ access_level: 'view' }]);
    const res = makeRes();
    await payrollAccessController.get(makeReq({ id: '42' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ level: 'view' });
  });

  it('некорректный id — 400, неизвестный сотрудник — 404', async () => {
    const bad = makeRes();
    await payrollAccessController.get(makeReq({ id: 'abc' }), bad);
    expect(bad.statusCode).toBe(400);

    h.queryOne.mockResolvedValueOnce(null);
    const missing = makeRes();
    await payrollAccessController.get(makeReq({ id: '999' }), missing);
    expect(missing.statusCode).toBe(404);
  });

  it('ошибка БД — 500, а не «Нет доступа», который потом сохранят поверх гранта', async () => {
    h.query.mockRejectedValueOnce(new Error('db down'));
    const res = makeRes();
    await payrollAccessController.get(makeReq({ id: '42' }), res);
    expect(res.statusCode).toBe(500);
  });
});

describe('PUT /admin/employees/:id/payroll-access', () => {
  it('неверный уровень — 400, в БД ничего не пишется', async () => {
    const res = makeRes();
    await payrollAccessController.set(makeReq({ id: '42' }, { level: 'admin' }), res);
    expect(res.statusCode).toBe(400);
    expect(h.withTransaction).not.toHaveBeenCalled();
  });

  it('выдача: upsert, аудит «было → стало» в транзакции, оповещение всех учёток', async () => {
    const res = makeRes();
    await payrollAccessController.set(makeReq({ id: '42' }, { level: 'edit' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ level: 'edit' });
    expect(txSql().some(sql => sql.includes('INSERT INTO payroll_access_grants'))).toBe(true);

    expect(h.auditWithClient).toHaveBeenCalledTimes(1);
    const [client, , userId, action, options] = h.auditWithClient.mock.calls[0] as [
      unknown, unknown, string, string, { details: Record<string, unknown> },
    ];
    expect(client).toBe(h.txClient);
    expect(userId).toBe('admin-1');
    expect(action).toBe('PAYROLL_ACCESS_CHANGED');
    expect(options.details).toMatchObject({ employee_id: 42, from: null, to: 'edit' });

    expect(h.to).toHaveBeenCalledWith('user:profile-a');
    expect(h.to).toHaveBeenCalledWith('user:profile-b');
    expect(h.emit).toHaveBeenCalledWith('profile:access_changed');
  });

  it('снятие: DELETE и аудит edit → null', async () => {
    currentGrant('edit');
    const res = makeRes();
    await payrollAccessController.set(makeReq({ id: '42' }, { level: null }), res);

    expect(res.statusCode).toBe(200);
    expect(txSql().some(sql => sql.includes('DELETE FROM payroll_access_grants'))).toBe(true);
    const options = h.auditWithClient.mock.calls[0][4] as { details: Record<string, unknown> };
    expect(options.details).toMatchObject({ from: 'edit', to: null });
  });

  it('тот же уровень — без записи, аудита и оповещения', async () => {
    currentGrant('view');
    const res = makeRes();
    await payrollAccessController.set(makeReq({ id: '42' }, { level: 'view' }), res);

    expect(res.statusCode).toBe(200);
    expect(txSql().some(sql => sql.includes('INSERT') || sql.includes('DELETE'))).toBe(false);
    expect(h.auditWithClient).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('неизвестный сотрудник — 404 до записи', async () => {
    h.queryOne.mockResolvedValueOnce(null);
    const res = makeRes();
    await payrollAccessController.set(makeReq({ id: '999' }, { level: 'view' }), res);
    expect(res.statusCode).toBe(404);
    expect(h.withTransaction).not.toHaveBeenCalled();
  });
});

describe('гарды роутов', () => {
  const adminRoutes = readFileSync(path.resolve(__dirname, '..', 'routes', 'admin.routes.ts'), 'utf8');

  it.each(['get', 'put'])('%s /employees/:id/payroll-access — только системный администратор', (verb) => {
    expect(adminRoutes).toContain(`router.${verb}('/employees/:id/payroll-access', requireSystemAdmin,`);
  });
});
