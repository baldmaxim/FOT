import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * Раздел «Зарплата» — только учёткам из списка payroll_section_access (миграция 310).
 *
 * Проверка прав здесь НАСТОЯЩАЯ (resolveEffectivePageAccess) и роутер настоящий, контроллеры —
 * заглушки со счётчиком вызовов. Администратор не из списка получает 403, хотя роль даёт ему
 * всё остальное; человек из списка проходит на любой роли.
 */

const h = vi.hoisted(() => {
  const calls: string[] = [];
  const stubController = (name: string) => new Proxy({}, {
    get: (_target, key) => (_req: unknown, res: { json: (body: unknown) => void }) => {
      calls.push(`${name}.${String(key)}`);
      res.json({ success: true, data: [] });
    },
  });
  return { calls, stubController, listedUserIds: new Set<string>() };
});

vi.mock('../config/postgres.js', () => ({
  queryOne: vi.fn().mockResolvedValue({ token_version: 0 }),
  query: vi.fn(async (sql: string, params: unknown[] = []) => (
    String(sql).includes('FROM payroll_section_access') && h.listedUserIds.has(String(params[0]))
      ? [{ user_id: params[0] }]
      : []
  )),
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

vi.mock('../controllers/payroll-deductions.controller.js', () => ({ payrollDeductionsController: h.stubController('deductions') }));
vi.mock('../controllers/payroll-paid.controller.js', () => ({ payrollPaidController: h.stubController('paid') }));
vi.mock('../controllers/payroll-rates.controller.js', () => ({ payrollRatesController: h.stubController('rates') }));
vi.mock('../controllers/payroll-section-access.controller.js', () => ({ payrollSectionAccessController: h.stubController('sectionAccess') }));
vi.mock('../controllers/payroll-terms.controller.js', () => ({ payrollTermsController: h.stubController('terms') }));
vi.mock('../controllers/payroll-vacation.controller.js', () => ({ payrollVacationController: h.stubController('vacation') }));
vi.mock('../controllers/dormitory-stays.controller.js', () => ({ dormitoryStaysController: h.stubController('dormitory') }));
vi.mock('../controllers/payroll-housing.controller.js', () => ({ payrollHousingController: h.stubController('housing') }));
vi.mock('../controllers/payroll-supplements.controller.js', () => ({ payrollSupplementsController: h.stubController('supplements') }));
vi.mock('../controllers/payroll-compensation-stops.controller.js', () => ({
  payrollCompensationStopsController: h.stubController('stops'),
}));
vi.mock('../controllers/payroll-registry.controller.js', () => ({ payrollRegistryController: h.stubController('registry') }));

const app = express();
app.use(express.json());
app.use('/api/payroll', (await import('../routes/payroll.routes.js')).default);

const { invalidateRolePageAccessCache } = await import('../services/access-control.service.js');

const tokenFor = (userId: string, roleCode: string): string => jwt.sign(
  {
    sub: userId,
    email: `${userId}@example.com`,
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

const get = (url: string, userId: string, roleCode: string): request.Test =>
  request(app).get(url).set('Authorization', `Bearer ${tokenFor(userId, roleCode)}`);

const ROUTES = [
  '/api/payroll/terms',
  '/api/payroll/section-access',
  '/api/payroll/rates',
  '/api/payroll/dormitory-stays',
  '/api/payroll/housing-allowances',
  '/api/payroll/supplements',
  '/api/payroll/compensation-stops',
  '/api/payroll/deduction-registry',
];

beforeEach(() => {
  h.calls.length = 0;
  h.listedUserIds.clear();
  invalidateRolePageAccessCache();
});

describe('раздел «Зарплата» по списку', () => {
  it('администратор не из списка — 403, контроллер не вызывается', async () => {
    for (const url of ROUTES) {
      const res = await get(url, 'admin-outside', 'admin');
      expect(res.status, url).toBe(403);
    }
    expect(h.calls).toEqual([]);
  });

  it('администратор из списка — проходит', async () => {
    h.listedUserIds.add('admin-listed');
    for (const url of ROUTES) {
      const res = await get(url, 'admin-listed', 'admin');
      expect(res.status, url).toBe(200);
    }
    expect(h.calls).toEqual([
      'terms.list', 'sectionAccess.list', 'rates.list', 'dormitory.listForPayroll',
      'housing.list', 'supplements.list', 'stops.list', 'registry.listDeductions',
    ]);
  });

  it('офисный сотрудник из списка — проходит, не из списка — 403', async () => {
    h.listedUserIds.add('buh-listed');
    expect((await get('/api/payroll/section-access', 'buh-listed', 'office')).status).toBe(200);
    expect((await get('/api/payroll/section-access', 'buh-outside', 'office')).status).toBe(403);
  });
});
