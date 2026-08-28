import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * Регресс: GET /api/sigur/admin/* обязан отдавать `Cache-Control: private, no-cache`
 * и на MISS, и на HIT. Иначе глобальный `private, max-age=30` из app.ts заставлял
 * браузер 30 с отдавать старое дерево отделов после переименования — имя «не
 * менялось», и его сохраняли по 3–4 раза подряд. Мутации при этом должны сохранять
 * глобальный `no-store`.
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

vi.mock('../services/sigur-live-admin.service.js', async () => {
  const actual = await vi.importActual<typeof import('../services/sigur-live-admin.service.js')>(
    '../services/sigur-live-admin.service.js',
  );
  return {
    ...actual,
    listSigurDepartmentsTree: vi.fn(async () => []),
    listOrgDepartmentsAsSigurTree: vi.fn(async () => []),
  };
});

vi.mock('../services/sigur-live-departments-crud.service.js', async () => {
  const actual = await vi.importActual<typeof import('../services/sigur-live-departments-crud.service.js')>(
    '../services/sigur-live-departments-crud.service.js',
  );
  return {
    ...actual,
    updateSigurDepartment: vi.fn(async () => ({
      id: 1, parentId: null, name: 'бр.Тест', hasChildren: false, employeeCount: 0, children: [],
    })),
  };
});

vi.mock('../services/skud-realtime.service.js', () => ({
  notifySigurStructureChanged: vi.fn(),
}));

vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: vi.fn(async () => undefined) },
}));

const app = (await import('../app.js')).default;

function makeToken(): string {
  return jwt.sign(
    {
      sub: 'sigur-admin-cache-user',
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
}

const d = process.env.CODEX_SANDBOX ? describe.skip : describe;

d('GET /api/sigur/admin/* — кэш-заголовки', () => {
  let token: string;

  beforeEach(() => {
    token = makeToken();
  });

  it('дерево отделов: no-cache и на MISS, и на HIT', async () => {
    const url = '/api/sigur/admin/departments/tree?source=sigur';
    const first = await request(app).get(url).set('Authorization', `Bearer ${token}`);
    expect(first.status).toBe(200);
    expect(first.headers['x-cache-status']).toBe('MISS');
    expect(first.headers['cache-control']).toBe('private, no-cache');

    const second = await request(app).get(url).set('Authorization', `Bearer ${token}`);
    expect(second.status).toBe(200);
    expect(second.headers['x-cache-status']).toBe('HIT');
    expect(second.headers['cache-control']).toBe('private, no-cache');
  });

  it('мутация отдела сохраняет глобальный no-store', async () => {
    const res = await request(app)
      .put('/api/sigur/admin/departments/1')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'бр.Тест' });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
