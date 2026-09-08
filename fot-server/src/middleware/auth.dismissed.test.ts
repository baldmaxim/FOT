/**
 * Блокировка портала для уволенных.
 *
 * Инцидент: сотрудник уволен 31.08, но продолжал заходить и согласовывать заявления
 * подчинённых — статус сотрудника не проверялся ни в одной точке входа, а access-токен
 * живёт 7 дней. Проверка динамическая: увольнение ничего не стирает, восстановление
 * (employment_status → 'active') открывает доступ само, вместе со всеми данными.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextFunction, Response } from 'express';
import jwt from 'jsonwebtoken';

const h = vi.hoisted(() => ({ queryOne: vi.fn() }));

vi.mock('../config/postgres.js', () => ({ queryOne: h.queryOne }));
vi.mock('@sentry/node', () => ({
  getCurrentScope: () => ({ setUser: vi.fn(), setContext: vi.fn(), setTag: vi.fn() }),
  setUser: vi.fn(), setContext: vi.fn(), captureException: vi.fn(), captureMessage: vi.fn(),
}));

import { authenticate } from './auth.js';
import type { AuthenticatedRequest } from '../types/index.js';

const SECRET = process.env.JWT_SECRET || 'test-secret';

const makeToken = (over: Record<string, unknown> = {}) => jwt.sign({
  sub: '3098891c-3de1-4c20-a7a4-e07b52d9ec68',
  email: 'user@example.com',
  is_approved: true,
  token_version: 0,
  two_factor_enabled: false,
  two_factor_verified: true,
  ...over,
}, SECRET, { algorithm: 'HS256' });

const run = async (employmentStatus: string | null): Promise<{ status: number; body: Record<string, unknown>; passed: boolean }> => {
  h.queryOne.mockResolvedValue({ token_version: 0, employment_status: employmentStatus });
  let status = 200;
  let body: Record<string, unknown> = {};
  const res = {
    status: (s: number) => { status = s; return res; },
    json: (payload: Record<string, unknown>) => { body = payload; return res; },
  } as unknown as Response;
  let passed = false;
  const next: NextFunction = () => { passed = true; };
  const req = { headers: { authorization: `Bearer ${makeToken()}` } } as unknown as AuthenticatedRequest;

  await authenticate(req, res, next);
  return { status, body, passed };
};

beforeEach(() => h.queryOne.mockReset());

describe('authenticate: уволенный на портал не допускается', () => {
  it('fired → 403 EMPLOYEE_DISMISSED', async () => {
    const r = await run('fired');
    expect(r.passed).toBe(false);
    // 403, а не 401: токен валиден, обновлять его незачем — клиент повторяет только 401.
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('EMPLOYEE_DISMISSED');
  });

  it('active → проходит', async () => {
    const r = await run('active');
    expect(r.passed).toBe(true);
    expect(r.status).toBe(200);
  });

  it('профиль без карточки сотрудника → проходит (подрядчики и сервисные учётки)', async () => {
    const r = await run(null);
    expect(r.passed).toBe(true);
  });

  it('статус читается тем же запросом, что и token_version — лишнего похода в БД нет', async () => {
    await run('active');
    expect(h.queryOne).toHaveBeenCalledTimes(1);
    const [sql] = h.queryOne.mock.calls[0];
    expect(String(sql)).toContain('LEFT JOIN employees');
    expect(String(sql)).toContain('token_version');
  });
});
