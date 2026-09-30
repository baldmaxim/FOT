import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Скоупы роли «Заместитель» (deputy_head, миграция 292).
 *
 * Заместительские отделы роли (свой по роли + ручные deputy, правило А) приходят из
 * deputy-role.service и НЕ раскрываются поддеревом. Нетабельную запись и чужие карточки
 * открывает только назначение «Начальник» (full); ручной view ограничения роли не снимает.
 * Отдел роли не считается view-отделом и не режется по объектам СКУД заместителя.
 */

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));
vi.mock('../config/postgres.js', () => ({ query: pgQuery }));
vi.mock('../config/db-instrumentation.js', () => ({
  withDbSlot: async (_tag: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@sentry/node', () => ({ captureMessage: vi.fn() }));

const { accessMocks, deputyHead, objects } = vi.hoisted(() => ({
  accessMocks: {
    explicit: vi.fn(async () => [] as string[]),
    editable: vi.fn(async () => [] as string[]),
    deputy: vi.fn(async () => [] as string[]),
    nonDeputy: vi.fn(async () => [] as string[]),
    employeeAccess: vi.fn(async () => new Map<number, string[]>()),
  },
  deputyHead: vi.fn(async () => [] as string[]),
  objects: vi.fn(async () => [] as string[]),
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
vi.mock('./deputy-role.service.js', () => ({
  isDeputyRole: (code: string | null | undefined) => code === 'deputy_head',
  resolveDeputyHeadDepartmentIds: async (req: AuthenticatedRequest) =>
    (req.user.role_code === 'deputy_head' ? deputyHead() : []),
}));
vi.mock('./employee-skud-object-access.service.js', () => ({
  listObjectIdsForEmployee: objects,
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
  getRoleByCode: vi.fn(async (code: string) => ({ code, view_all_departments: false, all_departments_scope: false })),
  getRoleById: vi.fn(async () => null),
}));

const {
  canAccessEmployeeInScope,
  canAccessEmployeeRecordsInScope,
  canWriteEmployeeInScope,
  hasObjectViewScope,
  resolveAccessibleDepartmentIds,
  resolveAccessibleEmployeeIds,
  resolveTimesheetEditableDepartmentIds,
} = await import('./data-scope.service.js');

const ROLE_DEPT = 'aaaaaaaa-0000-4000-8000-000000000001';
const MANUAL_DEPUTY_DEPT = 'bbbbbbbb-0000-4000-8000-000000000002';
const FULL_DEPT = 'cccccccc-0000-4000-8000-000000000003';
const FULL_CHILD = 'dddddddd-0000-4000-8000-000000000004';
const VIEW_DEPT = 'eeeeeeee-0000-4000-8000-000000000005';
const SELF = 441;
const COLLEAGUE_ROLE_DEPT = 501;
const COLLEAGUE_ROLE_DEPT_OFF_OBJECT = 502;
const EMP_FULL_DEPT = 601;
const EMP_VIEW_DEPT = 701;

const makeReq = (roleCode = 'deputy_head'): AuthenticatedRequest => ({
  user: {
    id: 'u-1',
    employee_id: SELF,
    role_code: roleCode,
    is_admin: false,
    department_id: null,
  },
} as unknown as AuthenticatedRequest);

/** Имитация БД: поддерево full-отдела и членство отделов. */
const membersByDept = new Map<string, number[]>([
  [ROLE_DEPT, [COLLEAGUE_ROLE_DEPT, COLLEAGUE_ROLE_DEPT_OFF_OBJECT]],
  [FULL_DEPT, [EMP_FULL_DEPT]],
  [VIEW_DEPT, [EMP_VIEW_DEPT]],
]);

beforeEach(() => {
  vi.clearAllMocks();
  accessMocks.explicit.mockResolvedValue([]);
  accessMocks.editable.mockResolvedValue([]);
  accessMocks.deputy.mockResolvedValue([]);
  accessMocks.nonDeputy.mockResolvedValue([]);
  accessMocks.employeeAccess.mockImplementation(async (ids?: number[]) => {
    const map = new Map<number, string[]>();
    for (const id of ids ?? []) {
      for (const [dept, members] of membersByDept) {
        if (members.includes(id)) map.set(id, [...(map.get(id) ?? []), dept]);
      }
    }
    return map;
  });
  deputyHead.mockResolvedValue([ROLE_DEPT, MANUAL_DEPUTY_DEPT]);
  objects.mockResolvedValue([]);
  pgQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('get_descendant_department_ids')) {
      const roots = params[0] as string[];
      return roots.includes(FULL_DEPT) ? [{ id: FULL_DEPT }, { id: FULL_CHILD }] : roots.map(id => ({ id }));
    }
    if (sql.includes('employee_skud_object_access')) {
      return [{ employee_id: COLLEAGUE_ROLE_DEPT }];
    }
    if (sql.includes('FROM employee_department_access')) {
      const depts = params[0] as string[];
      return depts.flatMap(dept => (membersByDept.get(dept) ?? []).map(employee_id => ({ employee_id })));
    }
    return [];
  });
});

describe('видимый скоуп роли', () => {
  it('без ручных назначений — ровно заместительские отделы, поддерево не раскрывается', async () => {
    const ids = await resolveAccessibleDepartmentIds(makeReq());
    expect(ids).toEqual([ROLE_DEPT, MANUAL_DEPUTY_DEPT]);
    expect(pgQuery.mock.calls.some(([sql]) => String(sql).includes('get_descendant_department_ids'))).toBe(false);
    // Ручные deputy приходят только через правило А — общий listExplicit роль не читает.
    expect(accessMocks.explicit).not.toHaveBeenCalled();
  });

  it('ручные full/view раскрываются поддеревом, отделы роли — нет', async () => {
    accessMocks.nonDeputy.mockResolvedValue([FULL_DEPT]);
    const ids = await resolveAccessibleDepartmentIds(makeReq());
    expect(new Set(ids as string[])).toEqual(new Set([FULL_DEPT, FULL_CHILD, ROLE_DEPT, MANUAL_DEPUTY_DEPT]));
    const rpcRoots = pgQuery.mock.calls
      .filter(([sql]) => String(sql).includes('get_descendant_department_ids'))
      .map(([, params]) => (params as unknown[])[0]);
    expect(rpcRoots).toEqual([[FULL_DEPT]]);
  });

  it('отдел роли не прошёл правило А — остаётся только допустимый ручной', async () => {
    deputyHead.mockResolvedValue([MANUAL_DEPUTY_DEPT]);
    expect(await resolveAccessibleDepartmentIds(makeReq())).toEqual([MANUAL_DEPUTY_DEPT]);
  });

  it('для других ролей поведение прежнее: явные назначения, резолвер роли пуст', async () => {
    accessMocks.explicit.mockResolvedValue([VIEW_DEPT]);
    const ids = await resolveAccessibleDepartmentIds(makeReq('office'));
    expect(ids).toEqual([VIEW_DEPT]);
    expect(deputyHead).not.toHaveBeenCalled();
  });
});

describe('табельный скоуп роли', () => {
  it('full (с поддеревом) ∪ заместительские отделы без поддерева', async () => {
    accessMocks.editable.mockResolvedValue([FULL_DEPT]);
    accessMocks.nonDeputy.mockResolvedValue([FULL_DEPT]);
    const ids = await resolveTimesheetEditableDepartmentIds(makeReq());
    expect(new Set(ids as string[])).toEqual(new Set([FULL_DEPT, FULL_CHILD, ROLE_DEPT, MANUAL_DEPUTY_DEPT]));
    expect(accessMocks.deputy).not.toHaveBeenCalled();
  });
});

describe('нетабельная запись и карточки — только «Начальник»', () => {
  it('коллега из отдела роли: читать табель можно, писать кадры и карточку — нет', async () => {
    const req = makeReq();
    expect(await canAccessEmployeeInScope(req, COLLEAGUE_ROLE_DEPT)).toBe(true);
    expect(await canWriteEmployeeInScope(req, COLLEAGUE_ROLE_DEPT)).toBe(false);
    expect(await canAccessEmployeeRecordsInScope(req, COLLEAGUE_ROLE_DEPT)).toBe(false);
  });

  it('свой — всегда', async () => {
    expect(await canAccessEmployeeRecordsInScope(makeReq(), SELF)).toBe(true);
  });

  it('ручной full главнее роли: в отделе «Начальника» запись и карточки открыты', async () => {
    accessMocks.editable.mockResolvedValue([FULL_DEPT]);
    accessMocks.nonDeputy.mockResolvedValue([FULL_DEPT]);
    const req = makeReq();
    expect(await canWriteEmployeeInScope(req, EMP_FULL_DEPT)).toBe(true);
    expect(await canAccessEmployeeRecordsInScope(req, EMP_FULL_DEPT)).toBe(true);
  });

  it('ручной view, совпавший с отделом роли, ограничений роли не снимает', async () => {
    accessMocks.nonDeputy.mockResolvedValue([ROLE_DEPT]);
    const req = makeReq();
    expect(await canWriteEmployeeInScope(req, COLLEAGUE_ROLE_DEPT)).toBe(false);
    expect(await canAccessEmployeeRecordsInScope(req, COLLEAGUE_ROLE_DEPT)).toBe(false);
  });

  it('ручной view на другой отдел тоже не даёт записи роли', async () => {
    accessMocks.nonDeputy.mockResolvedValue([VIEW_DEPT]);
    expect(await canWriteEmployeeInScope(makeReq(), EMP_VIEW_DEPT)).toBe(false);
  });

  it('для других ролей карточки — прежний read-скоуп', async () => {
    accessMocks.explicit.mockResolvedValue([VIEW_DEPT]);
    const req = makeReq('security');
    expect(await canAccessEmployeeRecordsInScope(req, EMP_VIEW_DEPT))
      .toBe(await canAccessEmployeeInScope(makeReq('security'), EMP_VIEW_DEPT));
  });
});

describe('объекты СКУД заместителя отдел роли не режут', () => {
  it('только отдел роли + свои объекты — объектного view-скоупа нет, видны все', async () => {
    objects.mockResolvedValue(['obj-1']);
    deputyHead.mockResolvedValue([ROLE_DEPT]);
    const req = makeReq();
    expect(await hasObjectViewScope(req)).toBe(false);
    const visible = await resolveAccessibleEmployeeIds(req);
    expect(visible).not.toBe('all');
    expect((visible as Set<number>).has(COLLEAGUE_ROLE_DEPT_OFF_OBJECT)).toBe(true);
    expect(await canAccessEmployeeInScope(makeReq(), COLLEAGUE_ROLE_DEPT_OFF_OBJECT)).toBe(true);
  });

  it('ручной view по-прежнему режется по объектам', async () => {
    objects.mockResolvedValue(['obj-1']);
    accessMocks.nonDeputy.mockResolvedValue([VIEW_DEPT]);
    expect(await hasObjectViewScope(makeReq())).toBe(true);
  });
});
