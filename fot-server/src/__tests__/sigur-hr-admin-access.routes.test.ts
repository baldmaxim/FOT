import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * SIGUR для кадрового админа (ключ /sigur без технического /skud-settings и без
 * страницы «Пропуск» /skud-card-reader).
 *
 * Держим:
 *  - «Новая должность → Создать» из карточки — по /sigur edit; переименование должностей
 *    остаётся техническим (/skud-settings);
 *  - «Сканировать» в карточке: поиск владельца карты — по /sigur view, привязка — по /sigur;
 *  - глобальная привязка карты со страницы «Пропуск» (/cards/assign) — только /skud-card-reader.
 *
 * Роутер настоящий (гейты из routes/sigur.routes), контроллеры — заглушки со счётчиком вызовов.
 */

vi.mock('../config/postgres.js', () => ({
  queryOne: vi.fn().mockResolvedValue({ token_version: 0 }),
  query: vi.fn().mockResolvedValue([]),
  execute: vi.fn().mockResolvedValue(0),
  withTransaction: vi.fn(),
  getPool: vi.fn(),
  pool: vi.fn(),
}));

const h = vi.hoisted(() => {
  const calls: string[] = [];
  /** Любой метод контроллера — заглушка 200, фиксирующая вызов. */
  const stubController = (name: string) => new Proxy({}, {
    get: (_target, key) => (_req: unknown, res: { json: (body: unknown) => void }) => {
      calls.push(`${name}.${String(key)}`);
      res.json({ success: true, data: [] });
    },
  });
  return { calls, stubController, grants: new Set<string>() };
});

// Выданные роли ключи: 'page:view' / 'page:edit'; edit подразумевает view.
vi.mock('../services/access-control.service.js', async () => {
  const actual = await vi.importActual<typeof import('../services/access-control.service.js')>(
    '../services/access-control.service.js',
  );
  return {
    ...actual,
    resolveEffectivePageAccess: vi.fn(async (
      _req: unknown,
      page: string,
      action: 'view' | 'edit',
    ) => {
      if (h.grants.has(`${page}:edit`)) return true;
      return action === 'view' && h.grants.has(`${page}:view`);
    }),
  };
});

vi.mock('../controllers/sigur-admin.controller.js', () => ({ sigurAdminController: h.stubController('sigurAdmin') }));
vi.mock('../controllers/sigur-card-reader.controller.js', () => ({ sigurCardReaderController: h.stubController('sigurCardReader') }));
vi.mock('../services/skud-realtime.service.js', () => ({ notifySigurStructureChanged: vi.fn() }));

const sigurRoutes = (await import('../routes/sigur.routes.js')).default;

const app = express();
app.use(express.json());
app.use('/api/sigur', sigurRoutes);

const token = jwt.sign(
  {
    sub: 'hr-admin-user',
    email: 'hr@example.com',
    system_role_id: 'role-uuid',
    role_code: 'hr_admin',
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

type Method = 'get' | 'post' | 'put';

const send = (method: Method, url: string): request.Test =>
  (request(app) as unknown as Record<Method, (u: string) => request.Test>)[method](url)
    .set('Authorization', `Bearer ${token}`);

const d = process.env.CODEX_SANDBOX ? describe.skip : describe;

d('SIGUR: кадровый админ с ключом /sigur', () => {
  beforeEach(() => {
    h.calls.length = 0;
    h.grants.clear();
  });

  it('создаёт должность из карточки по /sigur edit; с одним просмотром — 403', async () => {
    h.grants.add('/sigur:view');
    expect((await send('post', '/api/sigur/admin/positions')).status).toBe(403);

    h.grants.add('/sigur:edit');
    expect((await send('post', '/api/sigur/admin/positions')).status).toBe(200);
    expect(h.calls).toEqual(['sigurAdmin.createPosition']);
  });

  it('переименование должности остаётся за /skud-settings', async () => {
    h.grants.add('/sigur:edit');
    expect((await send('put', '/api/sigur/admin/positions/5')).status).toBe(403);
    expect(h.calls).toEqual([]);
  });

  it('«Сканировать» в карточке: поиск владельца и привязка проходят по /sigur', async () => {
    h.grants.add('/sigur:edit');
    expect((await send('get', '/api/sigur/cards/lookup?uid=00AABBCCDDEEFF00')).status).toBe(200);
    expect((await send('post', '/api/sigur/admin/employees/42/cards/binding')).status).toBe(200);
    expect(h.calls).toEqual(['sigurCardReader.lookup', 'sigurAdmin.assignEmployeeCardBinding']);
  });

  it('привязка со страницы «Пропуск» (/cards/assign) — только /skud-card-reader', async () => {
    h.grants.add('/sigur:edit');
    expect((await send('post', '/api/sigur/cards/assign')).status).toBe(403);

    h.grants.add('/skud-card-reader:edit');
    expect((await send('post', '/api/sigur/cards/assign')).status).toBe(200);
    expect(h.calls).toEqual(['sigurCardReader.assign']);
  });

  it('без ключей поиск владельца карты закрыт', async () => {
    expect((await send('get', '/api/sigur/cards/lookup?uid=00AABBCCDDEEFF00')).status).toBe(403);
    expect(h.calls).toEqual([]);
  });
});
