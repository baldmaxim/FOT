import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * filterEmployeeIdsInScope — пакетная canAccessEmployeeInScope: на матрице ролей пропускает ровно тех же
 * сотрудников, что поштучная проверка, а отделы сотрудников читает одним запросом.
 */

const { h } = vi.hoisted(() => ({
  h: {
    explicit: vi.fn(async () => [] as string[]),
    accessMap: vi.fn(async (ids: number[]) => new Map<number, string[]>(ids.map(id => [id, [] as string[]]))),
    timekeeper: { value: false },
    timekeeperSeeds: vi.fn(async () => [] as string[]),
    timekeeperDirect: vi.fn(async () => new Set<number>()),
    directSubs: vi.fn(async () => [] as number[]),
  },
}));

vi.mock('../config/postgres.js', () => ({ query: vi.fn(async () => []) }));
vi.mock('../config/db-instrumentation.js', () => ({ withDbSlot: (fn: () => unknown) => fn() }));
vi.mock('./department-access.service.js', () => ({
  hasActiveDeputyAssignment: vi.fn(async () => false),
  listDeputyDepartmentIdsForUser: vi.fn(async () => []),
  listEditableDepartmentIdsForUser: vi.fn(async () => []),
  listExplicitDepartmentIdsForUser: h.explicit,
  listNonDeputyDepartmentIdsForUser: vi.fn(async () => []),
  loadEmployeeAccessMap: h.accessMap,
}));
vi.mock('./employee-skud-object-access.service.js', () => ({ listObjectIdsForEmployee: vi.fn(async () => []) }));
vi.mock('./employee-direct-reports.service.js', () => ({ listDirectSubordinates: h.directSubs }));
vi.mock('./direct-report-coverage.service.js', () => ({ splitDirectReportsByCoverage: vi.fn() }));
vi.mock('./timekeeper-scope.service.js', () => ({
  isTimekeeper: () => h.timekeeper.value,
  resolveTimekeeperDepartmentSeeds: h.timekeeperSeeds,
  resolveTimekeeperDirectEmployeeIds: h.timekeeperDirect,
}));
vi.mock('./roles-cache.service.js', () => ({ getRoleByCode: vi.fn(async () => null) }));
vi.mock('./deputy-role.service.js', () => ({
  isDeputyRole: () => false,
  resolveDeputyHeadDepartmentIds: vi.fn(async () => []),
}));

const { canAccessEmployeeInScope, filterEmployeeIdsInScope } = await import('./data-scope.service.js');

const SELF = 1;
const IN_FULL = 2; // отдел d1 — редактируемый
const IN_VIEW_ON_OBJECTS = 3; // отдел d2 — только просмотр, на объектах руководителя
const IN_VIEW_OFF_OBJECTS = 4; // отдел d2, не на объектах
const STRANGER = 5; // чужой отдел
const NO_DEPT = 6;
const SUBORDINATE = 7; // прямой подчинённый из чужого отдела
const TIMEKEEPER_DIRECT = 8;
const IDS = [SELF, IN_FULL, IN_VIEW_ON_OBJECTS, IN_VIEW_OFF_OBJECTS, STRANGER, NO_DEPT, SUBORDINATE, TIMEKEEPER_DIRECT, 0];

const DEPARTMENTS = new Map<number, string[]>([
  [SELF, ['d1']], [IN_FULL, ['d1']], [IN_VIEW_ON_OBJECTS, ['d2']], [IN_VIEW_OFF_OBJECTS, ['d2']],
  [STRANGER, ['d9']], [NO_DEPT, []], [SUBORDINATE, ['d9']], [TIMEKEEPER_DIRECT, ['d8']],
]);

interface IReqOptions {
  roleCode?: string;
  accessible?: string[] | null; // null — без явных отделов
  editable?: string[];
  objectEmployees?: number[];
}

/** Роль задаётся кэшами скоупа на req.user — как их заполняет data-scope за один запрос. */
const makeReq = ({ roleCode = 'manager', accessible = null, editable = [], objectEmployees = [] }: IReqOptions) => ({
  user: {
    id: 'u-1',
    employee_id: SELF,
    role_code: roleCode,
    is_admin: false,
    __all_departments_scope: false,
    ...(accessible ? { __manager_subtree_ids: accessible } : {}),
    __editable_subtree_ids: editable,
    __manager_object_employee_ids: new Set(objectEmployees),
  },
}) as unknown as AuthenticatedRequest;

beforeEach(() => {
  vi.clearAllMocks();
  h.timekeeper.value = false;
  h.explicit.mockResolvedValue([]);
  h.accessMap.mockImplementation(async (ids: number[]) => new Map(ids.map(id => [id, DEPARTMENTS.get(id) ?? []])));
  h.timekeeperSeeds.mockResolvedValue([]);
  h.timekeeperDirect.mockResolvedValue(new Set([TIMEKEEPER_DIRECT]));
  h.directSubs.mockResolvedValue([]);
});

const expectParity = async (options: IReqOptions): Promise<number[]> => {
  const expected: number[] = [];
  const perEmployeeReq = makeReq(options);
  for (const id of IDS) {
    if (await canAccessEmployeeInScope(perEmployeeReq, id)) expected.push(id);
  }
  h.accessMap.mockClear();
  const batch = await filterEmployeeIdsInScope(makeReq(options), IDS);
  expect(batch).toEqual(expected);
  return batch;
};

describe('filterEmployeeIdsInScope = поштучная canAccessEmployeeInScope', () => {
  it('hr — вся организация', async () => {
    expect(await expectParity({ roleCode: 'hr' })).toEqual(IDS.filter(Boolean));
  });

  it('руководитель: полный отдел целиком, view-отдел — только люди на его объектах; сам и подчинённые', async () => {
    h.explicit.mockResolvedValue(['d1', 'd2']);
    h.directSubs.mockResolvedValue([SUBORDINATE]);
    const options = { accessible: ['d1', 'd2'], editable: ['d1'], objectEmployees: [IN_VIEW_ON_OBJECTS] };
    expect(await expectParity(options)).toEqual([SELF, IN_FULL, IN_VIEW_ON_OBJECTS, SUBORDINATE]);
    // Отделы сотрудников — одним запросом на весь список.
    expect(h.accessMap).toHaveBeenCalledTimes(1);
  });

  it('view-отдел без объектов у руководителя — виден целиком', async () => {
    h.explicit.mockResolvedValue(['d1', 'd2']);
    expect(await expectParity({ accessible: ['d1', 'd2'], editable: ['d1'] }))
      .toEqual([SELF, IN_FULL, IN_VIEW_ON_OBJECTS, IN_VIEW_OFF_OBJECTS]);
  });

  it('табельщица — плюс сотрудники её объектов', async () => {
    h.timekeeper.value = true;
    h.timekeeperSeeds.mockResolvedValue(['d1']);
    expect(await expectParity({ roleCode: 'timekeeper', accessible: ['d1'] }))
      .toEqual([SELF, IN_FULL, TIMEKEEPER_DIRECT]);
  });

  it('без отделов — только сам и прямые подчинённые', async () => {
    h.directSubs.mockResolvedValue([SUBORDINATE]);
    expect(await expectParity({})).toEqual([SELF, SUBORDINATE]);
  });
});
