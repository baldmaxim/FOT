import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * Галочка «Выработка» (миграция 342). Проверка прав НАСТОЯЩАЯ и роутеры настоящие, контроллеры — заглушки: галочка
 * открывает только маршруты выработки и расчёта бригады (его сужает контроллер), раздел «Зарплата» и КТУ — нет. Выдают
 * только учётки из списка: администратор не из списка получает 403, хотя панель назначений ему открыта.
 */

const h = vi.hoisted(() => {
  const calls: string[] = [];
  const stubController = (name: string) => new Proxy({}, {
    get: (_target, key) => (_req: unknown, res: { json: (body: unknown) => void }) => {
      calls.push(`${name}.${String(key)}`);
      res.json({ success: true, data: [] });
    },
  });
  return { calls, stubController, listedUserIds: new Set<string>(), grantedEmployeeIds: new Set<number>() };
});

vi.mock('../config/postgres.js', () => ({
  queryOne: vi.fn().mockResolvedValue({ token_version: 0 }),
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    const text = String(sql);
    if (text.includes('FROM payroll_section_access')) {
      return h.listedUserIds.has(String(params[0])) ? [{ user_id: params[0] }] : [];
    }
    if (text.includes('FROM employee_brigade_output_access')) {
      return h.grantedEmployeeIds.has(Number(params[0])) ? [{ employee_id: params[0] }] : [];
    }
    return [];
  }),
  execute: vi.fn().mockResolvedValue(0),
  withTransaction: vi.fn(),
  getPool: vi.fn(),
  pool: vi.fn(),
}));

vi.mock('../services/roles-cache.service.js', () => ({
  getRoleByCode: vi.fn(async (code: string) => ({
    id: `role-${code}`, code, is_admin: code === 'admin', admin_access: code !== 'office', manager_auto_access: true, is_active: true,
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

vi.mock('../controllers/timesheet-salary.controller.js', () => ({ timesheetSalaryController: h.stubController('salary') }));
vi.mock('../controllers/payroll-terms.controller.js', () => ({ payrollTermsController: h.stubController('terms') }));
vi.mock('../controllers/brigade-output-access.controller.js', () => ({ brigadeOutputAccessController: h.stubController('grant') }));

const app = express();
app.use(express.json());
app.use('/api/payroll', (await import('../routes/payroll.routes.js')).default);
app.use('/api/admin', (await import('../routes/admin.routes.js')).default);

const { invalidateRolePageAccessCache } = await import('../services/access-control.service.js');

const EMPLOYEE_ID = 577;

const tokenFor = (userId: string, roleCode: string): string => jwt.sign(
  {
    sub: userId,
    email: `${userId}@example.com`,
    system_role_id: 'role-uuid',
    role_code: roleCode,
    is_admin: roleCode === 'admin',
    employee_variant: 'office',
    employee_id: EMPLOYEE_ID,
    department_id: null,
    is_approved: true,
    two_factor_enabled: false,
    two_factor_verified: true,
  },
  process.env.JWT_SECRET!,
  { expiresIn: '1h' },
);

const call = (method: 'get' | 'put', url: string, userId: string, roleCode: string): request.Test => (
  request(app)[method](url).set('Authorization', `Bearer ${tokenFor(userId, roleCode)}`).send(method === 'put' ? {} : undefined)
);

const OUTPUT_ROUTES: Array<['get' | 'put', string]> = [
  ['get', '/api/payroll/timesheet-salary'],
  ['get', '/api/payroll/timesheet-salary/brigades'],
  ['get', '/api/payroll/timesheet-salary/brigade-objects'],
  ['put', '/api/payroll/timesheet-salary/output'],
  ['put', '/api/payroll/timesheet-salary/object-output'],
];

const CLOSED_ROUTES: Array<['get' | 'put', string]> = [
  ['put', '/api/payroll/timesheet-salary/ktu'],
  ['get', '/api/payroll/terms'],
];

const GRANT_ROUTES: Array<['get' | 'put', string]> = [
  ['get', '/api/admin/employees/1429/brigade-output-access'],
  ['put', '/api/admin/employees/1429/brigade-output-access'],
];

beforeEach(() => {
  h.calls.length = 0;
  h.listedUserIds.clear();
  h.grantedEmployeeIds.clear();
  invalidateRolePageAccessCache();
});

describe('маршруты выработки', () => {
  it('галочка у роли без раздела — открыты; раздел «Зарплата» и КТУ — 403', async () => {
    h.grantedEmployeeIds.add(EMPLOYEE_ID);
    for (const [method, url] of OUTPUT_ROUTES) {
      expect((await call(method, url, 'potapov', 'hr')).status, url).toBe(200);
    }
    const before = h.calls.length;
    for (const [method, url] of CLOSED_ROUTES) {
      expect((await call(method, url, 'potapov', 'hr')).status, url).toBe(403);
    }
    expect(h.calls.length).toBe(before);
  });

  it('нет ни галочки, ни списка, в том числе у администратора — 403, контроллер не вызывается', async () => {
    for (const role of ['hr', 'admin']) {
      for (const [method, url] of OUTPUT_ROUTES) {
        expect((await call(method, url, `no-access-${role}`, role)).status, `${role} ${url}`).toBe(403);
      }
    }
    expect(h.calls).toEqual([]);
  });

  it('учётка из списка — все маршруты, в том числе КТУ', async () => {
    h.listedUserIds.add('listed');
    for (const [method, url] of [...OUTPUT_ROUTES, ...CLOSED_ROUTES]) {
      expect((await call(method, url, 'listed', 'admin')).status, url).toBe(200);
    }
  });
});

describe('выдача галочки', () => {
  it('только учётка из списка; администратор с панелью назначений без списка — 403', async () => {
    for (const [method, url] of GRANT_ROUTES) {
      expect((await call(method, url, 'badonova', 'admin')).status, url).toBe(403);
    }
    expect(h.calls).toEqual([]);

    h.listedUserIds.add('listed');
    for (const [method, url] of GRANT_ROUTES) {
      expect((await call(method, url, 'listed', 'admin')).status, url).toBe(200);
    }
    expect(h.calls).toEqual(['grant.get', 'grant.set']);
  });

  it('сама галочка выдавать не даёт', async () => {
    h.grantedEmployeeIds.add(EMPLOYEE_ID);
    for (const [method, url] of GRANT_ROUTES) {
      expect((await call(method, url, 'potapov', 'hr')).status, url).toBe(403);
    }
  });
});
