import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Точечные права на чтение (роль «Отдел безопасности»):
 *  - /skud-presence/all-objects — «Сотрудники на объектах» и их выгрузка по всем объектам;
 *  - /dashboard/all-departments — «Обзор» по любому отделу.
 * Проверяем: полный скоуп только на этих экранах, независимость прав, обязательность
 * базового просмотра страницы, неизменность /presence («Управление кадрами») и админа.
 * read-scope-grants.service — настоящий; мокается только page-access по набору ключей.
 */

const h = vi.hoisted(() => ({
  grants: new Set<string>(),
  objectScope: { is_unrestricted: false, object_ids: [] as string[] },
  scopedDepartmentId: vi.fn(),
  getPresenceByObject: vi.fn(),
  getPresence: vi.fn(),
  getDashboardStats: vi.fn(),
  collectPresenceExport: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(async () => []), queryOne: vi.fn(), execute: vi.fn(), withTransaction: vi.fn(),
}));
vi.mock('../services/sigur.service.js', () => ({
  sigurService: { isConfigured: vi.fn(() => false), getAccessPoints: vi.fn(async () => []) },
}));
vi.mock('../services/skud-shared.service.js', () => ({
  getSyncFilteredEmployees: vi.fn(async () => null),
  queryEventsByEmployeeId: vi.fn(async () => []),
  searchAndBackfillByName: vi.fn(async () => []),
  getAccessPointCacheEntry: vi.fn(() => null),
  setAccessPointCacheEntry: vi.fn(),
}));
vi.mock('../services/skud-dashboard.service.js', () => ({ getDashboardStats: h.getDashboardStats }));
vi.mock('../services/skud-presence.service.js', () => ({ getPresence: h.getPresence }));
vi.mock('../services/skud-discipline.service.js', () => ({
  getDisciplineViolations: vi.fn(async () => ({ violations: [], employees: {}, departments: {} })),
}));
vi.mock('../services/skud-export.service.js', () => ({
  buildDisciplineWorkbook: vi.fn(),
  buildEmployeeSkudWorkbook: vi.fn(),
  formatMonthRangeLabel: vi.fn(),
  sanitizeExportFileName: vi.fn((s: string) => s),
}));
vi.mock('../services/data-scope.service.js', () => ({
  canAccessEmployeeInScope: vi.fn(async () => false),
  getSelfHistoryLimitForUser: vi.fn(() => ({ minDate: null, message: '' })),
  hasGlobalDepartmentReadScope: vi.fn(async () => true),
  isSelfEmployeeRequest: vi.fn(() => false),
  resolveScopedDepartmentId: h.scopedDepartmentId,
  resolveRequestDataScope: vi.fn(async () => 'department'),
  resolveManagedDepartmentIds: vi.fn(async () => []),
  resolveAccessibleEmployeeIds: vi.fn(async () => new Set([441])),
  hasObjectViewScope: vi.fn(async () => false),
  normalizeUuidParam: (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null),
}));
vi.mock('../services/access-control.service.js', () => ({
  resolveEffectivePageAccess: vi.fn(async (req: { user: { is_admin?: boolean } }, page: string) =>
    req.user.is_admin === true || h.grants.has(page)),
}));
vi.mock('../services/employee-skud-object-access.service.js', () => ({
  resolveAccessibleObjectIdsForRequest: vi.fn(async () => h.objectScope),
}));
vi.mock('../services/skud-presence-by-object.service.js', async () => {
  const actual = await vi.importActual<typeof import('../services/skud-presence-by-object.service.js')>(
    '../services/skud-presence-by-object.service.js',
  );
  return { ...actual, getPresenceByObject: h.getPresenceByObject };
});
vi.mock('../services/skud-presence-export.service.js', () => ({
  assertExportSize: vi.fn(),
  buildFilterOptions: vi.fn(() => ({ objects: [], groups: [] })),
  collectPresenceExport: h.collectPresenceExport,
  filterPresenceExport: vi.fn(() => []),
  PresenceExportError: class extends Error {},
}));
vi.mock('../services/skud-presence-export-excel.service.js', () => ({ buildPresenceExportWorkbook: vi.fn() }));
vi.mock('./skud-write.controller.js', () => ({ skudWriteController: {} }));
vi.mock('./skud-travel.controller.js', () => ({ skudTravelController: {} }));

import { skudController } from './skud.controller.js';

const FOREIGN_DEPT = 'aaaaaaaa-0000-0000-0000-000000000001';
const PRESENCE = '/skud-presence';
const ALL_OBJECTS = '/skud-presence/all-objects';
const DASHBOARD = '/dashboard';
const ALL_DEPARTMENTS = '/dashboard/all-departments';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status: vi.fn((code: number) => { res.statusCode = code; return res; }),
    json: vi.fn((body: unknown) => { res.body = body; return res; }),
  };
  return res;
};

const makeReq = (query: Record<string, unknown> = {}, isAdmin = false): AuthenticatedRequest => ({
  user: { id: 'u-1', role_code: isAdmin ? 'admin' : 'security', is_admin: isAdmin, employee_id: 441 },
  query,
  params: {},
  body: {},
}) as unknown as AuthenticatedRequest;

const presencePayload = { buckets: [], total_present: 0 };

beforeEach(() => {
  h.grants = new Set();
  h.objectScope = { is_unrestricted: false, object_ids: [] };
  h.scopedDepartmentId.mockReset().mockResolvedValue(null);
  h.getPresenceByObject.mockReset().mockResolvedValue(presencePayload);
  h.getPresence.mockReset().mockResolvedValue([]);
  h.getDashboardStats.mockReset().mockResolvedValue({ ok: true });
  h.collectPresenceExport.mockReset().mockResolvedValue([]);
});

describe('«Сотрудники на объектах — все объекты»', () => {
  it('с базовым ключом и правом → все объекты, scope_mode all', async () => {
    h.grants = new Set([PRESENCE, ALL_OBJECTS]);
    const res = makeRes();
    await skudController.getPresenceByObject(makeReq(), res as unknown as Response);
    expect(h.getPresenceByObject).toHaveBeenCalledWith({ allowedObjectIds: 'all' });
    expect(res.body).toMatchObject({ data: { scope_mode: 'all', is_unrestricted: true, assigned_object_ids: [] } });
  });

  it('без права → прежний ограниченный режим (сотрудники скоупа)', async () => {
    h.grants = new Set([PRESENCE]);
    const res = makeRes();
    await skudController.getPresenceByObject(makeReq(), res as unknown as Response);
    expect(res.body).toMatchObject({ data: { scope_mode: 'employee', is_unrestricted: false } });
  });

  it('право без базового просмотра страницы не действует', async () => {
    h.grants = new Set([ALL_OBJECTS]);
    const res = makeRes();
    await skudController.getPresenceByObject(makeReq(), res as unknown as Response);
    expect(res.body).toMatchObject({ data: { scope_mode: 'employee', is_unrestricted: false } });
  });

  it('право «Обзора» не расширяет «Сотрудников на объектах» (независимость)', async () => {
    h.grants = new Set([PRESENCE, DASHBOARD, ALL_DEPARTMENTS]);
    const res = makeRes();
    await skudController.getPresenceByObject(makeReq(), res as unknown as Response);
    expect(res.body).toMatchObject({ data: { scope_mode: 'employee', is_unrestricted: false } });
  });

  it('фильтры выгрузки видят тот же полный скоуп', async () => {
    h.grants = new Set([PRESENCE, ALL_OBJECTS]);
    const res = makeRes();
    await skudController.getPresenceExportFilters(
      makeReq({ date_from: '2026-09-01', date_to: '2026-09-15' }),
      res as unknown as Response,
    );
    const visibility = h.collectPresenceExport.mock.calls[0][0].visibility;
    expect(visibility.isUnrestricted).toBe(true);
    expect([...visibility.assignedObjectIds]).toEqual([]);
  });

  it('без права фильтры выгрузки остаются ограниченными', async () => {
    h.grants = new Set([PRESENCE]);
    const res = makeRes();
    await skudController.getPresenceExportFilters(
      makeReq({ date_from: '2026-09-01', date_to: '2026-09-15' }),
      res as unknown as Response,
    );
    expect(h.collectPresenceExport.mock.calls[0][0].visibility.isUnrestricted).toBe(false);
  });
});

describe('«Обзор — все отделы»', () => {
  it('статистика чужого отдела с правом → 200, общий резолвер отдела не используется', async () => {
    h.grants = new Set([DASHBOARD, ALL_DEPARTMENTS]);
    const res = makeRes();
    await skudController.getDashboardStats(makeReq({ department_id: FOREIGN_DEPT }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(h.getDashboardStats).toHaveBeenCalledWith(expect.objectContaining({ departmentId: FOREIGN_DEPT }));
    expect(h.scopedDepartmentId).not.toHaveBeenCalled();
  });

  it('без права чужой отдел → 403 как раньше', async () => {
    h.grants = new Set([DASHBOARD]);
    const res = makeRes();
    await skudController.getDashboardStats(makeReq({ department_id: FOREIGN_DEPT }), res as unknown as Response);
    expect(res.statusCode).toBe(403);
    expect(h.getDashboardStats).not.toHaveBeenCalled();
  });

  it('право без базового «Обзора» не действует', async () => {
    h.grants = new Set([ALL_DEPARTMENTS]);
    const res = makeRes();
    await skudController.getDashboardStats(makeReq({ department_id: FOREIGN_DEPT }), res as unknown as Response);
    expect(res.statusCode).toBe(403);
  });

  it('право «Сотрудников на объектах» не расширяет «Обзор» (независимость)', async () => {
    h.grants = new Set([DASHBOARD, PRESENCE, ALL_OBJECTS]);
    const res = makeRes();
    await skudController.getDashboardStats(makeReq({ department_id: FOREIGN_DEPT }), res as unknown as Response);
    expect(res.statusCode).toBe(403);
  });

  it('присутствие «Обзора» чужого отдела с правом → 200', async () => {
    h.grants = new Set([DASHBOARD, ALL_DEPARTMENTS]);
    const res = makeRes();
    await skudController.getDashboardPresence(makeReq({ department_id: FOREIGN_DEPT }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(h.getPresence).toHaveBeenCalledWith({ departmentId: FOREIGN_DEPT });
  });

  it('с правом без отдела → 400: право даёт выбор отдела, а не всю организацию разом', async () => {
    h.grants = new Set([DASHBOARD, ALL_DEPARTMENTS]);
    const res = makeRes();
    await skudController.getDashboardPresence(makeReq(), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(h.getPresence).not.toHaveBeenCalled();
  });

  it('присутствие «Обзора» без права → 403 как /presence', async () => {
    h.grants = new Set([DASHBOARD]);
    const res = makeRes();
    await skudController.getDashboardPresence(makeReq({ department_id: FOREIGN_DEPT }), res as unknown as Response);
    expect(res.statusCode).toBe(403);
  });

  it('/presence («Управление кадрами») с правом «Обзора» не расширяется', async () => {
    h.grants = new Set([DASHBOARD, ALL_DEPARTMENTS]);
    const res = makeRes();
    await skudController.getPresence(makeReq({ department_id: FOREIGN_DEPT }), res as unknown as Response);
    expect(res.statusCode).toBe(403);
    expect(h.getPresence).not.toHaveBeenCalled();
  });
});

describe('администратор — поведение прежнее', () => {
  it('«Обзор»: отдел через общий резолвер (company scope), без веток новых прав', async () => {
    h.scopedDepartmentId.mockResolvedValue(FOREIGN_DEPT);
    const res = makeRes();
    await skudController.getDashboardStats(makeReq({ department_id: FOREIGN_DEPT }, true), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(h.scopedDepartmentId).toHaveBeenCalledWith(expect.anything(), FOREIGN_DEPT);
  });

  it('«Сотрудники на объектах»: неограниченный скоуп из общего резолвера', async () => {
    h.objectScope = { is_unrestricted: true, object_ids: [] };
    const res = makeRes();
    await skudController.getPresenceByObject(makeReq({}, true), res as unknown as Response);
    expect(res.body).toMatchObject({ data: { scope_mode: 'all', is_unrestricted: true } });
  });
});
