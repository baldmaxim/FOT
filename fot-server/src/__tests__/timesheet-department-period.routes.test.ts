import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * «Табель» → «По отделу»: роуты /api/timesheet-approvals/department-period*. Роутер, права (resolveTimesheetLockToggle)
 * и контроллер настоящие; расчёт состава заглушен (он покрыт PG-тестом сервиса).
 */

const h = vi.hoisted(() => ({
  accessible: vi.fn(),
  scoped: vi.fn(),
  dataScope: vi.fn(),
  state: vi.fn(),
  preview: vi.fn(),
  openPeriod: vi.fn(),
  closeTargets: vi.fn(),
  findOperation: vi.fn(),
  ensureAccess: vi.fn(),
  announce: vi.fn(),
  closeApproval: vi.fn(),
  invalidateGrid: vi.fn(),
  legacyOpen: vi.fn(),
  rolePageAccess: [
    { role_code: 'hr_admin', page_path: '/timesheet/lock-toggle', can_view: true, can_edit: true },
    { role_code: 'manager', page_path: '/timesheet', can_view: true, can_edit: true },
  ],
}));

const LINE = '60e94f0c-7b39-4c5c-be92-6d8c0ad0d7c4';
const OTHER = '0b24809e-5f04-45e1-bbe2-8a82990d6bdd';
const OP_1 = '11111111-1111-4111-8111-111111111111';
const OP_2 = '22222222-2222-4222-8222-222222222222';

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
    id: `role-${code}`, code, is_admin: code === 'admin', admin_access: true, manager_auto_access: false, is_active: true,
  })),
  getRoleById: vi.fn(async () => null),
  invalidateRolesCache: vi.fn(),
}));
vi.mock('../services/data-scope.service.js', () => ({
  resolveAccessibleDepartmentIds: h.accessible,
  resolveScopedDepartmentId: h.scoped,
  resolveRequestDataScope: h.dataScope,
  hasAllDepartmentsScope: vi.fn(async () => false),
  hasDeputyAssignment: vi.fn(async () => false),
}));
vi.mock('../services/hiring-access.service.js', () => ({
  hasHiringAutoAccess: vi.fn(async () => false),
  isHiringRequesterRole: vi.fn(() => false),
}));
vi.mock('../services/object-kpi-roles-cache.service.js', () => ({ isEconomicsHead: vi.fn(async () => false) }));

const stubController = () => new Proxy({}, {
  get: () => (_req: unknown, res: express.Response) => { res.status(299).json({ stub: true }); },
});
vi.mock('../controllers/timesheet-approval.controller.js', () => ({
  timesheetApprovalController: new Proxy({}, {
    get: (_target, prop) => (prop === 'openPeriod'
      ? h.legacyOpen
      : (_req: unknown, res: express.Response) => { res.status(299).json({ stub: true }); }),
  }),
  UNLOCK_REASON_MAX_LENGTH: 500,
  ensureApprovalAccess: h.ensureAccess,
  announceApprovalOpened: h.announce,
  closeApprovalPeriod: h.closeApproval,
  invalidateTimesheetGridCaches: h.invalidateGrid,
}));
vi.mock('../controllers/timesheet-review.controller.js', () => ({ timesheetReviewController: stubController() }));
vi.mock('../controllers/timesheet-month-close.controller.js', () => ({ closeTimesheetMonth: vi.fn() }));
vi.mock('../services/timesheet-department-period.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/timesheet-department-period.service.js')>()),
  getDepartmentPeriodState: h.state,
  previewDepartmentPeriod: h.preview,
  openDepartmentPeriod: h.openPeriod,
  listDepartmentPeriodCloseTargets: h.closeTargets,
}));
vi.mock('../services/staff-weekends-periods.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/staff-weekends-periods.service.js')>()),
  findWeekendOperation: h.findOperation,
}));

const { WeekendPeriodConflictError } = await import('../services/staff-weekends-periods.service.js');
const { invalidateRolePageAccessCache } = await import('../services/access-control.service.js');

const app = express();
app.use(express.json());
app.use('/api/timesheet-approvals', (await import('../routes/timesheet-approval.routes.js')).default);

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

const base = '/api/timesheet-approvals/department-period';
const FULL = { department_id: LINE, start_date: '2026-10-01', end_date: '2026-10-31' };
const openBody = (overrides: Record<string, unknown> = {}) => ({
  ...FULL,
  operation_ids: { 1: OP_1, 2: OP_2 },
  expected_approval_ids: [2772, 2773, 2179],
  reason: 'правка',
  ...overrides,
});

const get = (path: string, roleCode = 'hr_admin') =>
  request(app).get(path).set('Authorization', `Bearer ${tokenFor(roleCode)}`);
const post = (path: string, body: object, roleCode = 'hr_admin') =>
  request(app).post(path).set('Authorization', `Bearer ${tokenFor(roleCode)}`).send(body);

beforeEach(() => {
  h.accessible.mockReset().mockResolvedValue('all');
  h.scoped.mockReset().mockImplementation(async (_req: unknown, id: string) => id);
  h.dataScope.mockReset().mockResolvedValue('all');
  h.state.mockReset().mockResolvedValue({ start_date: '2026-10-01', end_date: '2026-10-31', halves: [], approvals: [] });
  h.preview.mockReset().mockResolvedValue({ expected_approval_ids: [2179, 2772, 2773] });
  h.openPeriod.mockReset().mockResolvedValue([{ id: 2772 }, { id: 2773 }, { id: 2179 }]);
  h.closeTargets.mockReset().mockResolvedValue([]);
  h.findOperation.mockReset().mockResolvedValue([]);
  h.ensureAccess.mockReset().mockResolvedValue(true);
  h.announce.mockReset().mockResolvedValue(undefined);
  h.closeApproval.mockReset().mockResolvedValue({ ok: true });
  h.invalidateGrid.mockReset();
  h.legacyOpen.mockReset().mockImplementation((_req: unknown, res: express.Response) => { res.status(298).json({}); });
  invalidateRolePageAccessCache();
});

describe('права и диапазон', () => {
  it('без права открывать табель — 403, расчёт не идёт', async () => {
    expect((await get(`${base}?department_id=${LINE}&start_date=2026-10-01&end_date=2026-10-31`, 'manager')).status).toBe(403);
    expect((await post(`${base}/open`, openBody(), 'manager')).status).toBe(403);
    expect((await post(`${base}/close`, FULL, 'manager')).status).toBe(403);
    expect(h.state).not.toHaveBeenCalled();
    expect(h.openPeriod).not.toHaveBeenCalled();
    expect(h.closeTargets).not.toHaveBeenCalled();
  });

  it('отдел вне охвата — 403', async () => {
    h.scoped.mockResolvedValue(null);
    expect((await get(`${base}?department_id=${OTHER}&start_date=2026-10-01&end_date=2026-10-31`)).status).toBe(403);
    expect((await post(`${base}/open`, openBody({ department_id: OTHER }))).status).toBe(403);
    expect(h.openPeriod).not.toHaveBeenCalled();
  });

  it('диапазон не половина и не месяц — 400', async () => {
    for (const [start, end] of [['2026-10-02', '2026-10-15'], ['2026-10-01', '2026-10-30'], ['2026-10-16', '2026-11-15']]) {
      expect((await get(`${base}?department_id=${LINE}&start_date=${start}&end_date=${end}`)).status, `${start}..${end}`).toBe(400);
    }
    expect(h.state).not.toHaveBeenCalled();
  });

  it('состояние и состав отдаются с проверкой доступа к подачам', async () => {
    const res = await get(`${base}?department_id=${LINE}&start_date=2026-10-01&end_date=2026-10-31`);
    expect(res.status).toBe(200);
    expect(h.state).toHaveBeenCalledWith(LINE, expect.objectContaining({ month: '2026-10' }), expect.any(Function));
    expect((await get(`${base}/preview?department_id=${LINE}&start_date=2026-10-16&end_date=2026-10-31`)).status).toBe(200);
  });
});

describe('открыть', () => {
  it('POST /department-period/open не уходит в /:id/open', async () => {
    const res = await post(`${base}/open`, openBody());
    expect(res.status).toBe(200);
    expect(h.legacyOpen).not.toHaveBeenCalled();
    expect(h.openPeriod).toHaveBeenCalledWith(expect.objectContaining({
      departmentId: LINE,
      operationIds: { 1: OP_1, 2: OP_2 },
      expectedIds: [2772, 2773, 2179],
      reason: 'правка',
    }));
    expect(res.body.data).toEqual({ opened: [2179, 2772, 2773], repeated: false });
    expect(h.announce).toHaveBeenCalledTimes(3);
    expect(h.invalidateGrid).toHaveBeenCalledTimes(1);
  });

  it('за весь месяц нужны оба разных operation_id', async () => {
    expect((await post(`${base}/open`, openBody({ operation_ids: { 1: OP_1 } }))).status).toBe(400);
    expect((await post(`${base}/open`, openBody({ operation_ids: { 1: OP_1, 2: OP_1 } }))).status).toBe(400);
    expect(h.openPeriod).not.toHaveBeenCalled();
  });

  it('повтор с теми же operation_id — прежний результат, без записи и аудита', async () => {
    h.findOperation.mockImplementation(async (id: string) => (id === OP_1
      ? [{ branch_id: LINE, period_start: '2026-10-01', approval_id: 2772 }, { branch_id: LINE, period_start: '2026-10-01', approval_id: 2179 }]
      : [{ branch_id: LINE, period_start: '2026-10-16', approval_id: 2773 }]));

    const res = await post(`${base}/open`, openBody());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ opened: [2179, 2772, 2773], repeated: true });
    expect(h.openPeriod).not.toHaveBeenCalled();
    expect(h.announce).not.toHaveBeenCalled();
  });

  it('operation_id уже использован для другого отдела — 409', async () => {
    h.findOperation.mockImplementation(async (id: string) => (id === OP_1
      ? [{ branch_id: OTHER, period_start: '2026-10-01', approval_id: 1 }]
      : []));
    const res = await post(`${base}/open`, openBody());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('OPERATION_ID_REUSED');
  });

  it('состав изменился — 409 с кодом, аудита нет', async () => {
    h.openPeriod.mockRejectedValue(new WeekendPeriodConflictError('PERIOD_SET_CHANGED', 'Состав табелей изменился — откройте окно заново'));
    const res = await post(`${base}/open`, openBody());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PERIOD_SET_CHANGED');
    expect(h.announce).not.toHaveBeenCalled();
  });

  it('параллельный повтор успел первым — отвечаем его результатом', async () => {
    h.openPeriod.mockRejectedValue(new WeekendPeriodConflictError('PERIOD_SET_CHANGED', 'x'));
    h.findOperation
      .mockResolvedValueOnce([]).mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ branch_id: LINE, period_start: '2026-10-01', approval_id: 2772 }])
      .mockResolvedValueOnce([{ branch_id: LINE, period_start: '2026-10-16', approval_id: 2773 }]);
    const res = await post(`${base}/open`, openBody());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ opened: [2772, 2773], repeated: true });
  });
});

describe('закрыть', () => {
  const target = (id: number, label: { department_name?: string | null; manager_name?: string | null }) => ({
    id, department_id: label.manager_name ? null : LINE, manager_employee_id: label.manager_name ? 1 : null,
    department_name: label.department_name ?? null, manager_name: label.manager_name ?? null,
  });

  it('ошибка одной подачи не мешает остальным; «уже закрыт» — успех', async () => {
    h.closeTargets.mockResolvedValue([
      target(2772, { department_name: 'ЛИНИЯ' }),
      target(2773, { department_name: 'ЛИНИЯ' }),
      target(2179, { manager_name: 'Иванишин С. А.' }),
    ]);
    h.closeApproval
      .mockResolvedValueOnce({ ok: false, status: 409, body: { success: false, error: 'Табель ждёт согласования выходных', code: 'PENDING_CORRECTIONS_EXIST' } })
      .mockResolvedValueOnce({ ok: false, status: 409, body: { success: false, error: 'Период уже закрыт', code: 'ALREADY_LOCKED' } })
      .mockRejectedValueOnce(new Error('сеть'));

    const res = await post(`${base}/close`, FULL);

    expect(res.status).toBe(200);
    expect(h.closeApproval).toHaveBeenCalledTimes(3);
    expect(res.body.data.closed).toEqual([2773]);
    expect(res.body.data.failed).toEqual([
      { id: 2772, label: 'Табель отдела: ЛИНИЯ', error: 'Табель ждёт согласования выходных', code: 'PENDING_CORRECTIONS_EXIST' },
      { id: 2179, label: 'Личный табель: Иванишин С. А.', error: 'Ошибка закрытия табеля' },
    ]);
  });

  it('повтор, когда закрывать нечего, — пустой ответ', async () => {
    const res = await post(`${base}/close`, FULL);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ closed: [], failed: [] });
    expect(h.closeApproval).not.toHaveBeenCalled();
  });
});
