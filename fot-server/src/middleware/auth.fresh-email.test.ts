/**
 * Почта в сессии — из app_auth.users, а не из токена.
 *
 * Админ может сменить почту для входа, сессии при этом не рвутся, а access-токен
 * живёт 7 дней, refresh — 30. Без сверки с БД старый адрес жил бы в req.user.email
 * (allowlist тестирования, /auth/me, 2FA) и в каждом продлённом токене.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextFunction, Response } from 'express';
import jwt from 'jsonwebtoken';

const h = vi.hoisted(() => ({ queryOne: vi.fn(), getEmailByUserId: vi.fn() }));

vi.mock('../config/postgres.js', () => ({ queryOne: h.queryOne }));
vi.mock('../services/local-auth.service.js', () => ({
  localAuthService: { getEmailByUserId: h.getEmailByUserId },
}));
vi.mock('@sentry/node', () => ({
  getCurrentScope: () => ({ setUser: vi.fn(), setContext: vi.fn(), setTag: vi.fn() }),
  setUser: vi.fn(), setContext: vi.fn(), captureException: vi.fn(), captureMessage: vi.fn(),
}));

import { authenticate } from './auth.js';
import { generateRefreshToken, resolveSessionEmail } from '../utils/auth-session.js';
import type { AuthenticatedRequest } from '../types/index.js';

const SECRET = process.env.JWT_SECRET || 'test-secret';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || 'test-secret';
const USER_ID = '3098891c-3de1-4c20-a7a4-e07b52d9ec68';

const makeToken = () => jwt.sign({
  sub: USER_ID,
  email: 'old@su10.ru',
  is_approved: true,
  token_version: 0,
  two_factor_enabled: false,
  two_factor_verified: true,
}, SECRET, { algorithm: 'HS256' });

const authenticateWith = async (dbEmail: string | null): Promise<AuthenticatedRequest> => {
  h.queryOne.mockResolvedValue({ token_version: 0, employment_status: 'active', email: dbEmail });
  const res = { status: () => res, json: () => res } as unknown as Response;
  const req = { headers: { authorization: `Bearer ${makeToken()}` } } as unknown as AuthenticatedRequest;
  let passed = false;
  const next: NextFunction = () => { passed = true; };
  await authenticate(req, res, next);
  expect(passed).toBe(true);
  return req;
};

beforeEach(() => {
  h.queryOne.mockReset();
  h.getEmailByUserId.mockReset();
});

describe('authenticate: req.user.email', () => {
  it('почта сменена админом → в запросе новая, хотя в токене старая', async () => {
    const req = await authenticateWith('new@su10.ru');
    expect(req.user.email).toBe('new@su10.ru');
    expect(String(h.queryOne.mock.calls[0][0])).toContain('LEFT JOIN app_auth.users au');
  });

  it('строки в app_auth.users нет → почта из токена', async () => {
    const req = await authenticateWith(null);
    expect(req.user.email).toBe('old@su10.ru');
  });
});

describe('/auth/refresh: почта для новых токенов', () => {
  it('refresh-токен со старой почтой выпускает токены с новой', async () => {
    h.getEmailByUserId.mockResolvedValue('new@su10.ru');
    const oldRefresh = generateRefreshToken(USER_ID, 'old@su10.ru', 0);
    const decoded = jwt.verify(oldRefresh, REFRESH_SECRET) as { sub: string; email: string };

    const email = await resolveSessionEmail(decoded.sub, decoded.email);
    const nextRefresh = jwt.verify(generateRefreshToken(decoded.sub, email, 0), REFRESH_SECRET) as { email: string };

    expect(h.getEmailByUserId).toHaveBeenCalledWith(USER_ID);
    expect(nextRefresh.email).toBe('new@su10.ru');
  });

  it('учётки в app_auth.users нет → почта из токена', async () => {
    h.getEmailByUserId.mockResolvedValue(null);
    expect(await resolveSessionEmail(USER_ID, 'old@su10.ru')).toBe('old@su10.ru');
  });
});
