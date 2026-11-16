import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * «Выходные» кадров (миграция 346): право /staff-control/weekends, только просмотр. Проверка прав НАСТОЯЩАЯ
 * (resolveEffectivePageAccess), роутер и контроллер настоящие, заглушены список и охват.
 */

const h = vi.hoisted(() => ({
  candidates: vi.fn(),
  unlockedBranches: vi.fn(),
  grid: vi.fn(),
  roster: vi.fn(),
  accessible: vi.fn(),
  dataScope: vi.fn(),
  attachPeriods: vi.fn(),
  lockingIds: vi.fn(),
  activeUnlocks: vi.fn(),
  findOperation: vi.fn(),
  loadApprovals: vi.fn(),
  openTogether: vi.fn(),
  preview: vi.fn(),
  ensureAccess: vi.fn(),
  announce: vi.fn(),
  closeApproval: vi.fn(),
  invalidateGrid: vi.fn(),
  rolePageAccess: [
    { role_code: 'hr', page_path: '/staff-control/weekends', can_view: true, can_edit: false },
    { role_code: 'hr_admin', page_path: '/staff-control/weekends', can_view: true, can_edit: false },
    { role_code: 'hr_admin', page_path: '/timesheet/lock-toggle', can_view: true, can_edit: true },
    { role_code: 'viewer', page_path: '/staff-control/weekends', can_view: true, can_edit: false },
    // Право «Удержаний» вкладку «Выходные» не открывает.
    { role_code: 'deductions_only', page_path: '/staff-control/deductions', can_view: true, can_edit: true },
  ],
}));

const LINE = '60e94f0c-7b39-4c5c-be92-6d8c0ad0d7c4';
const GENERAL = '0b24809e-5f04-45e1-bbe2-8a82990d6bdd';
const BRIGADE = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
/** Отдел, где табель открыт кнопкой, а в кандидатах месяца его уже нет. */
const OPENED_ONLY = '9f8e7d6c-5b4a-4f3e-8d2c-1b0a9f8e7d6c';
const scopeOf = (visible: string[], ownership: string[] = [LINE, GENERAL, BRIGADE]) => ({
  ownershipBranchIds: ownership,
  visibleBranchIds: visible,
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
  resolveAccessibleDepartmentIds: h.accessible,
  resolveRequestDataScope: h.dataScope,
  hasAllDepartmentsScope: vi.fn(async () => false),
  hasDeputyAssignment: vi.fn(async () => false),
}));
vi.mock('../services/hiring-access.service.js', () => ({
  hasHiringAutoAccess: vi.fn(async () => false),
  isHiringRequesterRole: vi.fn(() => false),
}));
vi.mock('../services/object-kpi-roles-cache.service.js', () => ({ isEconomicsHead: vi.fn(async () => false) }));
vi.mock('../services/employee-scope-filter.service.js', () => ({ resolveStaffRosterEmployeeIds: h.roster }));
vi.mock('../services/staff-weekends.service.js', () => ({ listWeekendsByBranch: h.grid }));
vi.mock('../services/staff-branch-ownership.service.js', () => ({ listBranchCandidateIds: h.candidates }));

vi.mock('../services/staff-weekends-periods.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/staff-weekends-periods.service.js')>();
  return {
    ...actual,
    attachWeekendPeriods: h.attachPeriods,
    listLockingApprovalIds: h.lockingIds,
    listActiveUnlocks: h.activeUnlocks,
    listActiveUnlockBranchIds: h.unlockedBranches,
    findWeekendOperation: h.findOperation,
    loadApprovalsForAccessCheck: h.loadApprovals,
    openApprovalsTogether: h.openTogether,
    previewWeekendPeriod: h.preview,
  };
});
vi.mock('../controllers/timesheet-approval.controller.js', () => ({
  UNLOCK_REASON_MAX_LENGTH: 500,
  ensureApprovalAccess: h.ensureAccess,
  announceApprovalOpened: h.announce,
  closeApprovalPeriod: h.closeApproval,
  invalidateTimesheetGridCaches: h.invalidateGrid,
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
  h.candidates.mockReset().mockResolvedValue([LINE, GENERAL, BRIGADE]);
  h.unlockedBranches.mockReset().mockResolvedValue([]);
  h.grid.mockReset().mockResolvedValue([{ id: LINE, name: 'ЛИНИЯ', rows: [{ employee_id: 1, days: ['2026-10-04'] }] }]);
  h.dataScope.mockReset().mockResolvedValue('all');
  h.attachPeriods.mockReset().mockImplementation(async (_month: string, branches: Array<Record<string, unknown>>) => (
    branches.map(branch => ({ ...branch, periods: [] }))
  ));
  h.lockingIds.mockReset().mockResolvedValue([10, 11]);
  h.activeUnlocks.mockReset().mockResolvedValue([]);
  h.findOperation.mockReset().mockResolvedValue([]);
  h.loadApprovals.mockReset().mockResolvedValue([
    { id: 10, department_name: 'ЛИНИЯ', manager_name: null },
    { id: 11, department_name: null, manager_name: 'Бешлей О. И.' },
  ]);
  h.openTogether.mockReset().mockResolvedValue([{ id: 10 }, { id: 11 }]);
  h.preview.mockReset().mockResolvedValue({ expected_approval_ids: [10, 11] });
  h.ensureAccess.mockReset().mockResolvedValue(true);
  h.announce.mockReset().mockResolvedValue(undefined);
  h.closeApproval.mockReset().mockResolvedValue({ ok: true });
  h.invalidateGrid.mockReset();
  h.roster.mockReset().mockResolvedValue('all');
  h.accessible.mockReset().mockResolvedValue([]);
  invalidateRolePageAccessCache();
});

describe('права вкладки «Выходные»', () => {
  it('с «Просмотром»: сетка и выгрузка работают', async () => {
    expect((await getList('/grid?month=2026-10')).status).toBe(200);
    expect((await postExport(snapshot())).status).toBe(200);
  });

  it('без права (в т.ч. с правом «Удержаний») — 403, сетка не считается', async () => {
    for (const role of ['office', 'deductions_only']) {
      expect((await getList('/grid?month=2026-10', role)).status, role).toBe(403);
      expect((await postExport(snapshot(), role)).status, role).toBe(403);
    }
    expect(h.grid).not.toHaveBeenCalled();
  });

  it('прежнего списка ?months= больше нет', async () => {
    expect((await getList('?months=2026-10')).status).toBe(404);
  });
});

describe('охват — по отделу, а не по текущему отделу сотрудника', () => {
  it('список кадров без ограничений — все кандидаты месяца', async () => {
    await getList('/grid?month=2026-10');
    expect(h.candidates).toHaveBeenCalledWith('2026-10');
    expect(h.unlockedBranches).toHaveBeenCalledWith(['2026-10-01', '2026-10-16']);
    expect(h.grid).toHaveBeenCalledWith('2026-10', scopeOf([LINE, GENERAL, BRIGADE]));
  });

  it('набор сотрудников без уволенных, но все отделы доступны — все кандидаты', async () => {
    h.roster.mockResolvedValue(new Set([1]));
    h.accessible.mockResolvedValue('all');
    await getList('/grid?month=2026-10');
    expect(h.grid).toHaveBeenCalledWith('2026-10', scopeOf([LINE, GENERAL, BRIGADE]));
  });

  it('администратор компании: видит только свою ветку, а владелец дня считается по всем кандидатам', async () => {
    // Уволенный уже в «Уволенных», в наборе id его нет; отдел при этом в охвате.
    h.roster.mockResolvedValue(new Set([1]));
    h.accessible.mockResolvedValue([GENERAL, 'other-dept']);
    await getList('/grid?month=2026-10');
    expect(h.grid).toHaveBeenCalledWith('2026-10', scopeOf([GENERAL]));
  });

  it('администратор другой компании — пустой список', async () => {
    h.roster.mockResolvedValue(new Set([1]));
    h.accessible.mockResolvedValue(['sm-dept']);
    h.grid.mockResolvedValue([]);
    const res = await getList('/grid?month=2026-10');
    expect(res.status).toBe(200);
    expect(res.body.data.branches).toEqual([]);
    expect(h.grid).toHaveBeenCalledWith('2026-10', scopeOf([]));
  });
});

describe('сетка', () => {
  it('без права на кнопки — только отделы со строками', async () => {
    h.grid.mockResolvedValue([
      { id: LINE, name: 'ЛИНИЯ', rows: [] },
      { id: BRIGADE, name: 'бр.Иванов', rows: [{ employee_id: 1, days: ['2026-10-04'] }] },
    ]);
    const res = await getList('/grid?month=2026-10', 'viewer');
    expect(res.status).toBe(200);
    expect(res.body.data.branches).toEqual([
      { id: BRIGADE, name: 'бр.Иванов', rows: [{ employee_id: 1, days: ['2026-10-04'] }], periods: [] },
    ]);
  });

  it('без права — 403, не считается', async () => {
    expect((await getList('/grid?month=2026-10', 'deductions_only')).status).toBe(403);
    expect(h.grid).not.toHaveBeenCalled();
  });

  it('без месяца и с неверным месяцем — 400, не считается', async () => {
    for (const query of ['/grid', '/grid?month=', '/grid?month=2026-13', '/grid?month=2026-10-01', '/grid?month=2026-10&month=2026-11']) {
      expect((await getList(query)).status, query).toBe(400);
    }
    expect(h.grid).not.toHaveBeenCalled();
  });
});

describe('экспорт', () => {
  it('длинный список дат за 12 месяцев проходит, сверх лимита — 400', async () => {
    expect((await postExport(snapshot('04.10, '.repeat(366)))).status).toBe(200);
    expect((await postExport(snapshot('x'.repeat(3001)))).status).toBe(400);
  });
});

const OPERATION = '11111111-1111-4111-8111-111111111111';
const openBody = {
  operation_id: OPERATION,
  month: '2026-10',
  half: 1,
  branch_id: LINE,
  expected_approval_ids: [10, 11],
  reason: 'правка выходных',
};
const post = (path: string, body: unknown, roleCode = 'hr_admin'): request.Test =>
  request(app).post(`/api/staff-weekends/periods/${path}`).set('Authorization', `Bearer ${tokenFor(roleCode)}`).send(body as object);

describe('кнопки в ответе сетки', () => {
  it('право снимать замок и охват «все отделы» — периоды считаются, кнопки разрешены', async () => {
    const res = await getList('/grid?month=2026-10', 'hr_admin');
    expect(res.body.data.can_manage_periods).toBe(true);
    expect(h.attachPeriods).toHaveBeenCalledTimes(1);
  });

  it('без права снимать замок — кнопок нет, периоды не считаются', async () => {
    const res = await getList('/grid?month=2026-10', 'viewer');
    expect(res.status).toBe(200);
    expect(res.body.data.can_manage_periods).toBe(false);
    expect(res.body.data.branches[0].periods).toEqual([]);
    expect(h.attachPeriods).not.toHaveBeenCalled();
  });

  it('отдел вне кандидатов, но с открытым кнопкой табелем: виден без людей, с кнопкой «Закрыть»', async () => {
    h.unlockedBranches.mockResolvedValue([OPENED_ONLY]);
    h.grid.mockResolvedValue([
      { id: LINE, name: 'ЛИНИЯ', rows: [] },
      { id: OPENED_ONLY, name: 'Склад', rows: [] },
    ]);
    const closeOnly = [{ half: 1, start_date: '2026-10-01', end_date: '2026-10-15', can_open: false, can_close: true }];
    h.attachPeriods.mockImplementation(async (_month: string, branches: Array<{ id: string }>) => branches.map(branch => ({
      ...branch, periods: branch.id === OPENED_ONLY ? closeOnly : [],
    })));

    const res = await getList('/grid?month=2026-10', 'hr_admin');

    expect(h.grid).toHaveBeenCalledWith('2026-10', scopeOf([LINE, GENERAL, BRIGADE, OPENED_ONLY]));
    expect(res.body.data.branches).toEqual([{ id: OPENED_ONLY, name: 'Склад', rows: [], periods: closeOnly }]);
  });

  it('администратор компании: право есть, охват не «все» — кнопок нет', async () => {
    h.dataScope.mockResolvedValue('department');
    const res = await getList('/grid?month=2026-10', 'hr_admin');
    expect(res.body.data.can_manage_periods).toBe(false);
  });
});

describe('права кнопок', () => {
  it('без права снимать замок и без охвата «все» — 403, ничего не считается', async () => {
    for (const path of ['open', 'close']) {
      expect((await post(path, openBody, 'viewer')).status, path).toBe(403);
    }
    h.dataScope.mockResolvedValue('department');
    expect((await post('open', openBody)).status).toBe(403);
    expect(h.openTogether).not.toHaveBeenCalled();
    expect(h.closeApproval).not.toHaveBeenCalled();
  });

  it('без права вкладки — 403', async () => {
    expect((await post('open', openBody, 'deductions_only')).status).toBe(403);
  });

  it('отдел вне охвата — 403', async () => {
    h.roster.mockResolvedValue(new Set([1]));
    h.accessible.mockResolvedValue([GENERAL]);
    expect((await post('open', openBody)).status).toBe(403);
    expect((await post('close', { month: '2026-10', half: 1, branch_id: LINE })).status).toBe(403);
    expect(h.openTogether).not.toHaveBeenCalled();
  });
});

describe('открыть табель отдела', () => {
  it('подачи открываются вместе, причина и источник уходят в аудит на каждую, кэш сетки сбрасывается', async () => {
    const res = await post('open', openBody);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ operation_id: OPERATION, opened: [10, 11], repeated: false });
    expect(h.openTogether).toHaveBeenCalledWith(expect.objectContaining({
      operationId: OPERATION, branchId: LINE, periodStart: '2026-10-01', approvalIds: [10, 11], reason: 'правка выходных',
    }));
    expect(h.announce).toHaveBeenCalledTimes(2);
    expect(h.announce.mock.calls[0]?.[2]).toEqual({ reason: 'правка выходных', source: 'staff_weekends', operation_id: OPERATION });
    expect(h.invalidateGrid).toHaveBeenCalledTimes(1);
  });

  it('16-го и позже период начинается с 16-го', async () => {
    await post('open', { ...openBody, half: 2 });
    expect(h.openTogether.mock.calls[0]?.[0].periodStart).toBe('2026-10-16');
    expect(h.lockingIds.mock.calls[0]?.[1]).toBe(2);
  });

  it('состав изменился после окна подтверждения — 409, ничего не открыто', async () => {
    h.lockingIds.mockResolvedValue([10, 11, 12]);
    const res = await post('open', openBody);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PERIOD_SET_CHANGED');
    expect(h.openTogether).not.toHaveBeenCalled();
    expect(h.announce).not.toHaveBeenCalled();
  });

  it('нет доступа хотя бы к одной подаче — 403, не открыта ни одна', async () => {
    h.ensureAccess.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const res = await post('open', openBody);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Бешлей');
    expect(h.openTogether).not.toHaveBeenCalled();
  });

  it('повтор с тем же operation_id: прежний результат, без записи и аудита', async () => {
    h.findOperation.mockResolvedValue([
      { branch_id: LINE, period_start: '2026-10-01', approval_id: 10 },
      { branch_id: LINE, period_start: '2026-10-01', approval_id: 11 },
    ]);
    const res = await post('open', openBody);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ operation_id: OPERATION, opened: [10, 11], repeated: true });
    expect(h.openTogether).not.toHaveBeenCalled();
    expect(h.announce).not.toHaveBeenCalled();
    expect(h.invalidateGrid).not.toHaveBeenCalled();
  });

  it('operation_id от другого табеля — 409', async () => {
    h.findOperation.mockResolvedValue([{ branch_id: GENERAL, period_start: '2026-10-01', approval_id: 10 }]);
    const res = await post('open', openBody);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('OPERATION_ID_REUSED');
  });

  it('параллельный повтор успел первым: отвечаем его результатом, а не ошибкой', async () => {
    const { WeekendPeriodConflictError } = await import('../services/staff-weekends-periods.service.js');
    h.openTogether.mockRejectedValue(new WeekendPeriodConflictError('PERIOD_SET_CHANGED', 'изменился'));
    h.findOperation
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ branch_id: LINE, period_start: '2026-10-01', approval_id: 10 }]);
    const res = await post('open', openBody);
    expect(res.status).toBe(200);
    expect(res.body.data.repeated).toBe(true);
    expect(h.announce).not.toHaveBeenCalled();
  });

  it('откат транзакции без повтора — 409 с причиной, аудита нет', async () => {
    const { WeekendPeriodConflictError } = await import('../services/staff-weekends-periods.service.js');
    h.openTogether.mockRejectedValue(new WeekendPeriodConflictError('PERIOD_SET_CHANGED', 'изменился'));
    const res = await post('open', openBody);
    expect(res.status).toBe(409);
    expect(h.announce).not.toHaveBeenCalled();
    expect(h.invalidateGrid).not.toHaveBeenCalled();
  });

  it('неверные данные — 400', async () => {
    for (const body of [
      { ...openBody, operation_id: 'x' },
      { ...openBody, month: '2026-13' },
      { ...openBody, half: 3 },
      { ...openBody, branch_id: 'x' },
      { ...openBody, expected_approval_ids: [] },
      { ...openBody, reason: 'x'.repeat(501) },
    ]) {
      expect((await post('open', body)).status).toBe(400);
    }
    expect(h.openTogether).not.toHaveBeenCalled();
  });
});

describe('закрыть табель отдела', () => {
  const closeBody = { month: '2026-10', half: 1, branch_id: LINE };
  const approval = (id: number, managerName: string | null = null) => ({ id, department_name: 'ЛИНИЯ', manager_name: managerName });

  it('берёт только подачи этой кнопки этого отдела и половины', async () => {
    h.activeUnlocks.mockResolvedValue([approval(10), approval(11, 'Бешлей О. И.')]);
    const res = await post('close', closeBody);

    expect(h.activeUnlocks).toHaveBeenCalledWith([LINE], ['2026-10-01']);
    expect(res.body.data).toEqual({ closed: [10, 11], failed: [] });
    expect(h.closeApproval).toHaveBeenCalledTimes(2);
  });

  it('нерешённые выходные: точный результат, остальные закрыты', async () => {
    h.activeUnlocks.mockResolvedValue([approval(10), approval(11, 'Бешлей О. И.')]);
    h.closeApproval
      .mockResolvedValueOnce({ ok: false, status: 409, body: { success: false, error: 'Табель ждёт согласования выходных', code: 'PENDING_CORRECTIONS_EXIST' } })
      .mockResolvedValueOnce({ ok: true });
    const res = await post('close', closeBody);

    expect(res.status).toBe(200);
    expect(res.body.data.closed).toEqual([11]);
    expect(res.body.data.failed).toEqual([{
      id: 10, label: 'Табель отдела: ЛИНИЯ', error: 'Табель ждёт согласования выходных', code: 'PENDING_CORRECTIONS_EXIST',
    }]);
  });

  it('уже закрыта — считается закрытой', async () => {
    h.activeUnlocks.mockResolvedValue([approval(10)]);
    h.closeApproval.mockResolvedValue({ ok: false, status: 409, body: { success: false, error: 'Период уже закрыт', code: 'ALREADY_LOCKED' } });
    expect((await post('close', closeBody)).body.data).toEqual({ closed: [10], failed: [] });
  });

  it('отдел выпал из кандидатов, но открыт кнопкой — закрывается', async () => {
    h.unlockedBranches.mockResolvedValue([OPENED_ONLY]);
    h.activeUnlocks.mockResolvedValue([approval(10)]);
    const res = await post('close', { ...closeBody, branch_id: OPENED_ONLY });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ closed: [10], failed: [] });
    expect(h.activeUnlocks).toHaveBeenCalledWith([OPENED_ONLY], ['2026-10-01']);
  });

  it('чужой отдел (не кандидат и не открыт кнопкой) — 403', async () => {
    const res = await post('close', { ...closeBody, branch_id: OPENED_ONLY });
    expect(res.status).toBe(403);
    expect(h.closeApproval).not.toHaveBeenCalled();
  });

  it('повтор: закрывать нечего — пустой результат, а не ошибка', async () => {
    const res = await post('close', closeBody);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ closed: [], failed: [] });
    expect(h.closeApproval).not.toHaveBeenCalled();
  });

  it('сбой на одной подаче не останавливает остальные', async () => {
    h.activeUnlocks.mockResolvedValue([approval(10), approval(11)]);
    h.closeApproval.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ ok: true });
    const res = await post('close', closeBody);
    expect(res.body.data.closed).toEqual([11]);
    expect(res.body.data.failed[0]).toMatchObject({ id: 10, error: 'Ошибка закрытия табеля' });
  });
});

describe('состав для окна подтверждения', () => {
  it('отдаёт состав отдела; неверный запрос — 400; вне охвата — 403', async () => {
    const ok = await getList(`/periods/preview?month=2026-10&half=1&branch_id=${LINE}`, 'hr_admin');
    expect(ok.status).toBe(200);
    expect(ok.body.data.expected_approval_ids).toEqual([10, 11]);
    expect(h.preview.mock.calls[0]?.[1]).toBe(1);

    expect((await getList(`/periods/preview?month=2026-10&half=3&branch_id=${LINE}`, 'hr_admin')).status).toBe(400);
    h.roster.mockResolvedValue(new Set([1]));
    h.accessible.mockResolvedValue([GENERAL]);
    expect((await getList(`/periods/preview?month=2026-10&half=1&branch_id=${LINE}`, 'hr_admin')).status).toBe(403);
  });
});
