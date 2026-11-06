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
vi.mock('../services/staff-weekends.service.js', () => ({
  listWeekendsWithoutCorrection: h.list,
  listWeekendsByBranch: h.grid,
  STAFF_WEEKENDS_BRANCH_IDS: ['60e94f0c-7b39-4c5c-be92-6d8c0ad0d7c4', '0b24809e-5f04-45e1-bbe2-8a82990d6bdd'],
  STAFF_WEEKENDS_MAX_MONTHS: 12,
}));

vi.mock('../services/staff-weekends-periods.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/staff-weekends-periods.service.js')>();
  return {
    ...actual,
    attachWeekendPeriods: h.attachPeriods,
    listLockingApprovalIds: h.lockingIds,
    listActiveUnlocks: h.activeUnlocks,
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
  h.list.mockReset().mockResolvedValue([]);
  h.grid.mockReset().mockResolvedValue([{ id: LINE, name: 'ЛИНИЯ', rows: [{ employee_id: 1, days: ['2026-10-04'] }] }]);
  h.dataScope.mockReset().mockResolvedValue('all');
  h.attachPeriods.mockReset().mockImplementation(async (_month: string, branches: unknown[]) => branches);
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

describe('сетка', () => {
  it('прежний ?months= отвечает прежней формой: массив строк, а не отделы', async () => {
    h.list.mockResolvedValue([{ employee_id: 1 }]);
    const res = await getList('?months=2026-10');
    expect(res.body.data).toEqual([{ employee_id: 1 }]);
    expect(h.grid).not.toHaveBeenCalled();
  });

  it('с «Просмотром» — отделы в охвате', async () => {
    h.grid.mockResolvedValue([{ id: LINE, name: 'ЛИНИЯ', rows: [] }]);
    const res = await getList('/grid?month=2026-10');
    expect(res.status).toBe(200);
    expect(res.body.data.branches).toEqual([{ id: LINE, name: 'ЛИНИЯ', rows: [] }]);
    expect(h.grid).toHaveBeenCalledWith('2026-10', [LINE, GENERAL]);
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

  it('охват: администратор компании с одним отделом получает только его', async () => {
    h.roster.mockResolvedValue(new Set([1]));
    h.accessible.mockResolvedValue([GENERAL]);
    await getList('/grid?month=2026-10');
    expect(h.grid).toHaveBeenCalledWith('2026-10', [GENERAL]);
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
