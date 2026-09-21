import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Скоупы уровня «заместитель» (миграция 283).
 *
 * Табельный скоуп расширяется deputy-отделами, а согласовательный (editable) и
 * нетабельный write-скоуп — нет: заместитель ведёт табель, но не кадры.
 */

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));
vi.mock('../config/postgres.js', () => ({ query: pgQuery }));
vi.mock('../config/db-instrumentation.js', () => ({
  withDbSlot: async (_tag: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@sentry/node', () => ({ captureMessage: vi.fn() }));

const { accessMocks } = vi.hoisted(() => ({
  accessMocks: {
    explicit: vi.fn(async () => [] as string[]),
    editable: vi.fn(async () => [] as string[]),
    deputy: vi.fn(async () => [] as string[]),
    nonDeputy: vi.fn(async () => [] as string[]),
    employeeAccess: vi.fn(async () => new Map<number, string[]>()),
  },
}));
vi.mock('./department-access.service.js', () => ({
  listExplicitDepartmentIdsForUser: accessMocks.explicit,
  listEditableDepartmentIdsForUser: accessMocks.editable,
  listDeputyDepartmentIdsForUser: accessMocks.deputy,
  listNonDeputyDepartmentIdsForUser: accessMocks.nonDeputy,
  loadEmployeeAccessMap: accessMocks.employeeAccess,
  hasActiveDeputyAssignment: async (employeeId?: number | null) =>
    employeeId != null && (await accessMocks.deputy()).length > 0,
}));
vi.mock('./employee-skud-object-access.service.js', () => ({
  listObjectIdsForEmployee: vi.fn(async () => [] as string[]),
}));
vi.mock('./employee-direct-reports.service.js', () => ({
  listDirectSubordinates: vi.fn(async () => [] as number[]),
}));
vi.mock('./direct-report-coverage.service.js', () => ({
  splitDirectReportsByCoverage: vi.fn(async () => ({ owned: [], partiallyCovered: [], fullyCovered: [] })),
}));
vi.mock('./timekeeper-scope.service.js', () => ({
  isTimekeeper: () => false,
  resolveTimekeeperDepartmentSeeds: vi.fn(async () => [] as string[]),
  resolveTimekeeperDirectEmployeeIds: vi.fn(async () => new Set<number>()),
  expandTimekeeperAccessibleDepartmentIds: vi.fn(async () => [] as string[]),
  LI_OBSHESTROY_DEPARTMENT_ID: 'li-dept',
}));
vi.mock('./roles-cache.service.js', () => ({
  getRoleByCode: vi.fn(async () => ({ code: 'security', view_all_departments: false, all_departments_scope: false })),
  getRoleById: vi.fn(async () => null),
}));

const {
  canEditEmployeeInScope,
  canEditEmployeeTimesheetInScope,
  canWriteEmployeeInScope,
  resolveTimesheetEditableDepartmentIds,
} = await import('./data-scope.service.js');

const HEAD_DEPT = 'aaaaaaaa-0000-4000-8000-000000000001';
const DEPUTY_DEPT = 'bbbbbbbb-0000-4000-8000-000000000002';
const DEPUTY_CHILD = 'cccccccc-0000-4000-8000-000000000003';
const EMP_IN_DEPUTY_DEPT = 4242;

const makeReq = (): AuthenticatedRequest => ({
  user: {
    id: 'u-1',
    employee_id: 441,
    role_code: 'security',
    is_admin: false,
    department_id: null,
  },
} as unknown as AuthenticatedRequest);

beforeEach(() => {
  vi.clearAllMocks();
  accessMocks.explicit.mockResolvedValue([DEPUTY_DEPT]);
  accessMocks.editable.mockResolvedValue([]);
  accessMocks.deputy.mockResolvedValue([DEPUTY_DEPT]);
  accessMocks.nonDeputy.mockResolvedValue([]);
  accessMocks.employeeAccess.mockResolvedValue(new Map([[EMP_IN_DEPUTY_DEPT, [DEPUTY_DEPT]]]));
  // Раскрытие поддерева: у deputy-отдела одна дочерняя бригада.
  pgQuery.mockResolvedValue([{ id: DEPUTY_CHILD }]);
});

describe('табельный скоуп заместителя', () => {
  it('включает deputy-отдел и его поддерево', async () => {
    const departments = await resolveTimesheetEditableDepartmentIds(makeReq());

    expect(departments).not.toBe('all');
    expect(departments as string[]).toEqual(expect.arrayContaining([DEPUTY_DEPT, DEPUTY_CHILD]));
  });

  it('правка табеля сотрудника deputy-отдела разрешена', async () => {
    await expect(canEditEmployeeTimesheetInScope(makeReq(), EMP_IN_DEPUTY_DEPT)).resolves.toBe(true);
  });

  it('согласовательный скоуп (editable) deputy-отдел не включает', async () => {
    await expect(canEditEmployeeInScope(makeReq(), EMP_IN_DEPUTY_DEPT)).resolves.toBe(false);
  });

  it('нетабельная запись по сотруднику deputy-отдела запрещена', async () => {
    await expect(canWriteEmployeeInScope(makeReq(), EMP_IN_DEPUTY_DEPT)).resolves.toBe(false);
  });
});

describe('без назначения «заместитель» поведение прежнее', () => {
  beforeEach(() => {
    accessMocks.deputy.mockResolvedValue([]);
    accessMocks.explicit.mockResolvedValue([HEAD_DEPT]);
    accessMocks.editable.mockResolvedValue([HEAD_DEPT]);
    accessMocks.nonDeputy.mockResolvedValue([HEAD_DEPT]);
    accessMocks.employeeAccess.mockResolvedValue(new Map([[EMP_IN_DEPUTY_DEPT, [HEAD_DEPT]]]));
    pgQuery.mockResolvedValue([]);
  });

  it('начальник отдела: и табель, и кадровая запись разрешены', async () => {
    const req = makeReq();
    await expect(canEditEmployeeTimesheetInScope(req, EMP_IN_DEPUTY_DEPT)).resolves.toBe(true);
    await expect(canWriteEmployeeInScope(makeReq(), EMP_IN_DEPUTY_DEPT)).resolves.toBe(true);
  });
});
