import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * filterEmployeeIdsForTimesheetView — пакетная canAccessEmployeeForTimesheetPeriod(requireEdit = false):
 * на матрице ролей пропускает ровно тех же сотрудников, что поштучная проверка.
 */

const { h } = vi.hoisted(() => ({
  h: {
    rolePage: vi.fn(async (_req: unknown, _page: string, _action: string) => true),
    pageView: vi.fn(async (_role: string, _page: string) => true),
    allDepartmentsScope: vi.fn(async () => false),
    globalRead: vi.fn(async () => false),
    objectViewScope: vi.fn(async () => false),
    accessibleDepartments: vi.fn(async (): Promise<string[] | 'all'> => []),
    accessibleEmployees: vi.fn(async (): Promise<Set<number> | 'all'> => new Set<number>()),
    managed: vi.fn(async () => [] as string[]),
    directSubs: vi.fn(async () => [] as number[]),
    viewOnly: vi.fn(async () => new Set<number>()),
    departmentMembers: vi.fn(async (
      _departmentId: string, _start: string, _end: string, _options?: { firedInDismissalMonth?: boolean },
    ) => [] as number[]),
  },
}));

vi.mock('./access-control.service.js', () => ({
  resolveRolePageAccess: h.rolePage,
  hasPageView: h.pageView,
  hasPageEdit: h.pageView,
}));
vi.mock('./data-scope.service.js', () => ({
  hasAllDepartmentsScope: h.allDepartmentsScope,
  hasGlobalDepartmentReadScope: h.globalRead,
  hasObjectViewScope: h.objectViewScope,
  normalizeUuidParam: (v: unknown) => (typeof v === 'string' && v ? v : null),
  resolveAccessibleDepartmentIds: h.accessibleDepartments,
  resolveAccessibleEmployeeIds: h.accessibleEmployees,
  hasDeputyAssignment: vi.fn(async () => false),
  resolveTimesheetEditableDepartmentIds: vi.fn(async () => []),
  resolveEffectiveDirectSubordinates: h.directSubs,
  resolveManagedDepartmentIds: h.managed,
  resolveScopedDepartmentId: vi.fn(async () => null),
}));
vi.mock('./timekeeper-scope.service.js', () => ({
  isTimekeeper: () => false,
  resolveTimekeeperEditableLiIds: vi.fn(async () => new Set<number>()),
  LI_OBSHESTROY_DEPARTMENT_ID: 'li-dept',
}));
vi.mock('./timesheet-department-assignments.service.js', () => ({
  listEmployeeIdsAssignedToDepartmentPeriod: h.departmentMembers,
}));
vi.mock('./direct-report-coverage.service.js', () => ({
  splitDirectReportsByCoverage: vi.fn(async () => ({ owned: [], partiallyCovered: [], fullyCovered: [] })),
}));
vi.mock('./employee-timesheet-view-access.service.js', () => ({
  resolveTimesheetViewOnlyEmployeeIds: h.viewOnly,
}));
vi.mock('../config/postgres.js', () => ({ query: vi.fn(async () => []) }));

const { canAccessEmployeeForTimesheetPeriod, filterEmployeeIdsForTimesheetView } = await import('./timesheet-scope.service.js');

const SELF = 100;
const WATCHED = 101; // «Просмотр табеля»
const IN_DEPT = 102;
const FIRED_IN_MONTH = 103; // в составе отдела только с firedInDismissalMonth
const IN_OBJECTS = 104;
const SUBORDINATE = 105;
const STRANGER = 999;
const IDS = [SELF, WATCHED, IN_DEPT, FIRED_IN_MONTH, IN_OBJECTS, SUBORDINATE, STRANGER, 0];
const FROM = '2026-10-01';
const TO = '2026-10-31';

const makeReq = (isAdmin = false): AuthenticatedRequest => ({
  user: { id: 'u-1', employee_id: SELF, role_code: 'manager', is_admin: isAdmin, department_id: null },
} as unknown as AuthenticatedRequest);

beforeEach(() => {
  vi.clearAllMocks();
  h.rolePage.mockResolvedValue(true);
  h.pageView.mockResolvedValue(true);
  h.allDepartmentsScope.mockResolvedValue(false);
  h.globalRead.mockResolvedValue(false);
  h.objectViewScope.mockResolvedValue(false);
  h.accessibleDepartments.mockResolvedValue([]);
  h.accessibleEmployees.mockResolvedValue(new Set([IN_OBJECTS]));
  h.managed.mockResolvedValue([]);
  h.directSubs.mockResolvedValue([]);
  h.viewOnly.mockResolvedValue(new Set());
  h.departmentMembers.mockImplementation(async (_d, _s, _e, options) =>
    (options?.firedInDismissalMonth ? [IN_DEPT, FIRED_IN_MONTH] : [IN_DEPT]));
});

const expectParity = async (req: AuthenticatedRequest): Promise<number[]> => {
  const expected: number[] = [];
  for (const id of IDS) {
    if (await canAccessEmployeeForTimesheetPeriod(req, id, FROM, TO)) expected.push(id);
  }
  const batch = await filterEmployeeIdsForTimesheetView(req, IDS, FROM, TO);
  expect(batch).toEqual(expected);
  return batch;
};

describe('filterEmployeeIdsForTimesheetView = поштучная проверка просмотра', () => {
  it('админ на всю организацию — все', async () => {
    h.accessibleDepartments.mockResolvedValue('all');
    expect(await expectParity(makeReq(true))).toEqual(IDS.filter(Boolean));
  });

  it('без права на табель — только сам', async () => {
    h.rolePage.mockResolvedValue(false);
    expect(await expectParity(makeReq())).toEqual([SELF]);
  });

  it('руководитель отделов — состав отделов, включая уволенного в месяце увольнения', async () => {
    h.managed.mockResolvedValue(['d1', 'd2']);
    expect(await expectParity(makeReq())).toEqual([SELF, IN_DEPT, FIRED_IN_MONTH]);
  });

  it('отделы + прямые подчинённые + «Просмотр табеля»', async () => {
    h.managed.mockResolvedValue(['d1']);
    h.directSubs.mockResolvedValue([SUBORDINATE]);
    h.viewOnly.mockResolvedValue(new Set([WATCHED]));
    expect(await expectParity(makeReq())).toEqual([SELF, WATCHED, IN_DEPT, FIRED_IN_MONTH, SUBORDINATE]);
  });

  it('глобальный просмотр (hr / флаг) — все', async () => {
    h.globalRead.mockResolvedValue(true);
    expect(await expectParity(makeReq())).toEqual(IDS.filter(Boolean));
  });

  it('объектный view-скоуп — видимый набор плюс сам и «Просмотр табеля»', async () => {
    h.managed.mockResolvedValue(['d1']);
    h.objectViewScope.mockResolvedValue(true);
    h.viewOnly.mockResolvedValue(new Set([WATCHED]));
    h.directSubs.mockResolvedValue([SUBORDINATE]);
    expect(await expectParity(makeReq())).toEqual([SELF, WATCHED, IN_OBJECTS]);
  });

  it("объектный view-скоуп с набором 'all' — все", async () => {
    h.managed.mockResolvedValue(['d1']);
    h.objectViewScope.mockResolvedValue(true);
    h.accessibleEmployees.mockResolvedValue('all');
    expect(await expectParity(makeReq())).toEqual(IDS.filter(Boolean));
  });

  it('только прямые подчинённые (псевдо-ячейка)', async () => {
    h.directSubs.mockResolvedValue([SUBORDINATE]);
    expect(await expectParity(makeReq())).toEqual([SELF, SUBORDINATE]);
  });

  it('только «Просмотр табеля»', async () => {
    h.viewOnly.mockResolvedValue(new Set([WATCHED]));
    expect(await expectParity(makeReq())).toEqual([SELF, WATCHED]);
  });

  it('никаких прав на других — только сам', async () => {
    expect(await expectParity(makeReq())).toEqual([SELF]);
  });

  it('состав отделов резолвится один раз на весь список', async () => {
    h.managed.mockResolvedValue(['d1', 'd2']);
    await filterEmployeeIdsForTimesheetView(makeReq(), IDS, FROM, TO);
    expect(h.departmentMembers).toHaveBeenCalledTimes(2);
  });
});
