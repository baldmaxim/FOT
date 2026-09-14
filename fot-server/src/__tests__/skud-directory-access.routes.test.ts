import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * Фактическая авторизация ключа /skud-settings/directory — просмотр вкладок
 * «Точки доступа», «Объекты», «База» раздела СКУД (роль «Отдел безопасности»,
 * «Кадровый админ» и др.).
 *
 * Держим:
 *  - с одним ключом — все GET трёх вкладок, включая карты и фолбэк точек;
 *  - без ключа — 403;
 *  - запись объектов/карт/настроек точек и скрытые вкладки (подключение, Discover,
 *    Preview, ошибочные события, лимит) — 403, контроллер не вызывается;
 *  - администратор — полный доступ.
 *
 * Роутеры настоящие (гейты из routes/*), контроллеры — заглушки со счётчиком вызовов.
 * `npm run audit:routes` проверяет лишь наличие защиты, но не её семантику.
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

// Выданные роли ключи: 'page:view' / 'page:edit'; edit подразумевает view; is_admin обходит матрицу.
vi.mock('../services/access-control.service.js', async () => {
  const actual = await vi.importActual<typeof import('../services/access-control.service.js')>(
    '../services/access-control.service.js',
  );
  return {
    ...actual,
    resolveEffectivePageAccess: vi.fn(async (
      req: { user: { is_admin?: boolean } },
      page: string,
      action: 'view' | 'edit',
    ) => {
      if (req.user.is_admin) return true;
      if (h.grants.has(`${page}:edit`)) return true;
      return action === 'view' && h.grants.has(`${page}:view`);
    }),
  };
});

vi.mock('../controllers/skud.controller.js', () => ({ skudController: h.stubController('skud') }));
vi.mock('../controllers/sigur.controller.js', () => ({ sigurController: h.stubController('sigur') }));
vi.mock('../controllers/sigur-monitor.controller.js', () => ({ sigurMonitorController: h.stubController('sigurMonitor') }));
vi.mock('../controllers/sigur-sync.controller.js', () => ({ sigurSyncController: h.stubController('sigurSync') }));
vi.mock('../controllers/sigur-admin.controller.js', () => ({ sigurAdminController: h.stubController('sigurAdmin') }));
vi.mock('../controllers/sigur-filter.controller.js', () => ({ sigurFilterController: h.stubController('sigurFilter') }));
vi.mock('../controllers/sigur-card-reader.controller.js', () => ({ sigurCardReaderController: h.stubController('sigurCardReader') }));
vi.mock('../services/skud-realtime.service.js', () => ({ notifySigurStructureChanged: vi.fn() }));

const skudRoutes = (await import('../routes/skud.routes.js')).default;
const sigurRoutes = (await import('../routes/sigur.routes.js')).default;

const app = express();
app.use(express.json());
app.use('/api/skud', skudRoutes);
app.use('/api/sigur', sigurRoutes);

const token = (isAdmin: boolean): string => jwt.sign(
  {
    sub: isAdmin ? 'admin-user' : 'security-user',
    email: 'user@example.com',
    system_role_id: 'role-uuid',
    role_code: isAdmin ? 'admin' : 'security',
    is_admin: isAdmin,
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

type Method = 'get' | 'post' | 'put' | 'delete';

const send = (method: Method, url: string, isAdmin = false): request.Test =>
  (request(app) as unknown as Record<Method, (u: string) => request.Test>)[method](url)
    .set('Authorization', `Bearer ${token(isAdmin)}`);

const DIRECTORY_READS: Array<[Method, string]> = [
  ['get', '/api/sigur/access-points'],
  ['get', '/api/skud/access-points'],
  ['get', '/api/skud/access-point-settings'],
  ['get', '/api/skud/travel-objects'],
  ['get', '/api/skud/travel-objects/obj-1/map'],
  ['get', '/api/skud/access-point-map?name=%D0%A2%D1%83%D1%80%D0%BD%D0%B8%D0%BA%D0%B5%D1%82'],
  ['get', '/api/skud/events'],
  ['get', '/api/skud/daily-summary'],
];

const WRITES: Array<[Method, string]> = [
  ['post', '/api/skud/travel-objects'],
  ['put', '/api/skud/travel-objects/obj-1'],
  ['delete', '/api/skud/travel-objects/obj-1'],
  ['post', '/api/skud/travel-objects/obj-1/map/upload-url'],
  ['post', '/api/skud/travel-objects/obj-1/map/confirm'],
  ['put', '/api/skud/travel-objects/obj-1/map-points'],
  ['delete', '/api/skud/travel-objects/obj-1/map'],
  ['put', '/api/skud/access-point-settings'],
  ['post', '/api/skud/sync-access-points'],
];

const HIDDEN_TABS: Array<[Method, string]> = [
  ['get', '/api/sigur/connection-settings'],
  ['get', '/api/sigur/discover'],
  ['get', '/api/sigur/preview'],
  ['get', '/api/skud/event-failures'],
  ['get', '/api/skud/travel-config'],
];

const d = process.env.CODEX_SANDBOX ? describe.skip : describe;

d('/skud-settings/directory — просмотр трёх вкладок СКУД', () => {
  beforeEach(() => {
    h.calls.length = 0;
    h.grants.clear();
  });

  it.each(DIRECTORY_READS)('только ключ просмотра: %s %s → 200', async (method, url) => {
    h.grants.add('/skud-settings/directory:view');
    const res = await send(method, url);
    expect(res.status).toBe(200);
    expect(h.calls).toHaveLength(1);
  });

  it.each(DIRECTORY_READS)('без ключа: %s %s → 403', async (method, url) => {
    const res = await send(method, url);
    expect(res.status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it.each([...WRITES, ...HIDDEN_TABS])('только ключ просмотра: %s %s → 403', async (method, url) => {
    h.grants.add('/skud-settings/directory:view');
    const res = await send(method, url);
    expect(res.status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it.each([...DIRECTORY_READS, ...WRITES, ...HIDDEN_TABS])('администратор: %s %s → 200', async (method, url) => {
    const res = await send(method, url, true);
    expect(res.status).toBe(200);
    expect(h.calls).toHaveLength(1);
  });
});
