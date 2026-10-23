import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * Регресс: GET /api/hiring-requests* обязан отдавать `Cache-Control: no-store`.
 * Иначе глобальный `private, max-age=30` из app.ts заставлял браузер 30 с отдавать
 * окно заявки, снятое ДО правки: назначенный рекрутер не появлялся («Не назначены»),
 * его добавляли повторно — и он терял «главного» (заявки 86 и 161, 22–23.10.2026).
 */

vi.mock('../config/postgres.js', () => ({
  queryOne: vi.fn(async (sql: string) => {
    if (sql.includes('token_version')) return { token_version: 0 };
    if (sql.includes('FROM hiring_requests')) return { id: 161, stage: 'new', author_employee_id: null, department_id: null };
    return null;
  }),
  query: vi.fn().mockResolvedValue([]),
  execute: vi.fn().mockResolvedValue(0),
  withTransaction: vi.fn(async (fn: (client: { query: () => Promise<unknown> }) => Promise<unknown>) =>
    fn({ query: async () => ({ rows: [], rowCount: 0 }) }),
  ),
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
      sub: 'hiring-cache-user',
      email: 'test@example.com',
      system_role_id: 'role-uuid',
      role_code: 'admin',
      is_admin: true,
      employee_variant: 'object',
      employee_id: 10,
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

d('/api/hiring-requests — кэш-заголовки', () => {
  let token: string;

  beforeEach(() => {
    token = makeToken();
  });

  it.each([
    '/api/hiring-requests',
    '/api/hiring-requests/161',
    '/api/hiring-requests/recruiters',
  ])('GET %s → no-store', async (path) => {
    const res = await request(app).get(path).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
