import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Табель роли «Заместитель» (deputy_head, миграция 292) — строго по галочкам роли.
 *
 * Маршруты записи табеля пускают и по личному ключу /employee/requests, поэтому галочку
 * держит сам доменный гейт: без «Табель → просмотр» — только своя строка (даже при прямых
 * подчинённых), без «Табель → правка» — запись только своей строки через любые назначения.
 */

const { h } = vi.hoisted(() => ({
  h: {
    rolePage: vi.fn(async (_req: unknown, _page: string, _action: string) => true),
    rawView: vi.fn(async () => false),
    deputyAssignment: vi.fn(async () => true),
    directSubs: vi.fn(async () => [] as number[]),
  },
}));

vi.mock('./access-control.service.js', () => ({
  resolveRolePageAccess: h.rolePage,
  hasPageView: h.rawView,
  hasPageEdit: h.rawView,
}));
vi.mock('./data-scope.service.js', () => ({
  hasAllDepartmentsScope: vi.fn(async () => false),
  hasGlobalDepartmentReadScope: vi.fn(async () => false),
  hasObjectViewScope: vi.fn(async () => false),
  normalizeUuidParam: (v: unknown) => (typeof v === 'string' && v ? v : null),
  resolveAccessibleDepartmentIds: vi.fn(async () => ['dept-role']),
  resolveAccessibleEmployeeIds: vi.fn(async () => new Set<number>()),
  hasDeputyAssignment: h.deputyAssignment,
  resolveTimesheetEditableDepartmentIds: vi.fn(async () => ['dept-role']),
  resolveEffectiveDirectSubordinates: h.directSubs,
  resolveManagedDepartmentIds: vi.fn(async () => ['dept-role']),
  resolveScopedDepartmentId: vi.fn(async (_req: unknown, id: string | null) => id),
}));
vi.mock('./timekeeper-scope.service.js', () => ({
  isTimekeeper: () => false,
  resolveTimekeeperEditableLiIds: vi.fn(async () => new Set<number>()),
  LI_OBSHESTROY_DEPARTMENT_ID: 'li-dept',
}));
vi.mock('./timesheet-department-assignments.service.js', () => ({
  listEmployeeIdsAssignedToDepartmentPeriod: vi.fn(async () => [COLLEAGUE]),
}));
vi.mock('./direct-report-coverage.service.js', () => ({
  splitDirectReportsByCoverage: vi.fn(async (ids: number[]) => ({ owned: ids, partiallyCovered: [], fullyCovered: [] })),
}));
vi.mock('../config/postgres.js', () => ({ query: vi.fn(async () => []) }));

const COLLEAGUE = 501;
const SUBORDINATE = 777;
const SELF = 441;

const {
  roleAllowsTimesheet,
  resolveTimesheetScope,
  hasManagedTimesheetAccess,
  canAccessEmployeeForTimesheetPeriod,
} = await import('./timesheet-scope.service.js');

const makeReq = (roleCode = 'deputy_head'): AuthenticatedRequest => ({
  user: { id: 'u1', employee_id: SELF, role_code: roleCode, is_admin: false, department_id: null },
} as unknown as AuthenticatedRequest);

/** Галочки роли: view/edit на /timesheet. */
const setMatrix = (view: boolean, edit: boolean): void => {
  h.rolePage.mockImplementation(async (_req: unknown, page: string, action: string) => (
    page === '/timesheet' && (action === 'edit' ? edit : view)
  ));
};

beforeEach(() => {
  vi.clearAllMocks();
  setMatrix(true, true);
  h.deputyAssignment.mockResolvedValue(true);
  h.directSubs.mockResolvedValue([]);
});

describe('roleAllowsTimesheet', () => {
  it('другие роли не затронуты: всегда true, матрица не читается', async () => {
    await expect(roleAllowsTimesheet(makeReq('manager'), 'edit')).resolves.toBe(true);
    expect(h.rolePage).not.toHaveBeenCalled();
  });

  it('роль — по эффективной галочке', async () => {
    setMatrix(true, false);
    await expect(roleAllowsTimesheet(makeReq(), 'view')).resolves.toBe(true);
    await expect(roleAllowsTimesheet(makeReq(), 'edit')).resolves.toBe(false);
  });
});

describe('скоуп табеля роли', () => {
  it('с «Табель → просмотр» — отдел', async () => {
    await expect(resolveTimesheetScope(makeReq())).resolves.toBe('department');
  });

  it('без просмотра — только себя, даже при прямых подчинённых и назначении deputy', async () => {
    setMatrix(false, false);
    h.directSubs.mockResolvedValue([SUBORDINATE]);
    await expect(resolveTimesheetScope(makeReq())).resolves.toBe('self');
  });

  it('назначение deputy не заменяет матрицу роли', async () => {
    setMatrix(false, false);
    await expect(hasManagedTimesheetAccess(makeReq(), 'view')).resolves.toBe(false);
  });
});

describe('запись табеля роли', () => {
  it('с правкой — коллега отдела доступен', async () => {
    await expect(canAccessEmployeeForTimesheetPeriod(makeReq(), COLLEAGUE, '2026-09-01', '2026-09-30', true))
      .resolves.toBe(true);
  });

  it('без правки — только своя строка: ни коллега, ни прямой подчинённый', async () => {
    setMatrix(true, false);
    h.directSubs.mockResolvedValue([SUBORDINATE]);
    const req = makeReq();
    await expect(canAccessEmployeeForTimesheetPeriod(req, COLLEAGUE, '2026-09-01', '2026-09-30', true)).resolves.toBe(false);
    await expect(canAccessEmployeeForTimesheetPeriod(req, SUBORDINATE, '2026-09-01', '2026-09-30', true)).resolves.toBe(false);
    await expect(canAccessEmployeeForTimesheetPeriod(req, SELF, '2026-09-01', '2026-09-30', true)).resolves.toBe(true);
    // Просмотр при этом остаётся.
    await expect(canAccessEmployeeForTimesheetPeriod(req, COLLEAGUE, '2026-09-01', '2026-09-30', false)).resolves.toBe(true);
  });
});
