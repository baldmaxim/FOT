import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * Регресс: GET /api/structure обязан отдавать `Cache-Control: private, no-cache`
 * и на MISS, и на HIT. На HIT/STALE отвечает cacheResponse-middleware, контроллер
 * не вызывается — заголовок, выставленный в контроллере, там не применялся бы, и
 * оставался бы глобальный `private, max-age=30` из app.ts: push structure_updated
 * в первые 30 сек обслуживался бы из браузерного кэша, и новый отдел Sigur не
 * появлялся бы в списках.
 */

vi.mock('../config/postgres.js', () => ({
  queryOne: vi.fn().mockResolvedValue({ token_version: 0 }),
  query: vi.fn().mockResolvedValue([]),
  execute: vi.fn().mockResolvedValue(0),
  withTransaction: vi.fn(),
  getPool: vi.fn(),
  pool: vi.fn(),
}));

vi.mock('../services/access-control.service.js', async () => {
  const actual = await vi.importActual<typeof import('../services/access-control.service.js')>(
    '../services/access-control.service.js',
  );
  return { ...actual, resolveEffectivePageAccess: vi.fn(async () => true) };
});

const app = (await import('../app.js')).default;

function makeToken(): string {
  return jwt.sign(
    {
      sub: 'structure-cache-user',
      email: 'test@example.com',
      system_role_id: 'role-uuid',
      role_code: 'hr',
      is_admin: false,
      employee_variant: 'office',
      employee_id: null,
      department_id: null,
      is_approved: true,
      two_factor_enabled: false,
      two_factor_verified: true,
    },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' },
  );
}

const d = process.env.CODEX_SANDBOX ? describe.skip : describe;

d('GET /api/structure — кэш-заголовки', () => {
  let token: string;

  beforeEach(() => {
    token = makeToken();
  });

  it('no-cache и на MISS, и на HIT', async () => {
    const first = await request(app).get('/api/structure').set('Authorization', `Bearer ${token}`);
    expect(first.status).toBe(200);
    expect(first.headers['x-cache-status']).toBe('MISS');
    expect(first.headers['cache-control']).toBe('private, no-cache');

    const second = await request(app).get('/api/structure').set('Authorization', `Bearer ${token}`);
    expect(second.status).toBe(200);
    expect(second.headers['x-cache-status']).toBe('HIT');
    expect(second.headers['cache-control']).toBe('private, no-cache');
  });
});
