import { beforeEach, describe, expect, it, vi } from 'vitest';

/** GET /api/timesheet/employees/:id/schedule-plan — проверки в порядке getAll табеля и ответ без кеша. */

const h = vi.hoisted(() => ({
  build: vi.fn(),
  scope: vi.fn(),
  canAccess: vi.fn(),
}));

vi.mock('../services/employee-schedule-plan.service.js', () => ({
  buildEmployeeSchedulePlan: h.build,
}));
vi.mock('../services/timesheet-scope.service.js', () => ({
  resolveTimesheetScope: h.scope,
  canAccessEmployeeForTimesheetPeriod: h.canAccess,
}));

const { timesheetSchedulePlanController } = await import('./timesheet-schedule-plan.controller.js');

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status: vi.fn(),
    json: vi.fn(),
    setHeader: vi.fn(),
  };
  res.status.mockImplementation((code: number) => { res.statusCode = code; return res; });
  res.json.mockImplementation((body: unknown) => { res.body = body; return res; });
  res.setHeader.mockImplementation((name: string, value: string) => { res.headers[name] = value; return res; });
  return res;
}

const now = new Date();
const CURRENT_MONTH = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

const request = (params: { employeeId?: string; month?: string; user?: Record<string, unknown> } = {}) => ({
  params: { employeeId: params.employeeId ?? '48' },
  query: params.month === undefined ? { month: CURRENT_MONTH } : { month: params.month },
  user: { is_admin: false, timesheet_months_back: 1, timesheet_months_forward: 1, ...params.user },
});

beforeEach(() => {
  Object.values(h).forEach(fn => fn.mockReset());
  h.scope.mockResolvedValue('department');
  h.canAccess.mockResolvedValue(true);
});

describe('timesheetSchedulePlanController.get', () => {
  it('200: сервис получает id и год месяца, тело — как есть, без кеша', async () => {
    const plan = { employee_id: 48, year: now.getFullYear(), periods: [], months: [] };
    h.build.mockResolvedValue(plan);
    const res = mockRes();
    await timesheetSchedulePlanController.get(request() as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(h.build).toHaveBeenCalledWith(48, now.getFullYear());
    expect(res.body).toEqual({ success: true, data: plan });
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('доступ к сотруднику проверяется на границах месяца табеля', async () => {
    h.scope.mockResolvedValue('all');
    h.build.mockResolvedValue({ employee_id: 48, year: 2026, periods: [], months: [] });
    const res = mockRes();
    await timesheetSchedulePlanController.get(request({ month: '2026-02' }) as never, res as never);
    expect(h.canAccess).toHaveBeenCalledWith(expect.anything(), 48, '2026-02-01', '2026-02-28');
    expect(h.build).toHaveBeenCalledWith(48, 2026);
  });

  it.each(['2026-13', '2026-1', '2026-00', '', 'abc'])('400 на месяц «%s»', async month => {
    const res = mockRes();
    await timesheetSchedulePlanController.get(request({ month }) as never, res as never);
    expect(res.statusCode).toBe(400);
    expect(h.build).not.toHaveBeenCalled();
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('400 на кривой id', async () => {
    const res = mockRes();
    await timesheetSchedulePlanController.get(request({ employeeId: '12abc' }) as never, res as never);
    expect(res.statusCode).toBe(400);
  });

  it('403 без скоупа', async () => {
    h.scope.mockResolvedValue(null);
    const res = mockRes();
    await timesheetSchedulePlanController.get(request() as never, res as never);
    expect(res.statusCode).toBe(403);
    expect(h.build).not.toHaveBeenCalled();
  });

  it('403 вне окна месяцев роли; админ окна не имеет', async () => {
    const res = mockRes();
    await timesheetSchedulePlanController.get(request({ month: '2020-01' }) as never, res as never);
    expect(res.statusCode).toBe(403);
    expect(h.canAccess).not.toHaveBeenCalled();
    expect(h.build).not.toHaveBeenCalled();

    h.build.mockResolvedValue({ employee_id: 48, year: 2020, periods: [], months: [] });
    const adminRes = mockRes();
    await timesheetSchedulePlanController.get(
      request({ month: '2020-01', user: { is_admin: true } }) as never,
      adminRes as never,
    );
    expect(adminRes.statusCode).toBe(200);
  });

  it('403 без доступа к сотруднику', async () => {
    h.canAccess.mockResolvedValue(false);
    const res = mockRes();
    await timesheetSchedulePlanController.get(request() as never, res as never);
    expect(res.statusCode).toBe(403);
    expect(h.build).not.toHaveBeenCalled();
  });

  it('404 — сотрудника нет', async () => {
    h.build.mockResolvedValue(null);
    const res = mockRes();
    await timesheetSchedulePlanController.get(request({ employeeId: '999999' }) as never, res as never);
    expect(res.statusCode).toBe(404);
  });
});
