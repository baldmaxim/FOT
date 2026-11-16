import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * «Корректировки» кадров (миграция 365): право /staff-control/corrections, только просмотр. Права — настоящие
 * (resolveEffectivePageAccess), роутер и контроллер — настоящие, заглушены журнал, кандидаты и охват.
 */

const h = vi.hoisted(() => ({
  candidates: vi.fn(),
  list: vi.fn(),
  skud: vi.fn(),
  roster: vi.fn(),
  accessible: vi.fn(),
  rolePageAccess: [
    { role_code: 'hr_admin', page_path: '/staff-control/corrections', can_view: true, can_edit: false },
    { role_code: 'viewer', page_path: '/staff-control/corrections', can_view: true, can_edit: false },
    // Право «Выходных» журнал не открывает.
    { role_code: 'weekends_only', page_path: '/staff-control/weekends', can_view: true, can_edit: false },
  ],
}));

const LINE = '60e94f0c-7b39-4c5c-be92-6d8c0ad0d7c4';
const BRIGADE = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';

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
  resolveRequestDataScope: vi.fn(async () => 'all'),
  hasAllDepartmentsScope: vi.fn(async () => false),
  hasDeputyAssignment: vi.fn(async () => false),
}));
vi.mock('../services/hiring-access.service.js', () => ({
  hasHiringAutoAccess: vi.fn(async () => false),
  isHiringRequesterRole: vi.fn(() => false),
}));
vi.mock('../services/object-kpi-roles-cache.service.js', () => ({ isEconomicsHead: vi.fn(async () => false) }));
vi.mock('../services/employee-scope-filter.service.js', () => ({ resolveStaffRosterEmployeeIds: h.roster }));
vi.mock('../services/staff-branch-ownership.service.js', () => ({ listBranchCandidateIds: h.candidates }));
vi.mock('../services/staff-corrections.service.js', () => ({
  listStaffCorrections: h.list,
  computeStaffCorrectionSkud: h.skud,
}));

const app = express();
app.use(express.json());
app.use('/api/staff-corrections', (await import('../routes/staff-corrections.routes.js')).default);

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

const get = (path: string, roleCode = 'hr_admin'): request.Test => (
  request(app).get(`/api/staff-corrections${path}`).set('Authorization', `Bearer ${tokenFor(roleCode)}`)
);

const snapshot = {
  title: 'Корректировки',
  subtitle: 'Ноябрь 2026',
  file_name: 'Корректировки.xlsx',
  columns: [{ label: 'ФИО', type: 'text' }, { label: 'Часы', type: 'text' }],
  rows: [{ cells: ['Пахомов', '10'] }],
};

const scopeOf = (visible: string[]) => ({ ownershipBranchIds: [LINE, BRIGADE], visibleBranchIds: visible });

beforeEach(() => {
  h.candidates.mockReset().mockResolvedValue([LINE, BRIGADE]);
  h.list.mockReset().mockResolvedValue({ branches: [{ id: LINE, name: 'ЛИНИЯ' }], rows: [{ id: 1, branch_id: LINE }] });
  h.skud.mockReset().mockResolvedValue({ 1: { norm_hours: 8, skud_hours: 6, first_entry: null, last_exit: null } });
  h.roster.mockReset().mockResolvedValue('all');
  h.accessible.mockReset().mockResolvedValue([]);
  invalidateRolePageAccessCache();
});

describe('права вкладки «Корректировки»', () => {
  it('с «Просмотром»: журнал, СКУД и выгрузка работают', async () => {
    expect((await get('?month=2026-11')).status).toBe(200);
    expect((await get(`/skud?month=2026-11&branch_id=${LINE}`)).status).toBe(200);
    const exported = await request(app).post('/api/staff-corrections/export')
      .set('Authorization', `Bearer ${tokenFor('viewer')}`).send(snapshot);
    expect(exported.status).toBe(200);
  });

  it('без права (в т.ч. с правом «Выходных») — 403, ничего не считается', async () => {
    for (const role of ['office', 'weekends_only']) {
      expect((await get('?month=2026-11', role)).status, role).toBe(403);
      expect((await get(`/skud?month=2026-11&branch_id=${LINE}`, role)).status, role).toBe(403);
    }
    expect(h.list).not.toHaveBeenCalled();
    expect(h.skud).not.toHaveBeenCalled();
  });
});

describe('журнал', () => {
  it('владелец — по всем кандидатам, видимые — по охвату', async () => {
    const res = await get('?month=2026-11');
    expect(res.body.data.rows).toEqual([{ id: 1, branch_id: LINE }]);
    expect(h.list).toHaveBeenCalledWith('2026-11', scopeOf([LINE, BRIGADE]));
  });

  it('администратор компании видит только свою ветку', async () => {
    h.roster.mockResolvedValue(new Set([1]));
    h.accessible.mockResolvedValue([BRIGADE, 'other']);
    await get('?month=2026-11');
    expect(h.list).toHaveBeenCalledWith('2026-11', scopeOf([BRIGADE]));
  });

  it('без месяца и с неверным месяцем — 400', async () => {
    for (const query of ['', '?month=2026-13', '?month=2026-11-01']) {
      expect((await get(query)).status, query).toBe(400);
    }
    expect(h.list).not.toHaveBeenCalled();
  });
});

describe('СКУД отдела', () => {
  it('строки выбранного отдела, часы — как у роли', async () => {
    const res = await get(`/skud?month=2026-11&branch_id=${LINE}`);
    expect(res.body.data).toEqual({ 1: { norm_hours: 8, skud_hours: 6, first_entry: null, last_exit: null } });
    expect(h.list).toHaveBeenCalledWith('2026-11', scopeOf([LINE]));
    expect(h.skud).toHaveBeenCalledWith('2026-11', [{ id: 1, branch_id: LINE }], false);
  });

  it('отдел вне охвата или не кандидат — 403, не считается', async () => {
    h.roster.mockResolvedValue(new Set([1]));
    h.accessible.mockResolvedValue([BRIGADE]);
    expect((await get(`/skud?month=2026-11&branch_id=${LINE}`)).status).toBe(403);
    h.accessible.mockResolvedValue('all');
    expect((await get('/skud?month=2026-11&branch_id=9f8e7d6c-5b4a-4f3e-8d2c-1b0a9f8e7d6c')).status).toBe(403);
    expect(h.skud).not.toHaveBeenCalled();
  });

  it('неверный запрос — 400', async () => {
    expect((await get('/skud?month=2026-11&branch_id=x')).status).toBe(400);
  });
});
