import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Проводка viewerEmployeeId в скоуп прямых подчинённых.
 *
 * Руководитель, который сам владеет табелем своего отдела, не должен терять право
 * на собственных прямых подчинённых: до фикса покрытие отбирало правку в пользу
 * него же. Скоуп общий, поэтому здесь же фиксируем принятый побочный эффект —
 * те же люди снова доступны и в нетабельной записи (заявления, условия оплаты).
 */

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));
vi.mock('../config/postgres.js', () => ({ query: pgQuery }));
vi.mock('../config/db-instrumentation.js', () => ({
  withDbSlot: async (_tag: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@sentry/node', () => ({ captureMessage: vi.fn() }));

const { directReportMocks } = vi.hoisted(() => ({
  directReportMocks: {
    list: vi.fn(async () => [] as number[]),
    split: vi.fn(async () => ({
      owned: [] as number[], partiallyCovered: [] as number[], fullyCovered: [] as number[],
      coveredDates: new Map<number, string[]>(),
    })),
  },
}));

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
  listDirectSubordinates: directReportMocks.list,
}));
vi.mock('./direct-report-coverage.service.js', () => ({
  splitDirectReportsByCoverage: directReportMocks.split,
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
  resolveEditableDirectSubordinates,
} = await import('./data-scope.service.js');

const OWN_DEPT = 'aaaaaaaa-0000-4000-8000-00000000000a';
const VIEWER = 900;
const SUB = 4242;

const makeReq = (): AuthenticatedRequest => ({
  user: {
    id: 'u-manager',
    employee_id: VIEWER,
    role_code: 'site_supervisor',
    is_admin: false,
    department_id: null,
  },
} as unknown as AuthenticatedRequest);

beforeEach(() => {
  vi.clearAllMocks();
  accessMocks.explicit.mockResolvedValue([OWN_DEPT]);
  accessMocks.editable.mockResolvedValue([]);
  accessMocks.deputy.mockResolvedValue([]);
  accessMocks.nonDeputy.mockResolvedValue([]);
  accessMocks.employeeAccess.mockResolvedValue(new Map([[SUB, [OWN_DEPT]]]));
  directReportMocks.list.mockResolvedValue([SUB]);
  directReportMocks.split.mockResolvedValue({
    owned: [SUB], partiallyCovered: [], fullyCovered: [], coveredDates: new Map(),
  });
  pgQuery.mockResolvedValue([]);
});

describe('resolveEditableDirectSubordinates — проводка viewerEmployeeId', () => {
  it('пятым аргументом уходит employee_id пользователя (четвёртый — exec)', async () => {
    const editable = await resolveEditableDirectSubordinates(makeReq());

    expect(editable).toEqual([SUB]);
    const call = directReportMocks.split.mock.calls[0];
    expect(call?.[0]).toEqual([SUB]);
    expect(call?.[3]).toBeUndefined();
    expect(call?.[4]).toBe(VIEWER);
  });

  it('у пользователя нет employee_id → в покрытие уходит undefined, а не null', async () => {
    const req = makeReq();
    (req.user as { employee_id: number | null }).employee_id = null;

    await resolveEditableDirectSubordinates(req);

    // employee_id=null отсекается раньше (подчинённых не ищем), покрытие не зовём.
    expect(directReportMocks.split).not.toHaveBeenCalled();
  });

  it('принятый побочный эффект: нетабельная запись по такому подчинённому разрешена', async () => {
    await expect(canEditEmployeeInScope(makeReq(), SUB)).resolves.toBe(true);
  });
});
