import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * Гейты точечных прав на чтение:
 *  - «Сотрудники на объектах — все объекты» (/skud-presence/all-objects);
 *  - «Обзор — все отделы» (/dashboard/all-departments).
 *
 * Держим:
 *  - новые эндпоинты «Обзора» закрыты без базового /dashboard, даже при наличии права;
 *  - права ничего не открывают на гейтах записи (табель, документы, заявления,
 *    объекты СКУД сотруднику) — результат роли security с правами и без одинаков;
 *  - «Звонки» гейтятся как раньше;
 *  - сохранение профиля роли сбрасывает кеши экранов (без старого скоупа из кеша).
 * Роутеры настоящие, контроллеры — заглушки со счётчиком вызовов.
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
  const stubController = (name: string) => new Proxy({}, {
    get: (_target, key) => (_req: unknown, res: { json: (body: unknown) => void }) => {
      calls.push(`${name}.${String(key)}`);
      res.json({ success: true, data: [] });
    },
  });
  return { calls, stubController, grants: new Set<string>(), invalidated: [] as string[] };
});

vi.mock('../services/access-control.service.js', async () => {
  const actual = await vi.importActual<typeof import('../services/access-control.service.js')>(
    '../services/access-control.service.js',
  );
  return {
    ...actual,
    resolveEffectivePageAccess: vi.fn(async (_req: unknown, page: string, action: 'view' | 'edit') =>
      h.grants.has(`${page}:edit`) || (action === 'view' && h.grants.has(`${page}:view`))),
  };
});

vi.mock('../middleware/cacheResponse.js', async () => {
  const actual = await vi.importActual<typeof import('../middleware/cacheResponse.js')>(
    '../middleware/cacheResponse.js',
  );
  return {
    ...actual,
    invalidateCaches: vi.fn((...names: string[]) => {
      h.invalidated.push(...names);
      actual.invalidateCaches(...names);
    }),
  };
});

vi.mock('../controllers/skud.controller.js', () => ({ skudController: h.stubController('skud') }));
vi.mock('../controllers/structure.controller.js', () => ({ structureController: h.stubController('structure') }));
vi.mock('../controllers/dashboard-mts.controller.js', () => ({ dashboardMtsController: h.stubController('dashboardMts') }));
vi.mock('../controllers/roles.controller.js', () => ({ rolesController: h.stubController('roles') }));
vi.mock('../controllers/timesheet.controller.js', () => ({ timesheetController: h.stubController('timesheet') }));
vi.mock('../controllers/timesheet-team-management.controller.js', () => ({ timesheetTeamManagementController: h.stubController('tm') }));
vi.mock('../controllers/timesheet-mass-export.controller.js', () => ({ exportTimesheetObjectsUnified: vi.fn() }));
vi.mock('../controllers/correction-attachments.controller.js', () => ({ correctionAttachmentsController: h.stubController('attachments') }));
vi.mock('../controllers/documents.controller.js', () => ({ documentsController: h.stubController('documents') }));
vi.mock('../controllers/leave-requests.controller.js', () => ({ leaveRequestsController: h.stubController('leave') }));
vi.mock('../controllers/admin.controller.js', () => ({ adminController: h.stubController('admin') }));
vi.mock('../controllers/admin-system-resources.controller.js', () => ({ adminSystemResourcesController: h.stubController('sysres') }));
vi.mock('../controllers/timesheet-mode.controller.js', () => ({ timesheetModeController: h.stubController('tsmode') }));

const app = express();
app.use(express.json());
app.use('/api/skud', (await import('../routes/skud.routes.js')).default);
app.use('/api/structure', (await import('../routes/structure.routes.js')).default);
app.use('/api/dashboard', (await import('../routes/dashboard.routes.js')).default);
app.use('/api/roles', (await import('../routes/roles.routes.js')).default);
app.use('/api/timesheet', (await import('../routes/timesheet.routes.js')).default);
app.use('/api/documents', (await import('../routes/documents.routes.js')).default);
app.use('/api/leave-requests', (await import('../routes/leave-requests.routes.js')).default);
app.use('/api/admin', (await import('../routes/admin.routes.js')).default);

const token = jwt.sign(
  {
    sub: 'security-user',
    email: 'security@example.com',
    system_role_id: 'role-uuid',
    role_code: 'security',
    is_admin: false,
    employee_variant: 'office',
    employee_id: 441,
    department_id: null,
    is_approved: true,
    two_factor_enabled: false,
    two_factor_verified: true,
  },
  process.env.JWT_SECRET!,
  { expiresIn: '1h' },
);

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
const send = (method: Method, url: string): request.Test =>
  (request(app) as unknown as Record<Method, (u: string) => request.Test>)[method](url)
    .set('Authorization', `Bearer ${token}`);

/** Матрица роли security на проде (без новых прав), 15.09.2026. */
const SECURITY_BASE = [
  '/admin/contractor-approvals:edit', '/admin/users:edit', '/admin/users/accounts:edit', '/dashboard:view',
  '/employee:view', '/employee/documents:edit', '/employee/phonebook:view', '/employee/requests:edit',
  '/employee/sim:edit', '/employee/tasks:edit', '/employees:view', '/leave-requests:edit', '/sigur:edit',
  '/sigur/access-points:edit', '/skud-card-reader:edit', '/skud-presence:view', '/skud-settings/directory:view',
  '/staff-control:view', '/staff-control/hiring:view', '/timesheet:view', '/timesheet/events:view',
];
const NEW_GRANTS = ['/skud-presence/all-objects:view', '/dashboard/all-departments:view'];

const d = process.env.CODEX_SANDBOX ? describe.skip : describe;

d('точечные права на чтение — гейты', () => {
  beforeEach(() => {
    h.calls.length = 0;
    h.invalidated.length = 0;
    h.grants.clear();
  });

  it.each([
    ['get', '/api/skud/dashboard/presence?department_id=d1'],
    ['get', '/api/structure/dashboard-tree'],
  ] as Array<[Method, string]>)('%s %s: без базового /dashboard → 403 даже с правом', async (method, url) => {
    NEW_GRANTS.forEach(grant => h.grants.add(grant));
    const res = await send(method, url);
    expect(res.status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it.each([
    ['get', '/api/skud/dashboard/presence?department_id=d1'],
    ['get', '/api/structure/dashboard-tree'],
  ] as Array<[Method, string]>)('%s %s: с базовым /dashboard → доходит до контроллера', async (method, url) => {
    h.grants.add('/dashboard:view');
    const res = await send(method, url);
    expect(res.status).toBe(200);
    expect(h.calls).toHaveLength(1);
  });

  it('«Сотрудники на объектах» без базового /skud-presence → 403 даже с правом', async () => {
    NEW_GRANTS.forEach(grant => h.grants.add(grant));
    const res = await send('get', '/api/skud/presence-by-object');
    expect(res.status).toBe(403);
  });

  const WRITES: Array<[Method, string]> = [
    ['post', '/api/timesheet'],
    ['put', '/api/timesheet/object-entry'],
    ['delete', '/api/timesheet/1'],
    ['post', '/api/documents/upload'],
    ['patch', '/api/leave-requests/1/approve'],
    ['patch', '/api/leave-requests/1/hr-acknowledge'],
    ['put', '/api/admin/employees/1/skud-objects'],
    ['put', '/api/admin/users/1/department-access'],
    ['get', '/api/dashboard/mts-usage?department_id=d1'],
  ];

  it.each(WRITES)('%s %s: права на чтение не меняют результат гейта', async (method, url) => {
    SECURITY_BASE.forEach(grant => h.grants.add(grant));
    const before = (await send(method, url)).status;
    const callsBefore = h.calls.length;

    NEW_GRANTS.forEach(grant => h.grants.add(grant));
    const after = (await send(method, url)).status;
    const callsAfter = h.calls.length - callsBefore;

    expect(after).toBe(before);
    // GET «Звонков» кешируется per-user: повтор отвечает из кеша, контроллер не вызывается.
    if (method !== 'get') expect(callsAfter).toBe(callsBefore);
  });

  /**
   * Вкладка «Система» → «Бригады» объявлена ключом /admin/users, а состав бригады
   * висел на /admin/users/access и /staff-control/direct-reports — у security их нет,
   * вкладка открывалась с «Не удалось загрузить». npm run audit:routes видит лишь
   * наличие middleware, поэтому набор ключей держим здесь.
   */
  describe('вкладка «Бригады»: гейт состава', () => {
    const URL = '/api/admin/departments/d1/assigned-employees';

    it('только /admin/users:view → доходит до контроллера', async () => {
      h.grants.add('/admin/users:view');
      const res = await send('get', URL);
      expect(res.status).toBe(200);
      expect(h.calls).toContain('admin.getDepartmentAssignedEmployees');
    });

    it('без всех трёх ключей → 403, контроллер не вызван', async () => {
      const res = await send('get', URL);
      expect(res.status).toBe(403);
      expect(h.calls).toHaveLength(0);
    });

    it('правка назначений по-прежнему закрыта: /admin/users:view не открывает запись', async () => {
      h.grants.add('/admin/users:view');
      const res = await send('put', '/api/admin/employees/1/department-access');
      expect(res.status).toBe(403);
      expect(h.calls).toHaveLength(0);
    });
  });

  it('сохранение профиля роли сбрасывает кеши экранов с точечными правами', async () => {
    h.grants.add('/admin/roles:edit');
    const res = await send('put', '/api/roles/security/access-profile');
    expect(res.status).toBe(200);
    expect(h.invalidated).toEqual(expect.arrayContaining([
      'skud-presence-by-object', 'skud-dashboard-presence', 'skud-dashboard', 'structure:dashboard-tree',
    ]));
  });
});
