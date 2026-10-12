import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * «Управление кадрами» на ЧТЕНИЕ для роли с view_all_departments (роль «Отдел
 * безопасности»): список, счётчики и карточка — вся организация. Скоуп записи
 * (resolveRequestDataScope/canAccessEmployeeInScope) при этом не расширяется.
 */
const h = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  canAccessEmployeeInScope: vi.fn(),
  hasGlobalDepartmentReadScope: vi.fn(),
  hasStaffAllEmployeesGrant: vi.fn(),
  resolveRequestDataScopeWithDirectReports: vi.fn(),
  resolveScopedDepartmentId: vi.fn(),
  resolveManagedDepartmentIds: vi.fn(),
  listExplicitDepartmentIdsForUser: vi.fn(),
  listDirectSubordinates: vi.fn(),
  cacheGet: vi.fn(),
  countsGet: vi.fn(),
  logFromRequest: vi.fn(),
}));

vi.mock('../services/blacklist.service.js', () => ({
  findActive: vi.fn(async () => ({ strong: [], weak: [] })),
  assertNotBlacklisted: vi.fn(async () => ({ strong: [], weak: [] })),
  addEntryIn: vi.fn(),
  withSigurProfileGuard: vi.fn(),
  BlacklistBlockedError: class extends Error {},
}));
vi.mock('../config/postgres.js', () => ({
  queryOne: h.queryOne,
  query: h.query,
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../services/user-profile-name.service.js', () => ({ syncProfileNameFromEmployee: vi.fn() }));
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: h.logFromRequest, log: vi.fn() },
}));
vi.mock('../services/employee-mapper.service.js', () => ({
  loadStructureCache: vi.fn().mockResolvedValue({ departments: new Map(), positions: new Map() }),
  decryptEmployee: (row: unknown) => row,
  decryptEmployeeList: (row: unknown) => row,
}));
vi.mock('../services/employee-cache.service.js', () => ({
  employeeCache: { invalidate: vi.fn(), get: h.cacheGet, set: vi.fn() },
}));
vi.mock('../services/employee-counts-cache.service.js', () => ({
  employeeCountsCache: { get: h.countsGet, set: vi.fn(), clear: vi.fn() },
}));
vi.mock('../services/employee-archive-department.service.js', () => ({
  getKnownArchiveDepartment: vi.fn(),
  reconcileFiredEmployeesArchiveDepartment: vi.fn(),
  isProtectedArchiveDepartment: vi.fn().mockResolvedValue(false),
}));
vi.mock('../services/employee-changes.service.js', () => ({
  DomainValidationError: class extends Error {},
  employeeChangesService: { changeSalary: vi.fn(), changePosition: vi.fn() },
}));
vi.mock('../services/sigur-linked-employees.service.js', () => ({
  ensureSigurPosition: vi.fn(),
  syncLinkedEmployeeFromSigur: vi.fn(),
}));
vi.mock('../services/sigur.service.js', () => ({ sigurService: { updateEmployee: vi.fn(), isConfigured: vi.fn() } }));
vi.mock('../services/sigur-live-employees-crud.service.js', () => ({ createSigurEmployee: vi.fn() }));
vi.mock('../services/data-scope.service.js', () => ({
  canAccessEmployeeInScope: h.canAccessEmployeeInScope,
  canAccessEmployeeRecordsInScope: h.canAccessEmployeeInScope,
  hasGlobalDepartmentReadScope: h.hasGlobalDepartmentReadScope,
  normalizeUuidParam: (value: unknown) => (typeof value === 'string' && value.trim() && value !== 'null' ? value : null),
  resolveManagedDepartmentIds: h.resolveManagedDepartmentIds,
  resolveRequestDataScope: vi.fn(),
  resolveRequestDataScopeWithDirectReports: h.resolveRequestDataScopeWithDirectReports,
  resolveScopedDepartmentId: h.resolveScopedDepartmentId,
  canWriteEmployeeInScope: h.canAccessEmployeeInScope,
  resolveWritableScopedDepartmentId: h.resolveScopedDepartmentId,
}));
vi.mock('../services/department-access.service.js', () => ({
  listExplicitDepartmentIdsForUser: h.listExplicitDepartmentIdsForUser,
}));
vi.mock('../services/read-scope-grants.service.js', () => ({
  hasStaffAllEmployeesGrant: h.hasStaffAllEmployeesGrant,
}));
vi.mock('../services/employee-direct-reports.service.js', () => ({ listDirectSubordinates: h.listDirectSubordinates }));
vi.mock('../services/skud-shared.service.js', () => ({ collectDeptIds: vi.fn(async (id: string) => [id]) }));
vi.mock('../services/realtime-broadcast.service.js', () => ({ emitDomainChange: vi.fn() }));
vi.mock('../services/recipients.service.js', () => ({
  getEmployeeOwnerAndSupervisor: vi.fn().mockResolvedValue([]),
  getUserIdsByEmployeeIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('./employee-lifecycle.controller.js', () => ({
  fire: vi.fn(), rehire: vi.fn(), cancelDismissal: vi.fn(), moveDepartment: vi.fn(),
  batchMoveEmployees: vi.fn(), getHistory: vi.fn(), updateHistoryEvent: vi.fn(), deleteHistoryEvent: vi.fn(),
}));
vi.mock('./employee-import.controller.js', () => ({ deleteAll: vi.fn() }));

import { employeesController } from './employees.controller.js';
import type { AuthenticatedRequest } from '../types/index.js';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status: vi.fn((c: number) => { res.statusCode = c; return res; }),
    json: vi.fn((b: unknown) => { res.body = b; return res; }),
    setHeader: vi.fn(),
    end: vi.fn(),
  };
  return res;
};

const makeReq = (query: Record<string, unknown> = {}, params: Record<string, unknown> = {}): AuthenticatedRequest => ({
  user: { id: 'sec-1', role_code: 'security', is_admin: false, employee_id: 441 },
  params,
  query,
  body: {},
  ip: '127.0.0.1',
  headers: {},
  socket: {},
  header: () => undefined,
}) as unknown as AuthenticatedRequest;

/** SQL и параметры последнего SELECT из employees. */
const lastEmployeesQuery = (): { sql: string; params: unknown[] } => {
  const call = h.query.mock.calls.filter(c => String(c[0]).includes('FROM employees')).at(-1) as [string, unknown[]];
  return { sql: call[0], params: call[1] };
};

beforeEach(() => {
  Object.values(h).forEach(fn => fn.mockReset());
  h.logFromRequest.mockResolvedValue(undefined);
  h.query.mockResolvedValue([]);
  h.listExplicitDepartmentIdsForUser.mockResolvedValue(['dept-own']);
  h.listDirectSubordinates.mockResolvedValue([]);
  h.resolveManagedDepartmentIds.mockResolvedValue(['dept-own']);
  h.resolveScopedDepartmentId.mockResolvedValue('dept-own');
  h.resolveRequestDataScopeWithDirectReports.mockResolvedValue('department');
});

describe('getAll — список «Управления кадрами»', () => {
  it('view_all_departments: вся организация, без фильтра отдела и без сужения скоупом', async () => {
    h.hasGlobalDepartmentReadScope.mockResolvedValue(true);
    const res = makeRes();
    await employeesController.getAll(makeReq({ page: '1', pageSize: '50' }), res as never);
    expect(res.statusCode).toBe(200);
    const { sql } = lastEmployeesQuery();
    expect(sql).not.toContain('org_department_id = ANY');
    expect(sql).not.toMatch(/\bid = ANY/);
    expect(h.resolveScopedDepartmentId).not.toHaveBeenCalled();
  });

  it('view_all_departments + явный отдел: фильтр по запрошенному отделу, не по назначенным', async () => {
    h.hasGlobalDepartmentReadScope.mockResolvedValue(true);
    const res = makeRes();
    await employeesController.getAll(makeReq({ page: '1', department_id: 'dept-foreign' }), res as never);
    expect(res.statusCode).toBe(200);
    const { params } = lastEmployeesQuery();
    expect(params).toContainEqual(['dept-foreign']);
  });

  it('без флага: список сужен до назначенных отделов', async () => {
    h.hasGlobalDepartmentReadScope.mockResolvedValue(false);
    const res = makeRes();
    await employeesController.getAll(makeReq({ page: '1' }), res as never);
    const { sql, params } = lastEmployeesQuery();
    expect(sql).toContain('org_department_id = ANY');
    expect(params).toContainEqual(['dept-own']);
  });
});

describe('getCounts — счётчики', () => {
  it('view_all_departments: без фильтра отдела', async () => {
    h.hasGlobalDepartmentReadScope.mockResolvedValue(true);
    const res = makeRes();
    await employeesController.getCounts(makeReq(), res as never);
    expect(res.statusCode).toBe(200);
    const { sql } = lastEmployeesQuery();
    expect(sql).not.toContain('org_department_id = ANY');
    expect(h.resolveManagedDepartmentIds).not.toHaveBeenCalled();
  });
});

describe('getById — карточка', () => {
  it('чужой отдел + view_all_departments → карточка отдаётся', async () => {
    h.canAccessEmployeeInScope.mockResolvedValue(false);
    h.hasGlobalDepartmentReadScope.mockResolvedValue(true);
    h.cacheGet.mockReturnValue({ etag: 'e1', data: { id: 77 } });
    const res = makeRes();
    await employeesController.getById(makeReq({}, { id: '77' }), res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: { id: 77 } });
  });

  it('чужой отдел без флага → 403', async () => {
    h.canAccessEmployeeInScope.mockResolvedValue(false);
    h.hasGlobalDepartmentReadScope.mockResolvedValue(false);
    const res = makeRes();
    await employeesController.getById(makeReq({}, { id: '77' }), res as never);
    expect(res.statusCode).toBe(403);
  });
});

/**
 * Табельщица открывает карточку только тех, кого видит в списке «Управления кадрами».
 * Общий скоуп (canAccessEmployeeRecordsInScope) шире: он добавляет всех, кто проходит на её
 * объекты, включая людей вне её папок — по прямой ссылке они открываться не должны.
 */
describe('getById — карточка у табельщицы', () => {
  const makeTimekeeperReq = (id: string): AuthenticatedRequest => {
    const req = makeReq({}, { id });
    (req as unknown as { user: Record<string, unknown> }).user = {
      id: 'tk-1', role_code: 'timekeeper', is_admin: false, employee_id: 577,
    };
    return req;
  };

  /** Запрос «виден ли сотрудник в списке кадров». */
  const staffListQuery = (): { sql: string; params: unknown[] } | null => {
    const call = h.query.mock.calls.find(c => String(c[0]).includes('SELECT id FROM employees WHERE id = ANY'));
    return call ? { sql: String(call[0]), params: call[1] as unknown[] } : null;
  };

  beforeEach(() => {
    h.hasGlobalDepartmentReadScope.mockResolvedValue(false);
    h.cacheGet.mockReturnValue({ etag: 'e1', data: { id: 77 } });
    h.listExplicitDepartmentIdsForUser.mockResolvedValue([]);
    h.resolveManagedDepartmentIds.mockResolvedValue(['brigade-1']);
  });

  it('сотрудник её бригады → карточка отдаётся', async () => {
    h.canAccessEmployeeInScope.mockResolvedValue(true);
    h.query.mockResolvedValue([{ id: 77 }]);
    const res = makeRes();
    await employeesController.getById(makeTimekeeperReq('77'), res as never);
    expect(res.statusCode).toBe(200);
    expect(staffListQuery()?.params).toContainEqual(['brigade-1']);
  });

  it('человек её объекта вне папок → 403, хотя общий скоуп его пускает', async () => {
    h.canAccessEmployeeInScope.mockResolvedValue(true);
    h.query.mockResolvedValue([]);
    const res = makeRes();
    await employeesController.getById(makeTimekeeperReq('77'), res as never);
    expect(res.statusCode).toBe(403);
    // Решает список кадров, общий скоуп не спрашиваем вовсе.
    expect(h.canAccessEmployeeInScope).not.toHaveBeenCalled();
  });

  it('правило по бригаде, а не по статусу: уволенные и архивные её бригады тоже открываются', async () => {
    h.query.mockResolvedValue([{ id: 77 }]);
    const res = makeRes();
    await employeesController.getById(makeTimekeeperReq('77'), res as never);
    expect(res.statusCode).toBe(200);
    const sql = staffListQuery()?.sql ?? '';
    expect(sql).toContain('org_department_id = ANY');
    expect(sql).not.toMatch(/is_archived|employment_status|dismissal/);
  });

  it('свой профиль (личный кабинет) → отдаётся без проверки списка', async () => {
    h.query.mockResolvedValue([]);
    h.cacheGet.mockReturnValue({ etag: 'e1', data: { id: 577 } });
    const res = makeRes();
    await employeesController.getById(makeTimekeeperReq('577'), res as never);
    expect(res.statusCode).toBe(200);
    expect(staffListQuery()).toBeNull();
  });
});

/**
 * Право «Управление кадрами — все сотрудники» (роль «Табельщица»): экран кадров — вся
 * организация на чтение. Общий список без page (фильтр «Чеков за патент») остаётся в бригадах.
 * Кому право положено (роль, базовый просмотр) — решает read-scope-grants.service, здесь он
 * подменён.
 */
describe('право «все сотрудники» у табельщицы', () => {
  const makeTimekeeperReq = (query: Record<string, unknown> = {}, params: Record<string, unknown> = {}): AuthenticatedRequest => {
    const req = makeReq(query, params);
    (req as unknown as { user: Record<string, unknown> }).user = {
      id: 'tk-1', role_code: 'timekeeper', is_admin: false, employee_id: 577,
    };
    return req;
  };

  beforeEach(() => {
    h.hasGlobalDepartmentReadScope.mockResolvedValue(false);
    h.hasStaffAllEmployeesGrant.mockResolvedValue(true);
    h.listExplicitDepartmentIdsForUser.mockResolvedValue([]);
    h.resolveManagedDepartmentIds.mockResolvedValue(['brigade-1']);
    h.resolveScopedDepartmentId.mockResolvedValue(null);
  });

  it('постраничный список — вся организация, без сужения до бригад', async () => {
    const res = makeRes();
    await employeesController.getAll(makeTimekeeperReq({ page: '1', pageSize: '50' }), res as never);
    expect(res.statusCode).toBe(200);
    const { sql } = lastEmployeesQuery();
    expect(sql).not.toContain('org_department_id = ANY');
    expect(sql).not.toMatch(/\bid = ANY/);
  });

  it('вкладка «Уволенные» — тоже вся организация', async () => {
    const res = makeRes();
    await employeesController.getAll(makeTimekeeperReq({ page: '1', status: 'fired' }), res as never);
    expect(res.statusCode).toBe(200);
    const { sql } = lastEmployeesQuery();
    expect(sql).toContain("employment_status = 'fired'");
    expect(sql).not.toContain('org_department_id = ANY');
  });

  it('фильтр по чужому отделу принимается как есть', async () => {
    const res = makeRes();
    await employeesController.getAll(makeTimekeeperReq({ page: '1', department_id: 'dept-foreign' }), res as never);
    expect(res.statusCode).toBe(200);
    expect(lastEmployeesQuery().params).toContainEqual(['dept-foreign']);
    expect(h.resolveScopedDepartmentId).not.toHaveBeenCalled();
  });

  it('счётчики — без фильтра отдела', async () => {
    const res = makeRes();
    await employeesController.getCounts(makeTimekeeperReq(), res as never);
    expect(res.statusCode).toBe(200);
    expect(lastEmployeesQuery().sql).not.toContain('org_department_id = ANY');
  });

  it('общий список без page остаётся в бригадах: право не спрашивается', async () => {
    const res = makeRes();
    await employeesController.getAll(makeTimekeeperReq(), res as never);
    expect(res.statusCode).toBe(200);
    const { sql, params } = lastEmployeesQuery();
    expect(sql).toContain('org_department_id = ANY');
    expect(params).toContainEqual(['brigade-1']);
    expect(h.hasStaffAllEmployeesGrant).not.toHaveBeenCalled();
  });

  it('карточка чужого сотрудника открывается: круг списка — вся организация', async () => {
    h.cacheGet.mockReturnValue({ etag: 'e1', data: { id: 77 } });
    h.query.mockResolvedValue([{ id: 77 }]);
    const res = makeRes();
    await employeesController.getById(makeTimekeeperReq({}, { id: '77' }), res as never);
    expect(res.statusCode).toBe(200);
    const call = h.query.mock.calls.find(c => String(c[0]).includes('SELECT id FROM employees WHERE id = ANY'));
    expect(String(call?.[0])).not.toContain('org_department_id = ANY');
    // Общий скоуп (он шире бригад и уже списка) по-прежнему не спрашиваем.
    expect(h.canAccessEmployeeInScope).not.toHaveBeenCalled();
  });

  it('без права карточка чужого сотрудника закрыта', async () => {
    h.hasStaffAllEmployeesGrant.mockResolvedValue(false);
    h.cacheGet.mockReturnValue({ etag: 'e1', data: { id: 77 } });
    h.query.mockResolvedValue([]);
    const res = makeRes();
    await employeesController.getById(makeTimekeeperReq({}, { id: '77' }), res as never);
    expect(res.statusCode).toBe(403);
  });
});
