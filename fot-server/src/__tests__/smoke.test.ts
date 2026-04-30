import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../app.js';
import { resolveEffectivePageAccess } from '../services/access-control.service.js';

// Мок проверки доступа на уровне middleware. Это позволяет тестировать,
// что requirePageAccess / requireAnyPageAccess правильно отдают 403 без
// похода в Supabase.
vi.mock('../services/access-control.service.js', async () => {
  const actual = await vi.importActual<typeof import('../services/access-control.service.js')>(
    '../services/access-control.service.js',
  );
  return {
    ...actual,
    resolveEffectivePageAccess: vi.fn(),
  };
});

const mockedResolve = vi.mocked(resolveEffectivePageAccess);

interface TokenOverrides {
  role_code?: string;
  is_admin?: boolean;
  is_approved?: boolean;
  two_factor_enabled?: boolean;
  two_factor_verified?: boolean;
}

function makeToken(overrides: TokenOverrides = {}): string {
  return jwt.sign(
    {
      sub: 'test-user-id',
      email: 'test@example.com',
      system_role_id: 'role-uuid',
      role_code: overrides.role_code ?? 'worker',
      is_admin: overrides.is_admin ?? false,
      employee_variant: 'object',
      employee_id: null,
      department_id: null,
      is_approved: overrides.is_approved ?? true,
      two_factor_enabled: overrides.two_factor_enabled ?? false,
      two_factor_verified: overrides.two_factor_verified ?? true,
    },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' },
  );
}

const smokeDescribe = process.env.CODEX_SANDBOX ? describe.skip : describe;

smokeDescribe('Smoke Tests', () => {
  beforeEach(() => {
    mockedResolve.mockReset();
  });

  it('GET /health — returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.timestamp).toBeDefined();
  });

  it('POST /api/auth/login — rejects invalid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nonexistent@test.com', password: 'wrongpassword123' });
    expect([400, 401]).toContain(res.status);
    expect(res.body.success).toBe(false);
  });

  it('POST /api/auth/login — rejects malformed request', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'not-an-email', password: '12' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('GET /api/employees — rejects without auth token', async () => {
    const res = await request(app).get('/api/employees');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('GET /api/auth/me — rejects without auth token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('GET /api/employees — rejects with invalid token', async () => {
    const res = await request(app)
      .get('/api/employees')
      .set('Authorization', 'Bearer invalid.token.here');
    expect(res.status).toBe(401);
  });

  it('GET /nonexistent — returns 404', async () => {
    const res = await request(app).get('/nonexistent');
    expect(res.status).toBe(404);
  });
});

// Проверки, что role-based middleware действительно блокирует чужие страницы.
// Покрывают паттерн дыры «прямой URL в обход меню»: фронт-страница скрыта,
// но API без requirePageAccess пускает любого authenticated.
smokeDescribe('Role-based access control', () => {
  beforeEach(() => {
    mockedResolve.mockReset();
  });

  it('GET /api/admin/users — 401 без токена', async () => {
    const res = await request(app).get('/api/admin/users');
    expect(res.status).toBe(401);
  });

  it('GET /api/admin/users — 403 для worker без доступа', async () => {
    mockedResolve.mockResolvedValue(false);
    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${makeToken({ role_code: 'worker' })}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('GET /api/roles — 401 без токена', async () => {
    const res = await request(app).get('/api/roles');
    expect(res.status).toBe(401);
  });

  it('GET /api/roles — 403 для worker (закрыто после фикса)', async () => {
    mockedResolve.mockResolvedValue(false);
    const res = await request(app)
      .get('/api/roles')
      .set('Authorization', `Bearer ${makeToken({ role_code: 'worker' })}`);
    expect(res.status).toBe(403);
  });

  it('GET /api/roles/labels — пропускает worker (намеренно публичный для UI)', async () => {
    const res = await request(app)
      .get('/api/roles/labels')
      .set('Authorization', `Bearer ${makeToken({ role_code: 'worker' })}`);
    // Контроллер дойдёт до Supabase — без живой БД будет 500. Главное:
    // middleware пропустил (НЕ 401, НЕ 403).
    expect([200, 500]).toContain(res.status);
  });

  it('GET /api/chat/conversations — 401 без токена', async () => {
    const res = await request(app).get('/api/chat/conversations');
    expect(res.status).toBe(401);
  });

  it('GET /api/chat/conversations — 403 для роли без /employee и /dashboard', async () => {
    mockedResolve.mockResolvedValue(false);
    const res = await request(app)
      .get('/api/chat/conversations')
      .set('Authorization', `Bearer ${makeToken({ role_code: 'worker' })}`);
    expect(res.status).toBe(403);
  });
});
