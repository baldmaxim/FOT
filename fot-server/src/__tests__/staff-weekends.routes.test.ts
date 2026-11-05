import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * «Выходные» кадров (миграция 346): право /staff-control/weekends, только просмотр. Проверка прав НАСТОЯЩАЯ
 * (resolveEffectivePageAccess), роутер и контроллер настоящие, заглушены список и охват.
 */

const h = vi.hoisted(() => ({
  list: vi.fn(),
  roster: vi.fn(),
  accessible: vi.fn(),
  rolePageAccess: [
    { role_code: 'hr', page_path: '/staff-control/weekends', can_view: true, can_edit: false },
    // Право «Удержаний» вкладку «Выходные» не открывает.
    { role_code: 'deductions_only', page_path: '/staff-control/deductions', can_view: true, can_edit: true },
  ],
}));

const LINE = '60e94f0c-7b39-4c5c-be92-6d8c0ad0d7c4';
const GENERAL = '0b24809e-5f04-45e1-bbe2-8a82990d6bdd';

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
  resolveAccessibleDepartmentIds: h.accessible,
  hasAllDepartmentsScope: vi.fn(async () => false),
  hasDeputyAssignment: vi.fn(async () => false),
}));
vi.mock('../services/hiring-access.service.js', () => ({
  hasHiringAutoAccess: vi.fn(async () => false),
  isHiringRequesterRole: vi.fn(() => false),
}));
vi.mock('../services/object-kpi-roles-cache.service.js', () => ({ isEconomicsHead: vi.fn(async () => false) }));
vi.mock('../services/employee-scope-filter.service.js', () => ({ resolveStaffRosterEmployeeIds: h.roster }));
vi.mock('../services/staff-weekends.service.js', () => ({
  listWeekendsWithoutCorrection: h.list,
  STAFF_WEEKENDS_BRANCH_IDS: ['60e94f0c-7b39-4c5c-be92-6d8c0ad0d7c4', '0b24809e-5f04-45e1-bbe2-8a82990d6bdd'],
  STAFF_WEEKENDS_MAX_MONTHS: 12,
}));

const app = express();
app.use(express.json());
app.use('/api/staff-weekends', (await import('../routes/staff-weekends.routes.js')).default);

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

const getList = (query: string, roleCode = 'hr'): request.Test =>
  request(app).get(`/api/staff-weekends${query}`).set('Authorization', `Bearer ${tokenFor(roleCode)}`);

const snapshot = (cell = '04.10, 11.10') => ({
  title: 'Выходные без корректировки',
  subtitle: 'Месяцы: октябрь 2026',
  file_name: 'Выходные.xlsx',
  columns: [{ label: 'ФИО', type: 'text' }, { label: 'Даты', type: 'text' }],
  rows: [{ cells: ['Джумаев', cell] }],
});

const postExport = (body: unknown, roleCode = 'hr'): request.Test =>
  request(app).post('/api/staff-weekends/export').set('Authorization', `Bearer ${tokenFor(roleCode)}`).send(body as object);

beforeEach(() => {
  h.list.mockReset().mockResolvedValue([]);
  h.roster.mockReset().mockResolvedValue('all');
  h.accessible.mockReset().mockResolvedValue([]);
  invalidateRolePageAccessCache();
});

describe('права вкладки «Выходные»', () => {
  it('с «Просмотром»: список и выгрузка работают', async () => {
    expect((await getList('?months=2026-10')).status).toBe(200);
    expect((await postExport(snapshot())).status).toBe(200);
  });

  it('без права (в т.ч. с правом «Удержаний») — 403, список не считается', async () => {
    for (const role of ['office', 'deductions_only']) {
      expect((await getList('?months=2026-10', role)).status, role).toBe(403);
      expect((await postExport(snapshot(), role)).status, role).toBe(403);
    }
    expect(h.list).not.toHaveBeenCalled();
  });
});

describe('месяцы', () => {
  it('список месяцев уходит в сервис — без повторов и по возрастанию', async () => {
    const res = await getList('?months=2026-11,2026-10,2026-11');
    expect(res.status).toBe(200);
    expect(h.list).toHaveBeenCalledWith(['2026-10', '2026-11'], [LINE, GENERAL]);
  });

  it('ровно 12 месяцев — можно', async () => {
    const months = Array.from({ length: 12 }, (_, index) => `2026-${String(index + 1).padStart(2, '0')}`).join(',');
    expect((await getList(`?months=${months}`)).status).toBe(200);
  });

  it('без месяцев, «весь период», 13 месяцев и мусор — 400, список не считается', async () => {
    const thirteen = ['2025-12', ...Array.from({ length: 12 }, (_, index) => `2026-${String(index + 1).padStart(2, '0')}`)].join(',');
    for (const query of ['', '?months=all', `?months=${thirteen}`, '?months=', '?months=октябрь', '?months=2026-10&months=2026-11']) {
      expect((await getList(query)).status, query).toBe(400);
    }
    expect(h.list).not.toHaveBeenCalled();
  });
});

describe('охват — по отделу, а не по текущему отделу сотрудника', () => {
  it('список кадров без ограничений — оба отдела', async () => {
    await getList('?months=2026-10');
    expect(h.list).toHaveBeenCalledWith(['2026-10'], [LINE, GENERAL]);
  });

  it('набор сотрудников без уволенных, но все отделы доступны — оба отдела', async () => {
    h.roster.mockResolvedValue(new Set([1]));
    h.accessible.mockResolvedValue('all');
    await getList('?months=2026-10');
    expect(h.list).toHaveBeenCalledWith(['2026-10'], [LINE, GENERAL]);
  });

  it('администратор компании с ветвью СУ-10: его уволенные не теряются — отбор по отделу', async () => {
    // Уволенный уже в «Уволенных», в наборе id его нет; отдел при этом в охвате.
    h.roster.mockResolvedValue(new Set([1]));
    h.accessible.mockResolvedValue([GENERAL, 'other-dept']);
    await getList('?months=2026-10');
    expect(h.list).toHaveBeenCalledWith(['2026-10'], [GENERAL]);
  });

  it('администратор другой компании — пустой список', async () => {
    h.roster.mockResolvedValue(new Set([1]));
    h.accessible.mockResolvedValue(['sm-dept']);
    const res = await getList('?months=2026-10');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(h.list).toHaveBeenCalledWith(['2026-10'], []);
  });
});

describe('экспорт', () => {
  it('длинный список дат за 12 месяцев проходит, сверх лимита — 400', async () => {
    expect((await postExport(snapshot('04.10, '.repeat(366)))).status).toBe(200);
    expect((await postExport(snapshot('x'.repeat(3001)))).status).toBe(400);
  });
});
