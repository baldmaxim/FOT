import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * «Просмотр табеля» (миграция 309): проходы СКУД человека из списка смотрящего видны в
 * окне дня и боковой панели табеля по тем же правам, что и у своих людей ('/timesheet' +
 * '/timesheet/events', окно месяцев роли). Выгрузки этим путём не открываются.
 */

const { h } = vi.hoisted(() => ({
  h: {
    pgQuery: vi.fn(async () => [] as unknown[]),
    pageAccess: vi.fn(async (_req: unknown, _page: string, _action: string) => false),
    scopeAllowed: vi.fn(async () => false),
    viewOnly: vi.fn(async () => new Set<number>()),
    timesheetScope: vi.fn(async () => 'department' as const),
  },
}));

vi.mock('../config/postgres.js', () => ({
  query: h.pgQuery,
  queryOne: vi.fn(async () => null),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../services/sigur.service.js', () => ({
  sigurService: { isConfigured: () => false, getAccessPoints: vi.fn(async () => []) },
}));
vi.mock('../services/skud-shared.service.js', () => ({
  getSyncFilteredEmployees: vi.fn(async () => null),
  queryEventsByEmployeeId: vi.fn(async () => []),
  searchAndBackfillByName: vi.fn(async () => []),
  getAccessPointCacheEntry: vi.fn(() => null),
  setAccessPointCacheEntry: vi.fn(),
}));
vi.mock('../services/skud-dashboard.service.js', () => ({ getDashboardStats: vi.fn(async () => null) }));
vi.mock('../services/skud-presence.service.js', () => ({ getPresence: vi.fn(async () => []) }));
vi.mock('../services/skud-discipline.service.js', () => ({
  getDisciplineViolations: vi.fn(async () => ({ violations: [], employees: {}, departments: {} })),
}));
vi.mock('../services/skud-export.service.js', () => ({
  buildDisciplineWorkbook: vi.fn(),
  buildEmployeeSkudWorkbook: vi.fn(),
  formatMonthRangeLabel: vi.fn(),
  sanitizeExportFileName: vi.fn(),
}));
vi.mock('../services/data-scope.service.js', () => ({
  canAccessEmployeeInScope: h.scopeAllowed,
  getSelfHistoryLimitForUser: vi.fn(() => ({ minDate: null, message: '' })),
  hasGlobalDepartmentReadScope: vi.fn(async () => false),
  isSelfEmployeeRequest: vi.fn(() => false),
  resolveScopedDepartmentId: vi.fn(async () => null),
  resolveRequestDataScope: vi.fn(async () => 'self'),
  resolveManagedDepartmentIds: vi.fn(async () => []),
  resolveAccessibleEmployeeIds: vi.fn(async () => new Set<number>()),
  hasObjectViewScope: vi.fn(async () => false),
  canWriteEmployeeInScope: vi.fn(async () => false),
  resolveWritableScopedDepartmentId: vi.fn(async () => null),
}));
vi.mock('../services/access-control.service.js', () => ({ resolveEffectivePageAccess: h.pageAccess }));
vi.mock('../services/employee-skud-object-access.service.js', () => ({
  resolveAccessibleObjectIdsForRequest: vi.fn(async () => ({ is_unrestricted: true, object_ids: [] })),
}));
vi.mock('../services/employee-timesheet-view-access.service.js', () => ({
  resolveTimesheetViewOnlyEmployeeIds: h.viewOnly,
}));
vi.mock('../services/timesheet-scope.service.js', () => ({ resolveTimesheetScope: h.timesheetScope }));
vi.mock('./skud-write.controller.js', () => ({ skudWriteController: {} }));
vi.mock('./skud-travel.controller.js', () => ({ skudTravelController: {} }));

const { skudController } = await import('./skud.controller.js');

const VIEWER = 2562;
const WATCHED = 1361;
const STRANGER = 9999;

// Окно месяцев роли: 1 назад / 1 вперёд — текущий месяц в окне, 2020 — вне.
const now = new Date();
const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const inWindow = { startDate: `${ym}-01`, endDate: `${ym}-05` };
const outOfWindow = { startDate: '2020-01-01', endDate: '2020-01-05' };

const makeReq = (employeeId: number, dates: { startDate: string; endDate: string }): AuthenticatedRequest => ({
  params: { employeeId: String(employeeId) },
  query: { ...dates },
  body: {},
  user: {
    id: 'viewer-user',
    role_code: 'manager_obj',
    is_admin: false,
    employee_id: VIEWER,
    department_id: null,
    timesheet_months_back: 1,
    timesheet_months_forward: 1,
  },
} as unknown as AuthenticatedRequest);

const makeRes = () => {
  const response = {
    statusCode: 200,
    payload: null as unknown,
    headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.payload = body; return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; return this; },
    send(body: unknown) { this.payload = body; return this; },
    end() { return this; },
  };
  return response as unknown as Response & { statusCode: number; payload: unknown };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.pgQuery.mockResolvedValue([]);
  // Роль с табелем и событиями СКУД в табеле; человек вне обычного scope.
  h.pageAccess.mockImplementation(async (_req: unknown, page: string) => (
    page === '/timesheet' || page === '/timesheet/events'
  ));
  h.scopeAllowed.mockResolvedValue(false);
  h.viewOnly.mockResolvedValue(new Set([WATCHED]));
  h.timesheetScope.mockResolvedValue('department');
});

describe('skudController.getEmployeeEvents — «Просмотр табеля»', () => {
  it('человек из списка, месяц в окне → 200', async () => {
    const res = makeRes();
    await skudController.getEmployeeEvents(makeReq(WATCHED, inWindow), res);
    expect(res.statusCode).toBe(200);
  });

  it('без /timesheet/events (как у «Руководителя (строительство)») → 403, как и для своих', async () => {
    h.pageAccess.mockImplementation(async (_req: unknown, page: string) => page === '/timesheet');
    const res = makeRes();
    await skudController.getEmployeeEvents(makeReq(WATCHED, inWindow), res);
    expect(res.statusCode).toBe(403);
  });

  it('чужой → 403', async () => {
    const res = makeRes();
    await skudController.getEmployeeEvents(makeReq(STRANGER, inWindow), res);
    expect(res.statusCode).toBe(403);
  });

  it('месяц вне окна роли → 403', async () => {
    const res = makeRes();
    await skudController.getEmployeeEvents(makeReq(WATCHED, outOfWindow), res);
    expect(res.statusCode).toBe(403);
  });

  it("скоуп табеля не 'department' (роль без табеля) → 403", async () => {
    h.timesheetScope.mockResolvedValue('self' as never);
    const res = makeRes();
    await skudController.getEmployeeEvents(makeReq(WATCHED, inWindow), res);
    expect(res.statusCode).toBe(403);
  });
});

describe('выгрузки — «Просмотр табеля» их не открывает', () => {
  it('детализация боковой панели (export-detail) → 403', async () => {
    const res = makeRes();
    await skudController.exportEmployeeTimesheetDetail(makeReq(WATCHED, inWindow), res);
    expect(res.statusCode).toBe(403);
  });

  it('выгрузка событий (export) → 403', async () => {
    const res = makeRes();
    await skudController.exportEmployeeEvents(makeReq(WATCHED, inWindow), res);
    expect(res.statusCode).toBe(403);
  });
});
