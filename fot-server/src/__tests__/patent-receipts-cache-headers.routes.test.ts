import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * Регресс: GET /api/patent-receipts* обязан отдавать `Cache-Control: no-store`.
 * Иначе глобальный `private, max-age=30` из app.ts заставлял браузер 30 с отдавать
 * список, снятый ДО мутации: удалённый чек возвращался в таблицу, и админ смотрел
 * (и удалял) один и тот же чек по три раза. Мутации сохраняют `no-store` как раньше.
 */

vi.mock('../config/postgres.js', () => ({
  queryOne: vi.fn(async (sql: string) => {
    if (sql.includes('token_version')) return { token_version: 0 };
    if (sql.includes('FROM documents')) return { id: 1, r2_key: null, category: 'patent_check' };
    if (sql.includes('FROM patent_payment_receipts')) return { employee_id: 672 };
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

vi.mock('../services/r2.service.js', async () => {
  const actual = await vi.importActual<typeof import('../services/r2.service.js')>(
    '../services/r2.service.js',
  );
  return {
    ...actual,
    r2Service: {
      ...actual.r2Service,
      isEnabledAsync: vi.fn(async () => true),
      generateDownloadUrl: vi.fn(async () => 'https://r2.example/signed'),
      deleteObject: vi.fn(async () => undefined),
    },
  };
});

vi.mock('../services/recipients.service.js', () => ({
  getEmployeeUserId: vi.fn(async () => null),
}));

vi.mock('../services/realtime-broadcast.service.js', () => ({
  emitDomainChange: vi.fn(),
}));

const app = (await import('../app.js')).default;

function makeToken(employeeId: number | null): string {
  return jwt.sign(
    {
      sub: 'patent-receipts-cache-user',
      email: 'test@example.com',
      system_role_id: 'role-uuid',
      role_code: 'admin',
      is_admin: true,
      employee_variant: 'object',
      employee_id: employeeId,
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

d('/api/patent-receipts — кэш-заголовки', () => {
  let token: string;

  beforeEach(() => {
    token = makeToken(672);
  });

  it('ЛК рабочего: GET /my → no-store', async () => {
    const res = await request(app).get('/api/patent-receipts/my').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('админский список: GET / → no-store', async () => {
    const res = await request(app).get('/api/patent-receipts').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('удаление чека сохраняет no-store', async () => {
    const res = await request(app)
      .delete('/api/patent-receipts/by-document/1')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
