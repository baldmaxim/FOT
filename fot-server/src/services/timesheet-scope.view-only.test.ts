import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * «Просмотр табеля» (миграция 309) в скоупе табеля: список смотрящего даёт псевдо-ячейку
 * 'department' (как прямые подчинённые) и доступ к этим людям только на чтение.
 */

const { h } = vi.hoisted(() => ({
  h: {
    rolePage: vi.fn(async (_req: unknown, _page: string, _action: string) => true),
    pageView: vi.fn(async (_role: string, _page: string) => true),
    objectViewScope: vi.fn(async () => false),
    accessibleEmployees: vi.fn(async () => new Set<number>()),
    managed: vi.fn(async () => [] as string[]),
    viewOnly: vi.fn(async () => new Set<number>()),
  },
}));

vi.mock('./access-control.service.js', () => ({
  resolveRolePageAccess: h.rolePage,
  hasPageView: h.pageView,
  hasPageEdit: h.pageView,
}));
vi.mock('./data-scope.service.js', () => ({
  hasAllDepartmentsScope: vi.fn(async () => false),
  hasGlobalDepartmentReadScope: vi.fn(async () => false),
  hasObjectViewScope: h.objectViewScope,
  normalizeUuidParam: (v: unknown) => (typeof v === 'string' && v ? v : null),
  resolveAccessibleDepartmentIds: vi.fn(async () => []),
  resolveAccessibleEmployeeIds: h.accessibleEmployees,
  hasDeputyAssignment: vi.fn(async () => false),
  resolveTimesheetEditableDepartmentIds: vi.fn(async () => []),
  resolveEffectiveDirectSubordinates: vi.fn(async () => []),
  resolveManagedDepartmentIds: h.managed,
  resolveScopedDepartmentId: vi.fn(async () => null),
}));
vi.mock('./timekeeper-scope.service.js', () => ({
  isTimekeeper: () => false,
  resolveTimekeeperEditableLiIds: vi.fn(async () => new Set<number>()),
  LI_OBSHESTROY_DEPARTMENT_ID: 'li-dept',
}));
vi.mock('./timesheet-department-assignments.service.js', () => ({
  listEmployeeIdsAssignedToDepartmentPeriod: vi.fn(async () => []),
}));
vi.mock('./direct-report-coverage.service.js', () => ({
  splitDirectReportsByCoverage: vi.fn(async () => ({ owned: [], partiallyCovered: [], fullyCovered: [] })),
}));
vi.mock('./employee-timesheet-view-access.service.js', () => ({
  resolveTimesheetViewOnlyEmployeeIds: h.viewOnly,
}));
vi.mock('../config/postgres.js', () => ({ query: vi.fn(async () => []) }));

const VIEWER = 2562;
const WATCHED = 1361;
const STRANGER = 9999;

const { resolveTimesheetScope, canAccessEmployeeForTimesheetPeriod } = await import('./timesheet-scope.service.js');

const makeReq = (roleCode = 'manager_obj'): AuthenticatedRequest => ({
  user: { id: 'u-viewer', employee_id: VIEWER, role_code: roleCode, is_admin: false, department_id: null },
} as unknown as AuthenticatedRequest);

beforeEach(() => {
  vi.clearAllMocks();
  h.rolePage.mockResolvedValue(true);
  h.pageView.mockResolvedValue(true);
  h.objectViewScope.mockResolvedValue(false);
  h.accessibleEmployees.mockResolvedValue(new Set<number>());
  h.managed.mockResolvedValue([]);
  h.viewOnly.mockResolvedValue(new Set([WATCHED]));
});

describe('resolveTimesheetScope — «Просмотр табеля»', () => {
  it("есть люди в списке и роль с табелем → 'department' (грид «Мои сотрудники»)", async () => {
    expect(await resolveTimesheetScope(makeReq())).toBe('department');
  });

  it("список пуст → 'self', как раньше", async () => {
    h.viewOnly.mockResolvedValue(new Set());
    expect(await resolveTimesheetScope(makeReq())).toBe('self');
  });

  it("роль без табеля → 'self': назначение страницу не выдаёт", async () => {
    h.pageView.mockResolvedValue(false);
    expect(await resolveTimesheetScope(makeReq())).toBe('self');
  });

  it("«Заместитель» без галочки «Табель → просмотр» → 'self' даже со списком", async () => {
    h.rolePage.mockResolvedValue(false);
    expect(await resolveTimesheetScope(makeReq('deputy_head'))).toBe('self');
  });
});

describe('canAccessEmployeeForTimesheetPeriod — «Просмотр табеля»', () => {
  it('человек из списка: чтение — да', async () => {
    expect(await canAccessEmployeeForTimesheetPeriod(makeReq(), WATCHED, '2026-10-01', '2026-10-15')).toBe(true);
  });

  it('человек из списка: запись — нет', async () => {
    expect(await canAccessEmployeeForTimesheetPeriod(makeReq(), WATCHED, '2026-10-01', '2026-10-15', true)).toBe(false);
  });

  it('чужой — нет', async () => {
    expect(await canAccessEmployeeForTimesheetPeriod(makeReq(), STRANGER, '2026-10-01', '2026-10-15')).toBe(false);
  });

  it('объектный view-скоуп руководителя с отделами не отрезает человека из списка', async () => {
    h.managed.mockResolvedValue(['dept-a']);
    h.objectViewScope.mockResolvedValue(true);
    h.accessibleEmployees.mockResolvedValue(new Set([42]));
    expect(await canAccessEmployeeForTimesheetPeriod(makeReq(), WATCHED, '2026-10-01', '2026-10-15')).toBe(true);
    expect(await canAccessEmployeeForTimesheetPeriod(makeReq(), STRANGER, '2026-10-01', '2026-10-15')).toBe(false);
  });
});
