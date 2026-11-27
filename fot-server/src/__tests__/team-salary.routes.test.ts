import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * Столбец «Зарплата» в табеле руководителя (миграция 382). Гард, охват и контроллер НАСТОЯЩИЕ, база и расчёт —
 * заглушки. Охват — по управлению (ручные full-привязки с подотделами), а не по читаемости табеля: view- и
 * deputy-привязки, sigur_sync, роль администратора и чужой отдел денег не открывают.
 */

const DEPT_A = '11111111-1111-4111-8111-111111111111';
const DEPT_A_CHILD = '22222222-2222-4222-8222-222222222222';
const DEPT_OTHER = '33333333-3333-4333-8333-333333333333';

interface IEdaRow { department_id: string; access_level: 'full' | 'view' | 'deputy'; source: string }

const h = vi.hoisted(() => ({
  grantedEmployeeIds: new Set<number>(),
  eda: [] as Array<{ department_id: string; access_level: 'full' | 'view' | 'deputy'; source: string }>,
  descendants: new Map<string, string[]>(),
  rolePages: new Map<string, Array<{ page_path: string; can_view: boolean; can_edit: boolean }>>(),
  members: [] as number[],
  calc: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  queryOne: vi.fn(async () => ({ token_version: 0 })),
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    const text = String(sql);
    if (text.includes('FROM role_page_access')) {
      return [...h.rolePages.entries()].flatMap(([role_code, pages]) => pages.map(page => ({ role_code, ...page })));
    }
    if (text.includes('FROM employee_team_salary_access')) {
      return h.grantedEmployeeIds.has(Number(params[0])) ? [{ employee_id: params[0] }] : [];
    }
    if (text.includes('FROM employee_department_access WHERE employee_id = $1 AND is_active = true')) {
      // Как listEmployeeAccessDepartmentIds: $2 — исключаемый source, $3 — уровни.
      const excludeSource = text.includes('source <>') ? params[1] : null;
      const levels = text.includes('access_level = ANY') ? params[params.length - 1] as string[] : null;
      return h.eda
        .filter((row: IEdaRow) => row.source !== excludeSource && (!levels || levels.includes(row.access_level)))
        .map((row: IEdaRow) => ({ department_id: row.department_id }));
    }
    if (text.includes('get_descendant_department_ids')) {
      const roots = params[0] as string[];
      return [...new Set(roots.flatMap(root => [root, ...(h.descendants.get(root) ?? [])]))].map(id => ({ id }));
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
    id: `role-${code}`, code, is_admin: code === 'admin', admin_access: true, manager_auto_access: false, is_active: true,
  })),
  getRoleById: vi.fn(async () => null),
  invalidateRolesCache: vi.fn(),
}));
vi.mock('../services/data-scope.service.js', () => ({
  resolveAccessibleDepartmentIds: vi.fn(async () => 'all'),
  hasAllDepartmentsScope: vi.fn(async () => true),
  hasDeputyAssignment: vi.fn(async () => false),
}));
vi.mock('../services/hiring-access.service.js', () => ({
  hasHiringAutoAccess: vi.fn(async () => false),
  isHiringRequesterRole: vi.fn(() => false),
}));
vi.mock('../services/object-kpi-roles-cache.service.js', () => ({ isEconomicsHead: vi.fn(async () => false) }));
vi.mock('../services/payroll/team-salary.service.js', () => ({
  TEAM_SALARY_MAX_EMPLOYEES: 500,
  loadTeamSalaryMembers: vi.fn(async () => h.members),
  calcTeamSalaryRows: h.calc,
}));

const app = express();
app.use(express.json());
app.use('/api/payroll', (await import('../routes/payroll.routes.js')).default);

const { invalidateRolePageAccessCache } = await import('../services/access-control.service.js');

const EMPLOYEE_ID = 815;

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

const getSalary = (departmentId: string, roleCode = 'manager'): request.Test => request(app)
  .get(`/api/payroll/team-salary?department_id=${departmentId}`)
  .set('Authorization', `Bearer ${tokenFor(`user-${roleCode}`, roleCode)}`);

const TIMESHEET_PAGE = { page_path: '/timesheet', can_view: true, can_edit: true };

beforeEach(() => {
  h.grantedEmployeeIds.clear();
  h.eda = [];
  h.descendants.clear();
  h.rolePages.clear();
  h.rolePages.set('manager', [TIMESHEET_PAGE]);
  h.rolePages.set('hr', [TIMESHEET_PAGE]);
  h.rolePages.set('site_supervisor', [TIMESHEET_PAGE]);
  h.members = [1, 2];
  h.calc.mockReset();
  h.calc.mockResolvedValue([{ employee_id: 1, status: 'not_closed', reason: 'not_covered' }]);
  invalidateRolePageAccessCache();
});

describe('GET /api/payroll/team-salary', () => {
  it('галочка + свой отдел — 200: месяц, смена месяца, время сервера, строки', async () => {
    h.grantedEmployeeIds.add(EMPLOYEE_ID);
    h.eda = [{ department_id: DEPT_A, access_level: 'full', source: 'manual_admin_ui' }];
    const res = await getSalary(DEPT_A);
    expect(res.status).toBe(200);
    expect(res.body.data.month).toMatch(/^\d{4}-\d{2}$/);
    expect(new Date(res.body.data.next_from).getTime()).toBeGreaterThan(Date.now() - 1000);
    expect(typeof res.body.data.server_now).toBe('string');
    expect(res.body.data.rows).toEqual([{ employee_id: 1, status: 'not_closed', reason: 'not_covered' }]);
    expect(h.calc).toHaveBeenCalledWith([1, 2], res.body.data.month, expect.anything());
  });

  it('подотдел своего отдела — 200; чужой отдел — 403 без расчёта', async () => {
    h.grantedEmployeeIds.add(EMPLOYEE_ID);
    h.eda = [{ department_id: DEPT_A, access_level: 'full', source: 'manual_admin_ui' }];
    h.descendants.set(DEPT_A, [DEPT_A_CHILD]);
    expect((await getSalary(DEPT_A_CHILD)).status).toBe(200);
    h.calc.mockClear();
    const res = await getSalary(DEPT_OTHER);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TEAM_SALARY_OUT_OF_SCOPE');
    expect(h.calc).not.toHaveBeenCalled();
  });

  it('без галочки — 403 у руководителя и у администратора (обхода is_admin нет)', async () => {
    h.eda = [{ department_id: DEPT_A, access_level: 'full', source: 'manual_admin_ui' }];
    for (const role of ['manager', 'admin']) {
      const res = await getSalary(DEPT_A, role);
      expect(res.status, role).toBe(403);
      expect(res.body.code).toBe('TEAM_SALARY_FORBIDDEN');
    }
    expect(h.calc).not.toHaveBeenCalled();
  });

  it('галочка, но только view, deputy или sigur_sync — не руководитель, 403', async () => {
    h.grantedEmployeeIds.add(EMPLOYEE_ID);
    h.eda = [
      { department_id: DEPT_A, access_level: 'view', source: 'manual_admin_ui' },
      { department_id: DEPT_A_CHILD, access_level: 'deputy', source: 'manual_admin_ui' },
      { department_id: DEPT_OTHER, access_level: 'full', source: 'sigur_sync' },
    ];
    for (const dept of [DEPT_A, DEPT_A_CHILD, DEPT_OTHER]) {
      expect((await getSalary(dept)).status, dept).toBe(403);
    }
    expect(h.calc).not.toHaveBeenCalled();
  });

  it('роль с общим просмотром табелей (hr): читаемый, но не свой отдел — 403', async () => {
    h.grantedEmployeeIds.add(EMPLOYEE_ID);
    h.eda = [{ department_id: DEPT_A, access_level: 'full', source: 'manual_admin_ui' }];
    expect((await getSalary(DEPT_OTHER, 'hr')).status).toBe(403);
    expect((await getSalary(DEPT_A, 'hr')).status).toBe(200);
  });

  it('роль без страницы табеля — 403', async () => {
    h.grantedEmployeeIds.add(EMPLOYEE_ID);
    h.eda = [{ department_id: DEPT_A, access_level: 'full', source: 'manual_admin_ui' }];
    h.rolePages.set('manager', []);
    invalidateRolePageAccessCache();
    expect((await getSalary(DEPT_A)).status).toBe(403);
    expect(h.calc).not.toHaveBeenCalled();
  });

  it('больше 500 человек — 422 без расчёта', async () => {
    h.grantedEmployeeIds.add(EMPLOYEE_ID);
    h.eda = [{ department_id: DEPT_A, access_level: 'full', source: 'manual_admin_ui' }];
    h.members = Array.from({ length: 501 }, (_, index) => index + 1);
    const res = await getSalary(DEPT_A);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TEAM_SALARY_TOO_MANY');
    expect(h.calc).not.toHaveBeenCalled();
  });

  it('месяц из запроса не принимается; некорректный отдел — 400', async () => {
    h.grantedEmployeeIds.add(EMPLOYEE_ID);
    h.eda = [{ department_id: DEPT_A, access_level: 'full', source: 'manual_admin_ui' }];
    const res = await request(app)
      .get(`/api/payroll/team-salary?department_id=${DEPT_A}&month=2026-05`)
      .set('Authorization', `Bearer ${tokenFor('user-manager', 'manager')}`);
    expect(res.status).toBe(200);
    expect(res.body.data.month).not.toBe('2026-05');
    expect((await getSalary('not-a-uuid')).status).toBe(400);
  });
});
