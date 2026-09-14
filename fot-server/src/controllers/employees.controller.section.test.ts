import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * «Управление кадрами»: фильтр «Раздел» (section) и total на странице за пределами результата.
 * Раздел считается как лист Excel: отдел до увольнения у уволенных, прямой подчинённый вне
 * отделов скоупа — «Прочие» (под конкретным разделом не виден).
 */
const h = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  canAccessEmployeeInScope: vi.fn(),
  hasGlobalDepartmentReadScope: vi.fn(),
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
  hasGlobalDepartmentReadScope: h.hasGlobalDepartmentReadScope,
  normalizeUuidParam: (value: unknown) => (typeof value === 'string' && value.trim() && value !== 'null' ? value : null),
  resolveManagedDepartmentIds: h.resolveManagedDepartmentIds,
  resolveRequestDataScope: vi.fn(),
  resolveRequestDataScopeWithDirectReports: h.resolveRequestDataScopeWithDirectReports,
  resolveScopedDepartmentId: h.resolveScopedDepartmentId,
}));
vi.mock('../services/department-access.service.js', () => ({
  listExplicitDepartmentIdsForUser: h.listExplicitDepartmentIdsForUser,
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

const SU10_ROOT_ID = '2cd8a403-6454-408b-9c2b-8a2db65c7511';
const DEPARTMENTS = [
  { id: 'root', parent_id: null, name: 'Объект', kind: 'object' },
  { id: SU10_ROOT_ID, parent_id: 'root', name: '(СУ-10) ООО СУ-10', kind: 'department' },
  { id: 'dept-own', parent_id: SU10_ROOT_ID, name: 'Отдел вентиляции', kind: 'department' },
  { id: 'su-support', parent_id: SU10_ROOT_ID, name: 'Отдел по сопровождению подрядчиков', kind: 'department' },
  { id: 'su-site', parent_id: SU10_ROOT_ID, name: 'Строительный участок', kind: 'department' },
  { id: 'brigades', parent_id: 'su-site', name: 'Бригады', kind: 'department' },
  { id: 'br-1', parent_id: 'brigades', name: 'бр.Иванов', kind: 'brigade' },
  { id: 'contractors', parent_id: 'root', name: 'Подрядные организации', kind: 'department' },
];

type Call = [string, unknown[]];

const employeeListCalls = (): Call[] =>
  h.query.mock.calls.filter(c => /FROM employees\s/.test(String(c[0])) && String(c[0]).includes('LIMIT')) as Call[];

/** Каждый $1..$N встречается в SQL, и выше N плейсхолдеров нет. */
const expectPlaceholdersMatch = (sql: string, params: unknown[]) => {
  const used = new Set([...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
  expect(Math.max(0, ...used)).toBe(params.length);
  for (let i = 1; i <= params.length; i += 1) expect(used.has(i)).toBe(true);
};

beforeEach(() => {
  Object.values(h).forEach(fn => fn.mockReset());
  h.logFromRequest.mockResolvedValue(undefined);
  h.query.mockImplementation(async (sql: string) => (String(sql).includes('FROM org_departments') ? DEPARTMENTS : []));
  h.listExplicitDepartmentIdsForUser.mockResolvedValue(['dept-own']);
  h.listDirectSubordinates.mockResolvedValue([]);
  h.resolveManagedDepartmentIds.mockResolvedValue(['dept-own']);
  h.resolveScopedDepartmentId.mockResolvedValue('dept-own');
  h.resolveRequestDataScopeWithDirectReports.mockResolvedValue('department');
  h.hasGlobalDepartmentReadScope.mockResolvedValue(true);
});

describe('getAll — параметр section', () => {
  it('некорректный раздел — 400, список не запрашивается', async () => {
    const res = makeRes();
    await employeesController.getAll(makeReq({ page: '1', section: 'other' }), res as never);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SECTION' });
    expect(employeeListCalls()).toHaveLength(0);
  });

  it('section=all и без параметра — без условия раздела и без чтения структуры', async () => {
    for (const query of [{ page: '1', section: 'all' }, { page: '1' }]) {
      h.query.mockClear();
      const res = makeRes();
      await employeesController.getAll(makeReq(query), res as never);
      expect(res.statusCode).toBe(200);
      const [sql] = employeeListCalls()[0];
      expect(sql).not.toContain('employee_dismissal_events');
      expect(h.query.mock.calls.some(c => String(c[0]).includes('FROM org_departments'))).toBe(false);
    }
  });

  it('su10 при глобальном чтении: отделы СУ-10 без бригад (включая «сопровождение подрядчиков»), отдел до увольнения', async () => {
    const res = makeRes();
    await employeesController.getAll(makeReq({ page: '1', section: 'su10' }), res as never);
    expect(res.statusCode).toBe(200);
    const [sql, params] = employeeListCalls()[0];
    expect(sql).toContain('employee_dismissal_events');
    expect(sql).toContain('d.from_department_id IS NOT NULL');
    const sectionIds = params.find(p => Array.isArray(p) && (p as string[]).includes(SU10_ROOT_ID)) as string[];
    expect(sectionIds.sort()).toEqual([SU10_ROOT_ID, 'dept-own', 'su-site', 'su-support'].sort());
    expect(sectionIds).not.toContain('br-1');
    expectPlaceholdersMatch(sql, params);
  });

  it('руководитель: прямой подчинённый вне отделов скоупа не проходит раздел — условие требует отдел скоупа', async () => {
    h.hasGlobalDepartmentReadScope.mockResolvedValue(false);
    h.listDirectSubordinates.mockResolvedValue([501]);

    const res = makeRes();
    await employeesController.getAll(makeReq({ page: '1', section: 'su10' }), res as never);

    expect(res.statusCode).toBe(200);
    const [sql, params] = employeeListCalls()[0];
    // Доступ списка прежний: отделы скоупа ИЛИ сам + прямые подчинённые.
    expect(sql).toMatch(/\(org_department_id = ANY\(\$2::uuid\[\]\) OR id = ANY\(\$3::int\[\]\)\)/);
    expect(params[2]).toEqual([501, 441]);
    // Условие раздела: отдел в разделе И отдел (с учётом увольнения) в скоупе. Прямые подчинённые туда не входят.
    const sectionPart = sql.slice(sql.indexOf('(CASE WHEN'));
    expect(sectionPart).not.toContain('int[]');
    expect(sectionPart).toMatch(/IS NOT NULL AND \(CASE WHEN[\s\S]*= ANY\(\$\d+::uuid\[\]\)\)/);
    const uuidArrays = params.filter(p => Array.isArray(p) && typeof (p as unknown[])[0] === 'string');
    expect(uuidArrays).toContainEqual(['dept-own']);
    expectPlaceholdersMatch(sql, params);
  });

  it('раздел + отдел + график + поиск + статус: все плейсхолдеры согласованы', async () => {
    h.queryOne.mockResolvedValue({ is_default: false });
    h.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM org_departments')) return DEPARTMENTS;
      if (String(sql).includes('FROM employee_schedule_assignments')) return [{ employee_id: 7, schedule_id: 'sch-1' }];
      return [];
    });

    const res = makeRes();
    await employeesController.getAll(makeReq({
      page: '1', section: 'brigades', department_id: 'br-1', schedule_id: 'sch-1', search: 'Ив', status: 'fired',
    }), res as never);

    expect(res.statusCode).toBe(200);
    const [sql, params] = employeeListCalls()[0];
    expect(sql).toContain(`employment_status = 'fired'`);
    expect(params).toContainEqual(['br-1']); // фильтр отдела
    expect(params).toContainEqual('%Ив%');
    expect(params).toContainEqual([7]); // график
    expectPlaceholdersMatch(sql, params);
  });

  it('раздел без отделов — FALSE и total 0', async () => {
    h.query.mockImplementation(async (sql: string) => (
      String(sql).includes('FROM org_departments') ? DEPARTMENTS.filter(d => d.id !== 'contractors') : []
    ));
    const res = makeRes();
    await employeesController.getAll(makeReq({ page: '1', section: 'contractors' }), res as never);
    const [sql] = employeeListCalls()[0];
    expect(sql).toContain('AND FALSE');
    expect(res.body).toMatchObject({ meta: { total: 0 } });
  });
});

describe('getAll — total на пустой странице', () => {
  it('страница за пределами результата: 0 строк, total из отдельного COUNT с тем же WHERE и параметрами', async () => {
    h.queryOne.mockResolvedValue({ total: 12 });

    const res = makeRes();
    await employeesController.getAll(makeReq({ page: '3', pageSize: '10', section: 'su10' }), res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ data: [], meta: { page: 3, pageSize: 10, total: 12, totalPages: 2 } });
    const [listSql, listParams] = employeeListCalls()[0];
    const [countSql, countParams] = h.queryOne.mock.calls.at(-1) as Call;
    const where = (sql: string) => sql.slice(sql.indexOf('WHERE') + 5).split(/ORDER BY|$/)[0].trim();
    expect(countSql).toContain('count(*)');
    expect(where(countSql)).toBe(where(listSql));
    expect(countParams).toEqual(listParams.slice(0, -2));
    expectPlaceholdersMatch(countSql, countParams);
  });

  it('первая пустая страница — COUNT не нужен, total 0', async () => {
    const res = makeRes();
    await employeesController.getAll(makeReq({ page: '1' }), res as never);
    expect(h.queryOne).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ meta: { total: 0 } });
  });

  it('непустая страница — total из оконного count, без отдельного COUNT', async () => {
    h.query.mockImplementation(async (sql: string) => (
      String(sql).includes('LIMIT') ? [{ id: 1, full_name: 'А', total_count: 21 }] : []
    ));
    const res = makeRes();
    await employeesController.getAll(makeReq({ page: '3', pageSize: '10' }), res as never);
    expect(h.queryOne).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ meta: { total: 21, totalPages: 3 } });
  });
});