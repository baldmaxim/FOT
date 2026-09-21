import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Ключ /skud-settings/directory (просмотр вкладок «Точки доступа», «Объекты», «База»)
 * самодостаточен для настроек точек доступа: роль без /employee, /staff-control и
 * /skud-settings получает данные, роль без ключа — 403.
 */

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
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
  canAccessEmployeeInScope: vi.fn(async () => true),
  getSelfHistoryLimitForUser: vi.fn(() => ({ minDate: null, message: '' })),
  hasGlobalDepartmentReadScope: vi.fn(async () => false),
  isSelfEmployeeRequest: vi.fn(() => false),
  resolveScopedDepartmentId: vi.fn(async () => null),
  resolveRequestDataScope: vi.fn(async () => 'all'),
  resolveManagedDepartmentIds: vi.fn(async () => []),
  resolveAccessibleEmployeeIds: vi.fn(async () => 'all'),
  hasObjectViewScope: vi.fn(async () => false),
  canWriteEmployeeInScope: vi.fn(async () => true),
  resolveWritableScopedDepartmentId: vi.fn(async () => null),
}));

const grants = vi.hoisted(() => ({ pages: new Set<string>() }));
vi.mock('../services/access-control.service.js', () => ({
  resolveEffectivePageAccess: vi.fn(async (_req: unknown, page: string) => grants.pages.has(page)),
}));

vi.mock('../services/employee-skud-object-access.service.js', () => ({
  resolveAccessibleObjectIdsForRequest: vi.fn(async () => ({ is_unrestricted: true, object_ids: [] })),
}));
vi.mock('../services/skud-presence-by-object.service.js', async () => {
  const actual = await vi.importActual<typeof import('../services/skud-presence-by-object.service.js')>(
    '../services/skud-presence-by-object.service.js',
  );
  return { ...actual, getPresenceByObject: vi.fn() };
});
vi.mock('./skud-write.controller.js', () => ({ skudWriteController: {} }));
vi.mock('./skud-travel.controller.js', () => ({ skudTravelController: {} }));

import { skudController } from './skud.controller.js';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status: vi.fn((code: number) => { res.statusCode = code; return res; }),
    json: vi.fn((body: unknown) => { res.body = body; return res; }),
  };
  return res;
};

const makeReq = (): AuthenticatedRequest => ({
  user: { id: 'u-1', role_code: 'hr_admin', is_admin: false },
  query: {},
  params: {},
}) as unknown as AuthenticatedRequest;

beforeEach(() => {
  grants.pages = new Set();
  pgQuery.mockReset();
  pgQuery.mockResolvedValue([{ access_point_name: 'Турникет 1', is_internal: false }]);
});

describe('skudController.getAccessPointSettings — ключ /skud-settings/directory', () => {
  it('только ключ просмотра справочников → данные отдаются', async () => {
    grants.pages = new Set(['/skud-settings/directory']);
    const res = makeRes();
    await skudController.getAccessPointSettings(makeReq(), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: [{ access_point_name: 'Турникет 1', is_internal: false }] });
  });

  it('без ключей → 403, в БД не ходим', async () => {
    const res = makeRes();
    await skudController.getAccessPointSettings(makeReq(), res as unknown as Response);
    expect(res.statusCode).toBe(403);
    expect(pgQuery).not.toHaveBeenCalled();
  });
});
