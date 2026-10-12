import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * Табельщица с «Управлением кадрами» на ПРОСМОТР не может править кадры через API.
 *
 * Раньше авто-доступ руководителя выдавал ей /staff-control и на просмотр, и на правку:
 * её «отделы» — бригады объектов — не пусты, а матрица роли и авто-доступ складывались
 * по «ИЛИ». Интерфейс правку прятал, сервер — пропускал.
 *
 * Проверка прав здесь НАСТОЯЩАЯ (resolveEffectivePageAccess), матрица — та, что выдаётся
 * роли на проде; у пользователя есть бригады (условие, при котором срабатывал авто-доступ).
 * Роутеры настоящие, контроллеры — заглушки со счётчиком вызовов.
 */

const h = vi.hoisted(() => {
  const calls: string[] = [];
  const stubController = (name: string) => new Proxy({}, {
    get: (_target, key) => (_req: unknown, res: { json: (body: unknown) => void }) => {
      calls.push(`${name}.${String(key)}`);
      res.json({ success: true, data: [] });
    },
  });
  return { calls, stubController, matrix: [] as Array<[string, 'view' | 'edit']>, roleCode: 'timekeeper' };
});

vi.mock('../config/postgres.js', () => ({
  queryOne: vi.fn().mockResolvedValue({ token_version: 0 }),
  query: vi.fn(async (sql: string) => (
    String(sql).includes('FROM role_page_access')
      ? h.matrix.map(([page_path, mode]) => ({ role_code: h.roleCode, page_path, can_view: true, can_edit: mode === 'edit' }))
      : []
  )),
  execute: vi.fn().mockResolvedValue(0),
  withTransaction: vi.fn(),
  getPool: vi.fn(),
  pool: vi.fn(),
}));

vi.mock('../services/roles-cache.service.js', () => ({
  getRoleByCode: vi.fn(async (code: string) => ({
    id: `role-${code}`, code, is_admin: false, admin_access: true, manager_auto_access: true, is_active: true,
  })),
  getRoleById: vi.fn(async () => null),
  invalidateRolesCache: vi.fn(),
}));

vi.mock('../services/data-scope.service.js', () => ({
  // Бригады объектов есть — раньше этого хватало для авто-доступа к правке.
  resolveAccessibleDepartmentIds: vi.fn(async () => ['brigade-1', 'brigade-2']),
  hasAllDepartmentsScope: vi.fn(async () => false),
  hasDeputyAssignment: vi.fn(async () => false),
}));
vi.mock('../services/hiring-access.service.js', () => ({
  hasHiringAutoAccess: vi.fn(async () => false),
  isHiringRequesterRole: vi.fn(() => false),
}));
vi.mock('../services/object-kpi-roles-cache.service.js', () => ({ isEconomicsHead: vi.fn(async () => false) }));
vi.mock('../services/payroll/payroll-access.service.js', () => ({
  getRequestPayrollAccessLevel: vi.fn(async () => null),
  isPayrollGrantPage: vi.fn(() => false),
  payrollGrantAllows: vi.fn(() => false),
}));

vi.mock('../controllers/employees.controller.js', () => ({ employeesController: h.stubController('employees') }));
vi.mock('../controllers/employees-export.controller.js', () => ({ employeesExportController: h.stubController('employeesExport') }));
vi.mock('../controllers/employees-main-objects.controller.js', () => ({ employeesMainObjectsController: h.stubController('mainObjects') }));
vi.mock('../controllers/employees-section-departments.controller.js', () => ({ employeesSectionDepartmentsController: h.stubController('sectionDepartments') }));
vi.mock('../controllers/employees-staff.controller.js', () => ({ employeesStaffController: h.stubController('staff') }));
vi.mock('../controllers/employee-induction.controller.js', () => ({ employeeInductionController: h.stubController('induction') }));
vi.mock('../controllers/employee-object-attribution.controller.js', () => ({ employeeObjectAttributionController: h.stubController('objectAttribution') }));
vi.mock('../controllers/employee-enrich.controller.js', () => ({ employeeEnrichController: h.stubController('enrich') }));
vi.mock('../controllers/employee-enrich-salary.controller.js', () => ({ employeeSalaryEnrichController: h.stubController('enrichSalary') }));
vi.mock('../controllers/employee-enrich-salary-history.controller.js', () => ({ employeeSalaryHistoryController: h.stubController('salaryHistory') }));
vi.mock('../controllers/employee-enrich-contacts.controller.js', () => ({ employeeEnrichContactsController: h.stubController('enrichContacts') }));
vi.mock('../controllers/skud.controller.js', () => ({ skudController: h.stubController('skud') }));
vi.mock('../controllers/sigur.controller.js', () => ({ sigurController: h.stubController('sigur') }));
vi.mock('../controllers/sigur-monitor.controller.js', () => ({ sigurMonitorController: h.stubController('sigurMonitor') }));
vi.mock('../controllers/sigur-sync.controller.js', () => ({ sigurSyncController: h.stubController('sigurSync') }));
vi.mock('../controllers/sigur-admin.controller.js', () => ({ sigurAdminController: h.stubController('sigurAdmin') }));
vi.mock('../controllers/sigur-filter.controller.js', () => ({ sigurFilterController: h.stubController('sigurFilter') }));
vi.mock('../controllers/sigur-card-reader.controller.js', () => ({ sigurCardReaderController: h.stubController('sigurCardReader') }));
vi.mock('../controllers/schedule.controller.js', () => ({ scheduleController: h.stubController('schedule') }));
vi.mock('../controllers/schedule-export.controller.js', () => ({ scheduleExportController: h.stubController('scheduleExport') }));

const app = express();
app.use(express.json());
app.use('/api/employees', (await import('../routes/employees.routes.js')).default);
app.use('/api/skud', (await import('../routes/skud.routes.js')).default);
app.use('/api/sigur', (await import('../routes/sigur.routes.js')).default);
app.use('/api/schedules', (await import('../routes/schedule.routes.js')).default);

const { invalidateRolePageAccessCache } = await import('../services/access-control.service.js');

const tokenFor = (roleCode: string): string => jwt.sign(
  {
    sub: `${roleCode}-user`,
    email: `${roleCode}@example.com`,
    system_role_id: 'role-uuid',
    role_code: roleCode,
    is_admin: false,
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

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
const send = (method: Method, url: string, roleCode = 'timekeeper'): request.Test =>
  (request(app) as unknown as Record<Method, (u: string) => request.Test>)[method](url)
    .set('Authorization', `Bearer ${tokenFor(roleCode)}`);

/** Что выставляется роли «Табельщица» для просмотра кадров и работы с документами. */
const TIMEKEEPER_MATRIX: Array<[string, 'view' | 'edit']> = [
  ['/staff-control', 'view'],
  ['/employees', 'view'],
  ['/staff-control/hr-profiles', 'view'],
  ['/staff-control/hr-documents', 'edit'],
  ['/timesheet', 'edit'],
  ['/employee', 'view'],
];

const WRITE_ROUTES: Array<[Method, string]> = [
  ['post', '/api/employees'],
  ['put', '/api/employees/77'],
  ['post', '/api/employees/77/fire'],
  ['post', '/api/employees/77/rehire'],
  ['post', '/api/employees/77/cancel-dismissal'],
  ['put', '/api/employees/77/staff-comment'],
  ['post', '/api/employees/enrich'],
  ['post', '/api/employees/enrich-contacts'],
  ['delete', '/api/employees/all'],
  // Отдельные ключи: отдел, должность, история переводов.
  ['post', '/api/employees/batch-move'],
  ['post', '/api/employees/77/move-department'],
  ['post', '/api/employees/77/change-position'],
  ['put', '/api/employees/77/history/5'],
  ['delete', '/api/employees/77/history/5'],
  ['put', '/api/employees/77/object-attribution'],
  ['post', '/api/skud/sync-employee'],
  ['put', '/api/sigur/employees/77/cards/9/expiration'],
  ['patch', '/api/sigur/employees/77/cards/9/binding'],
  ['put', '/api/sigur/employees/77/access-points'],
  ['post', '/api/schedules'],
  ['put', '/api/schedules/3'],
  ['delete', '/api/schedules/3'],
];

const d = process.env.CODEX_SANDBOX ? describe.skip : describe;

d('табельщица: «Управление кадрами» только на просмотр', () => {
  beforeEach(() => {
    h.calls.length = 0;
    h.roleCode = 'timekeeper';
    h.matrix = TIMEKEEPER_MATRIX;
    invalidateRolePageAccessCache();
  });

  it.each(WRITE_ROUTES)('%s %s → 403, контроллер не вызван', async (method, url) => {
    const res = await send(method, url);
    expect(res.status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it.each([
    ['get', '/api/employees?page=1&view=staff'],
    ['get', '/api/employees/counts'],
    ['get', '/api/employees/77'],
    ['post', '/api/employees/main-objects'],
    ['get', '/api/schedules'],
    ['post', '/api/schedules/employees'],
  ] as Array<[Method, string]>)('чтение %s %s остаётся доступным', async (method, url) => {
    const res = await send(method, url);
    expect(res.status).toBe(200);
    expect(h.calls).toHaveLength(1);
  });

  it('без строки в матрице «Управление кадрами» закрыто целиком — бригады объектов его не открывают', async () => {
    h.matrix = TIMEKEEPER_MATRIX.filter(([page]) => page !== '/staff-control');
    invalidateRolePageAccessCache();

    expect((await send('get', '/api/employees?page=1&view=staff')).status).toBe(403);
    expect((await send('put', '/api/employees/77')).status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it('руководитель с отделами по-прежнему правит кадры по авто-доступу (регрессия)', async () => {
    h.roleCode = 'manager';
    h.matrix = [];
    invalidateRolePageAccessCache();

    expect((await send('put', '/api/employees/77', 'manager')).status).toBe(200);
    expect((await send('put', '/api/employees/77/staff-comment', 'manager')).status).toBe(200);
  });
});

/**
 * То же расхождение было у любой роли с «Просмотром» в матрице и назначенными отделами
 * (на проде — начальники участков): портал показывал только просмотр, сервер пропускал правку.
 */
d('роль с «Просмотром» в матрице и назначенными отделами (начальник участка)', () => {
  beforeEach(() => {
    h.calls.length = 0;
    h.roleCode = 'site_supervisor';
    h.matrix = [['/staff-control', 'view'], ['/employees', 'view'], ['/timesheet', 'edit'], ['/employee', 'view']];
    invalidateRolePageAccessCache();
  });

  it.each(WRITE_ROUTES)('%s %s → 403, контроллер не вызван', async (method, url) => {
    const res = await send(method, url, 'site_supervisor');
    expect(res.status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it.each([
    ['get', '/api/employees?page=1&view=staff'],
    ['get', '/api/employees/77'],
    ['get', '/api/schedules'],
  ] as Array<[Method, string]>)('чтение %s %s остаётся доступным', async (method, url) => {
    const res = await send(method, url, 'site_supervisor');
    expect(res.status).toBe(200);
    expect(h.calls).toHaveLength(1);
  });

  it('«Редактирование» в матрице правку возвращает', async () => {
    h.matrix = [['/staff-control', 'edit']];
    invalidateRolePageAccessCache();

    expect((await send('put', '/api/employees/77', 'site_supervisor')).status).toBe(200);
  });
});
