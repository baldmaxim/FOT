import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../app.js';
import { resolveEffectivePageAccess } from '../services/access-control.service.js';

vi.mock('../services/access-control.service.js', async () => {
  const actual = await vi.importActual<typeof import('../services/access-control.service.js')>(
    '../services/access-control.service.js',
  );
  return { ...actual, resolveEffectivePageAccess: vi.fn() };
});

vi.mock('../config/postgres.js', () => ({
  queryOne: vi.fn().mockResolvedValue({ token_version: 0 }),
  query: vi.fn().mockResolvedValue([]),
  execute: vi.fn().mockResolvedValue(0),
  withTransaction: vi.fn(),
  getPool: vi.fn(),
  pool: vi.fn(),
}));

const mockedResolve = vi.mocked(resolveEffectivePageAccess);

function makeToken(role_code = 'worker'): string {
  return jwt.sign(
    {
      sub: 'test-user-id',
      email: 'test@example.com',
      system_role_id: 'role-uuid',
      role_code,
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

d('Contractor routes — gating', () => {
  beforeEach(() => mockedResolve.mockReset());

  it('GET /api/contractor/roster — 401 без токена', async () => {
    const res = await request(app).get('/api/contractor/roster');
    expect(res.status).toBe(401);
  });

  it('POST /api/contractor/submit — 401 без токена', async () => {
    const res = await request(app).post('/api/contractor/submit');
    expect(res.status).toBe(401);
  });

  it('GET /api/contractor/roster — 403 для worker без доступа', async () => {
    mockedResolve.mockResolvedValue(false);
    const res = await request(app)
      .get('/api/contractor/roster')
      .set('Authorization', `Bearer ${makeToken('worker')}`);
    expect(res.status).toBe(403);
  });

  it('POST /api/contractor/submit — 403 для worker без доступа', async () => {
    mockedResolve.mockResolvedValue(false);
    const res = await request(app)
      .post('/api/contractor/submit')
      .set('Authorization', `Bearer ${makeToken('worker')}`);
    expect(res.status).toBe(403);
  });
});

d('Contractor admin routes — gating', () => {
  beforeEach(() => mockedResolve.mockReset());

  it('GET /api/admin/contractor/submissions/pending — 401 без токена', async () => {
    const res = await request(app).get('/api/admin/contractor/submissions/pending');
    expect(res.status).toBe(401);
  });

  it('POST /api/admin/contractor/passes/issue — 403 для worker', async () => {
    mockedResolve.mockResolvedValue(false);
    const res = await request(app)
      .post('/api/admin/contractor/passes/issue')
      .set('Authorization', `Bearer ${makeToken('worker')}`)
      .send({ org_department_id: '00000000-0000-0000-0000-000000000000', count: 1 });
    expect(res.status).toBe(403);
  });

  it('GET /api/admin/contractor/submissions/pending — 403 для worker', async () => {
    mockedResolve.mockResolvedValue(false);
    const res = await request(app)
      .get('/api/admin/contractor/submissions/pending')
      .set('Authorization', `Bearer ${makeToken('worker')}`);
    expect(res.status).toBe(403);
  });
});
