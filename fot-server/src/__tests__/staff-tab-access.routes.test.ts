import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * Галочки «Проживание» и «Удержания» (миграция 351). Проверка прав НАСТОЯЩАЯ и роутеры настоящие, контроллеры —
 * заглушки. Галочка открывает только свою вкладку кадров (и роли без админки), справочник видов удержаний и раздел
 * «Зарплата» — нет. Выдавать галочку может только роль с правкой вкладки: персональная галочка этого права не даёт.
 */

const h = vi.hoisted(() => {
  const calls: string[] = [];
  const stubController = (name: string) => new Proxy({}, {
    get: (_target, key) => (_req: unknown, res: { json: (body: unknown) => void }) => {
      calls.push(`${name}.${String(key)}`);
      res.json({ success: true, data: [] });
    },
  });
  return {
    calls,
    stubController,
    grants: new Map<number, string[]>(),
    rolePages: new Map<string, Array<{ page_path: string; can_view: boolean; can_edit: boolean }>>(),
  };
});

vi.mock('../config/postgres.js', () => ({
  queryOne: vi.fn().mockResolvedValue({ token_version: 0 }),
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    const text = String(sql);
    if (text.includes('FROM role_page_access')) {
      return [...h.rolePages.entries()].flatMap(([role_code, pages]) => pages.map(page => ({ role_code, ...page })));
    }
    if (text.includes('FROM employee_staff_tab_access')) {
      return (h.grants.get(Number(params[0])) ?? []).map(tab => ({ tab }));
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
vi.mock('../controllers/deduction-subkinds.controller.js', () => ({ deductionSubkindsController: h.stubController('subkinds') }));
vi.mock('../controllers/dormitory-stays.controller.js', () => ({ dormitoryStaysController: h.stubController('dormitory') }));
vi.mock('../controllers/payroll-deductions.controller.js', () => ({ payrollDeductionsController: h.stubController('payrollDeductions') }));
vi.mock('../controllers/staff-tab-access.controller.js', () => ({
  staffTabAccessController: {
    dormitory: h.stubController('grantDormitory'),
    deductions: h.stubController('grantDeductions'),
  },
}));

const app = express();
app.use(express.json());
app.use('/api/staff-deductions', (await import('../routes/staff-deductions.routes.js')).default);
app.use('/api/dormitory', (await import('../routes/dormitory.routes.js')).default);
app.use('/api/payroll', (await import('../routes/payroll.routes.js')).default);
app.use('/api/admin', (await import('../routes/admin.routes.js')).default);

const { invalidateRolePageAccessCache } = await import('../services/access-control.service.js');

const tokenFor = (userId: string, roleCode: string, employeeId: number): string => jwt.sign(
  {
    sub: userId,
    email: `${userId}@example.com`,
    system_role_id: 'role-uuid',
    role_code: roleCode,
    is_admin: roleCode === 'admin',
    employee_variant: 'office',
    employee_id: employeeId,
    department_id: null,
    is_approved: true,
    two_factor_enabled: false,
    two_factor_verified: true,
  },
  process.env.JWT_SECRET!,
  { expiresIn: '1h' },
);

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

const call = (method: Method, url: string, roleCode: string, employeeId: number): request.Test => (
  request(app)[method](url).set('Authorization', `Bearer ${tokenFor(`user-${employeeId}`, roleCode, employeeId)}`).send({})
);

const DEDUCTION_ROUTES: Array<[Method, string]> = [
  ['get', '/api/staff-deductions'],
  ['get', '/api/staff-deductions/kinds'],
  ['get', '/api/staff-deductions/employees/search?q=Ив'],
  ['post', '/api/staff-deductions'],
  ['patch', '/api/staff-deductions/5'],
  ['delete', '/api/staff-deductions/5'],
];

const DEDUCTION_KIND_ROUTES: Array<[Method, string]> = [
  ['post', '/api/staff-deductions/kinds'],
  ['patch', '/api/staff-deductions/kinds/3'],
  ['delete', '/api/staff-deductions/kinds/3'],
  ['post', '/api/staff-deductions/kinds/3/subkinds'],
  ['patch', '/api/staff-deductions/subkinds/4'],
  ['delete', '/api/staff-deductions/subkinds/4'],
];

const DORMITORY_ROUTES: Array<[Method, string]> = [
  ['get', '/api/dormitory/stays'],
  ['post', '/api/dormitory/stays'],
  ['patch', '/api/dormitory/stays/7'],
  ['delete', '/api/dormitory/stays/7'],
  ['get', '/api/dormitory/employees/search?q=Ив'],
  ['get', '/api/dormitory/addresses'],
];

const PAYROLL_ROUTES: Array<[Method, string]> = [
  ['get', '/api/payroll/dormitory-stays'],
  ['post', '/api/payroll/dormitory-stays'],
  ['get', '/api/payroll/deduction-kinds'],
  ['post', '/api/payroll/deduction-kinds'],
  ['get', '/api/payroll/deductions/employee/5/staff'],
];

const GRANT_ROUTES: Array<[Method, string]> = [
  ['get', '/api/admin/employees/441/dormitory-access'],
  ['put', '/api/admin/employees/441/dormitory-access'],
  ['get', '/api/admin/employees/441/deductions-access'],
  ['put', '/api/admin/employees/441/deductions-access'],
];

const OFFICE_EMPLOYEE = 2520;

beforeEach(() => {
  h.calls.length = 0;
  h.grants.clear();
  h.rolePages.clear();
  invalidateRolePageAccessCache();
});

describe('галочка открывает свою вкладку кадров', () => {
  it('«Удержания» у роли без админки: записи вкладки открыты, справочник видов, «Проживание» и «Зарплата» — 403', async () => {
    h.grants.set(OFFICE_EMPLOYEE, ['deductions']);
    for (const [method, url] of DEDUCTION_ROUTES) {
      expect((await call(method, url, 'office', OFFICE_EMPLOYEE)).status, `${method} ${url}`).toBe(200);
    }
    const before = h.calls.length;
    for (const [method, url] of [...DEDUCTION_KIND_ROUTES, ...DORMITORY_ROUTES, ...PAYROLL_ROUTES, ...GRANT_ROUTES]) {
      expect((await call(method, url, 'office', OFFICE_EMPLOYEE)).status, `${method} ${url}`).toBe(403);
    }
    expect(h.calls.length).toBe(before);
  });

  it('«Проживание» не открывает «Удержания»', async () => {
    h.grants.set(OFFICE_EMPLOYEE, ['dormitory']);
    for (const [method, url] of DORMITORY_ROUTES) {
      expect((await call(method, url, 'office', OFFICE_EMPLOYEE)).status, `${method} ${url}`).toBe(200);
    }
    for (const [method, url] of [...DEDUCTION_ROUTES, ...DEDUCTION_KIND_ROUTES, ...PAYROLL_ROUTES]) {
      expect((await call(method, url, 'office', OFFICE_EMPLOYEE)).status, `${method} ${url}`).toBe(403);
    }
  });

  it('без галочки — 403, контроллер не вызывается', async () => {
    for (const [method, url] of [...DEDUCTION_ROUTES, ...DORMITORY_ROUTES]) {
      expect((await call(method, url, 'office', OFFICE_EMPLOYEE)).status, `${method} ${url}`).toBe(403);
    }
    expect(h.calls).toEqual([]);
  });
});

describe('справочник видов удержаний — только по роли', () => {
  it('роль с правкой «Удержаний» правит виды, роль с просмотром — нет', async () => {
    h.rolePages.set('hr_admin', [{ page_path: '/staff-control/deductions', can_view: true, can_edit: true }]);
    h.rolePages.set('security', [{ page_path: '/staff-control/deductions', can_view: true, can_edit: false }]);
    for (const [method, url] of DEDUCTION_KIND_ROUTES) {
      expect((await call(method, url, 'hr_admin', 10)).status, `hr_admin ${method} ${url}`).toBe(200);
      expect((await call(method, url, 'security', 441)).status, `security ${method} ${url}`).toBe(403);
    }
  });
});

describe('выдача галочек', () => {
  it('администратор и роль с правкой вкладки и назначениями — открыто; GET без HTTP-кэша', async () => {
    h.rolePages.set('hr_admin', [
      { page_path: '/admin/users/access', can_view: true, can_edit: true },
      { page_path: '/staff-control/dormitory', can_view: true, can_edit: true },
      { page_path: '/staff-control/deductions', can_view: true, can_edit: true },
    ]);
    for (const [role, employeeId] of [['admin', 1], ['hr_admin', 10]] as const) {
      for (const [method, url] of GRANT_ROUTES) {
        const res = await call(method, url, role, employeeId);
        expect(res.status, `${role} ${method} ${url}`).toBe(200);
        if (method === 'get') expect(res.headers['cache-control'], url).toBe('no-store');
      }
    }
  });

  it('назначения только на просмотр: GET открыт, PUT — 403', async () => {
    h.rolePages.set('hr_admin', [
      { page_path: '/admin/users/access', can_view: true, can_edit: false },
      { page_path: '/staff-control/dormitory', can_view: true, can_edit: true },
      { page_path: '/staff-control/deductions', can_view: true, can_edit: true },
    ]);
    for (const [method, url] of GRANT_ROUTES) {
      expect((await call(method, url, 'hr_admin', 10)).status, `${method} ${url}`).toBe(method === 'get' ? 200 : 403);
    }
  });

  it('назначения есть, правка вкладки только персональной галочкой — 403: галочку не раздают дальше', async () => {
    h.rolePages.set('security', [{ page_path: '/admin/users/access', can_view: true, can_edit: true }]);
    h.grants.set(441, ['dormitory', 'deductions']);
    for (const [method, url] of GRANT_ROUTES) {
      expect((await call(method, url, 'security', 441)).status, `${method} ${url}`).toBe(403);
    }
    expect(h.calls).toEqual([]);
  });

  it('правка вкладки есть, назначений нет — 403', async () => {
    h.rolePages.set('hr', [
      { page_path: '/staff-control/dormitory', can_view: true, can_edit: true },
      { page_path: '/staff-control/deductions', can_view: true, can_edit: true },
    ]);
    for (const [method, url] of GRANT_ROUTES) {
      expect((await call(method, url, 'hr', 20)).status, `${method} ${url}`).toBe(403);
    }
  });
});
