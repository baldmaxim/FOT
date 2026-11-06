import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * Регресс: GET /api/auth/me обязан отдавать `Cache-Control: no-store`. По сокет-событию profile:access_changed фронт
 * пересняет профиль, и ответ из глобального `private, max-age=30` (app.ts) вернул бы прежние права: галочка
 * «Проживание»/«Удержания» (миграция 351), выданная или снятая в назначениях, не применялась бы до перезахода.
 */

vi.mock('../config/postgres.js', () => ({
  queryOne: vi.fn(async (sql: string) => (String(sql).includes('token_version') ? { token_version: 0 } : null)),
  query: vi.fn().mockResolvedValue([]),
  execute: vi.fn().mockResolvedValue(0),
  withTransaction: vi.fn(),
  getPool: vi.fn(),
  pool: vi.fn(),
}));

vi.mock('../controllers/auth.controller.js', () => ({
  authController: new Proxy({}, {
    get: () => (_req: unknown, res: { json: (body: unknown) => void }) => res.json({ success: true }),
  }),
}));

const app = (await import('../app.js')).default;

const token = jwt.sign(
  {
    sub: 'auth-me-cache-user',
    email: 'test@example.com',
    system_role_id: 'role-uuid',
    role_code: 'office',
    is_admin: false,
    employee_variant: 'office',
    employee_id: 2520,
    department_id: null,
    is_approved: true,
    two_factor_enabled: false,
    two_factor_verified: true,
  },
  process.env.JWT_SECRET!,
  { expiresIn: '1h' },
);

const d = process.env.CODEX_SANDBOX ? describe.skip : describe;

d('/api/auth/me — кэш-заголовки', () => {
  it('GET /me → no-store', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
