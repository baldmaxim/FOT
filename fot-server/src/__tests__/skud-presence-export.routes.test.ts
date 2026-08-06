import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * Регресс: POST /presence-by-object/export — read-only. Он не должен попадать
 * в write-through invalidation роутера, иначе каждая выгрузка сбрасывала бы
 * кэши живого экрана присутствия.
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

const invalidateSpy = vi.hoisted(() => vi.fn());

vi.mock('../services/skud-presence-by-object.service.js', async () => {
  const actual = await vi.importActual<typeof import('../services/skud-presence-by-object.service.js')>(
    '../services/skud-presence-by-object.service.js',
  );
  return { ...actual, invalidatePresenceByObjectCache: invalidateSpy };
});

vi.mock('../services/skud-presence-export.service.js', async () => {
  const actual = await vi.importActual<typeof import('../services/skud-presence-export.service.js')>(
    '../services/skud-presence-export.service.js',
  );
  return {
    ...actual,
    collectPresenceExport: vi.fn(async () => [{
      date: '2026-08-04',
      objects: [{
        object_key: 'obj-1',
        object_name: 'ЖК Alia',
        total: 1,
        groups: [{
          key: 'local:dept-a',
          name: 'бр.Тоштемиров',
          company_name: 'СУ-10',
          employees: [{ entry_time: '07:19:00', full_name: 'Первый Сотрудник' }],
        }],
      }],
    }]),
  };
});

const app = (await import('../app.js')).default;

function makeToken(): string {
  return jwt.sign(
    {
      sub: 'test-user-id',
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

d('POST /api/skud/presence-by-object/export', () => {
  beforeEach(() => invalidateSpy.mockClear());

  it('401 без токена', async () => {
    const res = await request(app).post('/api/skud/presence-by-object/export');
    expect(res.status).toBe(401);
  });

  it('отдаёт xlsx и НЕ сбрасывает кэш присутствия', async () => {
    const res = await request(app)
      .post('/api/skud/presence-by-object/export')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ date_from: '2026-08-04', date_to: '2026-08-04' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
