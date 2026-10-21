import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * «Удержания» кадров (миграция 318): право /staff-control/deductions. Проверка прав НАСТОЯЩАЯ
 * (resolveEffectivePageAccess) и роутер настоящий, контроллер — заглушка со счётчиком вызовов.
 * «Просмотр» — список, выгрузка и виды; добавление, правка, удаление, поиск и правка видов — только с «Редактированием».
 */

const h = vi.hoisted(() => {
  const calls: string[] = [];
  const stubController = (name: string) => new Proxy({}, {
    get: (_target, key) => (_req: unknown, res: { json: (body: unknown) => void }) => {
      calls.push(`${name}.${String(key)}`);
      res.json({ success: true, data: [] });
    },
  });
  // Матрица «Роли»: hr — просмотр, hr_admin — правка; у dorm — только «Проживание», у office строки нет.
  const rolePageAccess = [
    { role_code: 'hr', page_path: '/staff-control/deductions', can_view: true, can_edit: false },
    { role_code: 'hr_admin', page_path: '/staff-control/deductions', can_view: true, can_edit: true },
    // Право «Проживания» вкладку «Удержания» не открывает.
    { role_code: 'dorm', page_path: '/staff-control/dormitory', can_view: true, can_edit: true },
  ];
  return { calls, stubController, rolePageAccess };
});

vi.mock('../config/postgres.js', () => ({
  queryOne: vi.fn().mockResolvedValue({ token_version: 0 }),
  query: vi.fn(async (sql: string) => (String(sql).includes('FROM role_page_access') ? h.rolePageAccess : [])),
  execute: vi.fn().mockResolvedValue(0),
  withTransaction: vi.fn(),
  getPool: vi.fn(),
  pool: vi.fn(),
}));

vi.mock('../services/roles-cache.service.js', () => ({
  getRoleByCode: vi.fn(async (code: string) => ({
    id: `role-${code}`, code, is_admin: code === 'admin', admin_access: code !== 'office', manager_auto_access: false, is_active: true,
  })),
  getRoleById: vi.fn(async () => null),
  invalidateRolesCache: vi.fn(),
}));
vi.mock('../services/data-scope.service.js', () => ({
  resolveAccessibleDepartmentIds: vi.fn(async () => [] as string[]),
  hasAllDepartmentsScope: vi.fn(async () => false),
  hasDeputyAssignment: vi.fn(async () => false),
}));
vi.mock('../services/hiring-access.service.js', () => ({
  hasHiringAutoAccess: vi.fn(async () => false),
  isHiringRequesterRole: vi.fn(() => false),
}));
vi.mock('../services/object-kpi-roles-cache.service.js', () => ({ isEconomicsHead: vi.fn(async () => false) }));

vi.mock('../controllers/staff-deductions.controller.js', () => ({ staffDeductionsController: h.stubController('deductions') }));

const app = express();
app.use(express.json());
app.use('/api/staff-deductions', (await import('../routes/staff-deductions.routes.js')).default);

const { invalidateRolePageAccessCache } = await import('../services/access-control.service.js');

const tokenFor = (roleCode: string): string => jwt.sign(
  {
    sub: `user-${roleCode}`,
    email: `${roleCode}@example.com`,
    system_role_id: 'role-uuid',
    role_code: roleCode,
    is_admin: roleCode === 'admin',
    employee_variant: 'office',
    employee_id: 577,
    department_id: null,
    is_approved: true,
    two_factor_enabled: false,
    two_factor_verified: true,
  },
  process.env.JWT_SECRET!,
  { expiresIn: '1h' },
);

const send = (method: 'get' | 'post' | 'patch' | 'delete', url: string, roleCode: string): request.Test =>
  request(app)[method](url).set('Authorization', `Bearer ${tokenFor(roleCode)}`).send({});

const READS: Array<['get' | 'post', string]> = [
  ['get', '/api/staff-deductions'],
  ['post', '/api/staff-deductions/export'],
  ['get', '/api/staff-deductions/kinds'],
];
const WRITES: Array<['get' | 'post' | 'patch' | 'delete', string]> = [
  ['get', '/api/staff-deductions/employees/search?q=Кар'],
  ['post', '/api/staff-deductions'],
  ['patch', '/api/staff-deductions/7'],
  ['delete', '/api/staff-deductions/7'],
  ['post', '/api/staff-deductions/kinds'],
  ['patch', '/api/staff-deductions/kinds/3'],
  ['delete', '/api/staff-deductions/kinds/3'],
];

beforeEach(() => {
  h.calls.length = 0;
  invalidateRolePageAccessCache();
});

describe('права вкладки «Удержания»', () => {
  it('«Просмотр»: список, выгрузка и виды — да, запись и поиск — 403', async () => {
    for (const [method, url] of READS) {
      expect((await send(method, url, 'hr')).status, `${method} ${url}`).toBe(200);
    }
    for (const [method, url] of WRITES) {
      expect((await send(method, url, 'hr')).status, `${method} ${url}`).toBe(403);
    }
    expect(h.calls).toEqual(['deductions.list', 'deductions.exportTable', 'deductions.listKinds']);
  });

  it('«Редактирование» — всё', async () => {
    for (const [method, url] of [...READS, ...WRITES]) {
      expect((await send(method, url, 'hr_admin')).status, `${method} ${url}`).toBe(200);
    }
    expect(h.calls).toEqual([
      'deductions.list', 'deductions.exportTable', 'deductions.listKinds', 'deductions.searchEmployees',
      'deductions.add', 'deductions.update', 'deductions.remove',
      'deductions.addKind', 'deductions.updateKind', 'deductions.deleteKind',
    ]);
  });

  it('без права (в т.ч. с правом «Проживания») — 403 везде, контроллер не вызывается', async () => {
    for (const role of ['office', 'dorm']) {
      for (const [method, url] of [...READS, ...WRITES]) {
        expect((await send(method, url, role)).status, `${role} ${method} ${url}`).toBe(403);
      }
    }
    expect(h.calls).toEqual([]);
  });
});
