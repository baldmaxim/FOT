import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * Регресс: GET-эндпоинты панели назначений сотрудника обязаны отдавать
 * `Cache-Control: no-store`. После «Сохранить» панель перечитывает их сразу, а
 * глобальный `private, max-age=30` из app.ts отдавал тело, снятое ДО сохранения:
 * добавленный подчинённый висел несохранённым, и его назначали по 2–4 раза.
 */

vi.mock('../config/postgres.js', () => ({
  queryOne: vi.fn(async (sql: string) => {
    if (sql.includes('token_version')) return { token_version: 0 };
    if (sql.includes('FROM employees WHERE id')) return { id: 1532 };
    return null;
  }),
  query: vi.fn().mockResolvedValue([]),
  execute: vi.fn().mockResolvedValue(0),
  withTransaction: vi.fn(async (fn: (client: { query: () => Promise<unknown> }) => Promise<unknown>) =>
    fn({ query: async () => ({ rows: [] }) }),
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

const token = jwt.sign(
  {
    sub: 'assignment-panel-cache-user',
    email: 'test@example.com',
    system_role_id: 'role-uuid',
    role_code: 'admin',
    is_admin: true,
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

const d = process.env.CODEX_SANDBOX ? describe.skip : describe;

d('панель назначений — кэш-заголовки GET', () => {
  it.each([
    '/api/direct-reports?manager_employee_id=1532',
    '/api/admin/employees/department-access',
    '/api/admin/employees/1532/skud-objects',
    '/api/admin/weekend-approvals/1532',
    '/api/admin/weekend-approvals/eligible',
  ])('%s → no-store', async (url) => {
    const res = await request(app).get(url).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
