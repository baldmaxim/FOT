import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pgQuery, pgQueryOne, pgExecute, pgTx } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  pgExecute: vi.fn(),
  pgTx: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: pgExecute,
  withTransaction: pgTx,
}));

vi.mock('../config/db-instrumentation.js', () => ({
  withDbSlot: vi.fn((_label: string, fn: () => Promise<unknown>) => fn()),
}));

// Также мокаем department-access.service: в тестах нам нужен только admin-путь.
vi.mock('./department-access.service.js', () => ({
  listExplicitDepartmentIdsForUser: vi.fn().mockResolvedValue([]),
  listEditableDepartmentIdsForUser: vi.fn().mockResolvedValue([]),
  loadEmployeeAccessMap: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock('./employee-skud-object-access.service.js', () => ({
  listObjectIdsForEmployee: vi.fn().mockResolvedValue([]),
}));

vi.mock('./employee-direct-reports.service.js', () => ({
  listDirectSubordinates: vi.fn().mockResolvedValue([]),
}));

const mockState = vi.hoisted(() => ({
  /** Записи user_company_access по user_id */
  userCompanyAccess: [] as Array<{ user_id: string; company_root_id: string }>,
  /** Вернёт ids потомков для p_root_ids (включая сами корни). */
  rpcSubtree: new Map<string, string[]>(),
}));

import { canAccessEmployeeInScope, getSelfHistoryLimitForUser, invalidateAccessibleScopeCache, resolveAccessibleDepartmentIds, resolveCompanyScope } from './data-scope.service.js';
import { listExplicitDepartmentIdsForUser, listEditableDepartmentIdsForUser, loadEmployeeAccessMap } from './department-access.service.js';
import { listDirectSubordinates } from './employee-direct-reports.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

function buildReq(overrides: Partial<AuthenticatedRequest['user']> = {}): AuthenticatedRequest {
  return {
    user: {
      id: 'user-1',
      email: 'test@example.com',
      system_role_id: 'role-admin',
      role_code: 'admin',
      is_admin: true,
      employee_variant: null,
      show_actual_hours: false,
      employee_id: null,
      department_id: null,
      is_approved: true,
      two_factor_enabled: false,
      two_factor_verified: true,
      ...overrides,
    },
  } as unknown as AuthenticatedRequest;
}

beforeEach(() => {
  mockState.userCompanyAccess = [];
  mockState.rpcSubtree = new Map();
  pgQuery.mockReset();
  pgQueryOne.mockReset();
  pgExecute.mockReset();
  pgTx.mockReset();
  vi.mocked(listExplicitDepartmentIdsForUser).mockReset().mockResolvedValue([]);
  // Editable-отделы зеркалят явные назначения (в этих тестах нет view-отделов).
  vi.mocked(listEditableDepartmentIdsForUser).mockReset().mockImplementation(
    (...args) => vi.mocked(listExplicitDepartmentIdsForUser)(...args),
  );
  vi.mocked(loadEmployeeAccessMap).mockReset().mockResolvedValue(new Map());
  vi.mocked(listDirectSubordinates).mockReset().mockResolvedValue([]);

  pgQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/FROM user_company_access/i.test(sql)) {
      const userId = String(params[0] ?? '');
      return mockState.userCompanyAccess
        .filter(r => r.user_id === userId)
        .map(({ company_root_id }) => ({ company_root_id }));
    }
    if (/get_descendant_department_ids/i.test(sql)) {
      const roots = (params[0] as string[]) ?? [];
      const ids = new Set<string>();
      for (const root of roots) {
        const subtree = mockState.rpcSubtree.get(root) ?? [root];
        for (const id of subtree) ids.add(id);
      }
      return [...ids].map(id => ({ id }));
    }
    throw new Error(`Unexpected query SQL: ${sql}`);
  });

  invalidateAccessibleScopeCache();
});

describe('resolveCompanyScope', () => {
  it('возвращает roots=[] для не-админа', async () => {
    const req = buildReq({ is_admin: false, role_code: 'manager' });
    const scope = await resolveCompanyScope(req);
    expect(scope).toEqual({ roots: [] });
    expect(req.user.company_scope).toEqual({ roots: [] });
  });

  it("возвращает 'all' для админа без записей в user_company_access", async () => {
    const req = buildReq();
    const scope = await resolveCompanyScope(req);
    expect(scope).toEqual({ roots: 'all' });
  });

  it('возвращает массив корней для админа компании', async () => {
    mockState.userCompanyAccess = [
      { user_id: 'user-1', company_root_id: 'comp-A' },
      { user_id: 'user-1', company_root_id: 'comp-B' },
    ];
    const req = buildReq();
    const scope = await resolveCompanyScope(req);
    expect(scope.roots).toEqual(expect.arrayContaining(['comp-A', 'comp-B']));
  });

  it('кеширует результат в req.user', async () => {
    const req = buildReq();
    const first = await resolveCompanyScope(req);
    const second = await resolveCompanyScope(req);
    expect(second).toBe(first);
  });
});

describe('resolveAccessibleDepartmentIds (для админа)', () => {
  it("системный админ → 'all'", async () => {
    const req = buildReq();
    const result = await resolveAccessibleDepartmentIds(req);
    expect(result).toBe('all');
  });

  it('админ компании → плоский список потомков назначенных корней', async () => {
    mockState.userCompanyAccess = [{ user_id: 'user-1', company_root_id: 'comp-A' }];
    mockState.rpcSubtree.set('comp-A', ['comp-A', 'dept-A1', 'dept-A2']);
    const req = buildReq();
    const result = await resolveAccessibleDepartmentIds(req);
    expect(result).toEqual(['comp-A', 'dept-A1', 'dept-A2']);
  });

  it('админ нескольких компаний → объединение поддеревьев', async () => {
    mockState.userCompanyAccess = [
      { user_id: 'user-1', company_root_id: 'comp-A' },
      { user_id: 'user-1', company_root_id: 'comp-B' },
    ];
    mockState.rpcSubtree.set('comp-A', ['comp-A', 'dept-A1']);
    mockState.rpcSubtree.set('comp-B', ['comp-B', 'dept-B1']);
    const req = buildReq();
    const result = await resolveAccessibleDepartmentIds(req);
    expect(result).toEqual(expect.arrayContaining(['comp-A', 'dept-A1', 'comp-B', 'dept-B1']));
    expect((result as string[]).length).toBe(4);
  });

  it('кеширует subtree-результат в req.user', async () => {
    mockState.userCompanyAccess = [{ user_id: 'user-1', company_root_id: 'comp-A' }];
    mockState.rpcSubtree.set('comp-A', ['comp-A']);
    const req = buildReq();
    await resolveAccessibleDepartmentIds(req);
    expect(req.user.__company_subtree_ids).toEqual(['comp-A']);
    // Меняем мок RPC — повторный вызов не должен его дёргать.
    mockState.rpcSubtree.set('comp-A', ['comp-A', 'extra']);
    const second = await resolveAccessibleDepartmentIds(req);
    expect(second).toEqual(['comp-A']);
  });
});

describe('canAccessEmployeeInScope', () => {
  function buildManagerReq(employeeId = 100): AuthenticatedRequest {
    return buildReq({
      is_admin: false,
      role_code: 'manager_obj',
      employee_id: employeeId,
    });
  }

  it('employeeId == null → false', async () => {
    const req = buildManagerReq();
    expect(await canAccessEmployeeInScope(req, null)).toBe(false);
    expect(await canAccessEmployeeInScope(req, undefined)).toBe(false);
    expect(vi.mocked(listDirectSubordinates)).not.toHaveBeenCalled();
  });

  it('self-доступ: employeeId === req.user.employee_id → true без запросов', async () => {
    const req = buildManagerReq(42);
    expect(await canAccessEmployeeInScope(req, 42)).toBe(true);
    expect(vi.mocked(listExplicitDepartmentIdsForUser)).not.toHaveBeenCalled();
    expect(vi.mocked(listDirectSubordinates)).not.toHaveBeenCalled();
  });

  it("админ ('all') → true без обращения к direct reports", async () => {
    const req = buildReq();
    expect(await canAccessEmployeeInScope(req, 999)).toBe(true);
    expect(vi.mocked(listDirectSubordinates)).not.toHaveBeenCalled();
  });

  it('manager без отделов и без direct reports → false', async () => {
    vi.mocked(listExplicitDepartmentIdsForUser).mockResolvedValue([]);
    vi.mocked(listDirectSubordinates).mockResolvedValue([]);
    const req = buildManagerReq();
    expect(await canAccessEmployeeInScope(req, 555)).toBe(false);
  });

  it('manager_obj без отделов, но с direct report → true (фикс 403 одобрения)', async () => {
    vi.mocked(listExplicitDepartmentIdsForUser).mockResolvedValue([]);
    vi.mocked(listDirectSubordinates).mockResolvedValue([555, 777]);
    const req = buildManagerReq();
    expect(await canAccessEmployeeInScope(req, 555)).toBe(true);
    expect(await canAccessEmployeeInScope(req, 777)).toBe(true);
  });

  it('manager с отделами, employee в чужом отделе и не direct report → false', async () => {
    vi.mocked(listExplicitDepartmentIdsForUser).mockResolvedValue(['dept-A']);
    mockState.rpcSubtree.set('dept-A', ['dept-A']);
    vi.mocked(loadEmployeeAccessMap).mockResolvedValue(new Map([[555, ['dept-FOREIGN']]]));
    vi.mocked(listDirectSubordinates).mockResolvedValue([]);
    const req = buildManagerReq();
    expect(await canAccessEmployeeInScope(req, 555)).toBe(false);
  });

  it('manager с отделами + чужой отдел, но это direct report → true', async () => {
    vi.mocked(listExplicitDepartmentIdsForUser).mockResolvedValue(['dept-A']);
    mockState.rpcSubtree.set('dept-A', ['dept-A']);
    vi.mocked(loadEmployeeAccessMap).mockResolvedValue(new Map([[555, ['dept-FOREIGN']]]));
    vi.mocked(listDirectSubordinates).mockResolvedValue([555]);
    const req = buildManagerReq();
    expect(await canAccessEmployeeInScope(req, 555)).toBe(true);
  });

  it('manager с отделом, employee в назначенном отделе → true', async () => {
    vi.mocked(listExplicitDepartmentIdsForUser).mockResolvedValue(['dept-A']);
    mockState.rpcSubtree.set('dept-A', ['dept-A']);
    vi.mocked(loadEmployeeAccessMap).mockResolvedValue(new Map([[555, ['dept-A']]]));
    const req = buildManagerReq();
    expect(await canAccessEmployeeInScope(req, 555)).toBe(true);
    // ветка отделов сработала раньше — direct reports не запрашиваются
    expect(vi.mocked(listDirectSubordinates)).not.toHaveBeenCalled();
  });

  it('мемоизация: повторные вызовы для разных подчинённых не дёргают listDirectSubordinates повторно', async () => {
    vi.mocked(listExplicitDepartmentIdsForUser).mockResolvedValue([]);
    vi.mocked(listDirectSubordinates).mockResolvedValue([555, 777]);
    const req = buildManagerReq();
    expect(await canAccessEmployeeInScope(req, 555)).toBe(true);
    expect(await canAccessEmployeeInScope(req, 777)).toBe(true);
    expect(await canAccessEmployeeInScope(req, 999)).toBe(false);
    expect(vi.mocked(listDirectSubordinates)).toHaveBeenCalledTimes(1);
  });
});

describe('getSelfHistoryLimitForUser', () => {
  // REF = 16 мая 2026 (месяц-индекс 4).
  const REF = new Date(2026, 4, 16);

  it('окно по умолчанию (back=1) → первое число прошлого месяца', () => {
    const r = getSelfHistoryLimitForUser({ timesheet_months_back: 1 }, REF);
    expect(r.minDate).toBe('2026-04-01');
    expect(r.message).toContain('01.04.2026');
  });

  it('широкое окно back=3', () => {
    expect(getSelfHistoryLimitForUser({ timesheet_months_back: 3 }, REF).minDate).toBe('2026-02-01');
  });

  it('back=0 → только текущий месяц', () => {
    expect(getSelfHistoryLimitForUser({ timesheet_months_back: 0 }, REF).minDate).toBe('2026-05-01');
  });

  it('граница года: февраль 2026, back=3 → ноябрь 2025', () => {
    const r = getSelfHistoryLimitForUser({ timesheet_months_back: 3 }, new Date(2026, 1, 10));
    expect(r.minDate).toBe('2025-11-01');
  });

  it('is_admin освобождён — без ограничения', () => {
    const r = getSelfHistoryLimitForUser({ is_admin: true, timesheet_months_back: 0 }, REF);
    expect(r.minDate).toBeNull();
    expect(r.message).toBeNull();
  });

  it('невалидный/отсутствующий back → дефолт 1', () => {
    expect(getSelfHistoryLimitForUser({}, REF).minDate).toBe('2026-04-01');
    expect(getSelfHistoryLimitForUser({ timesheet_months_back: -5 }, REF).minDate).toBe('2026-04-01');
    expect(getSelfHistoryLimitForUser({ timesheet_months_back: NaN }, REF).minDate).toBe('2026-04-01');
  });

  it('точный текст сообщения для back=1 (регресс-гард формулировки)', () => {
    expect(getSelfHistoryLimitForUser({ timesheet_months_back: 1 }, REF).message).toBe(
      'Доступ к своим данным ограничен периодом с 01.04.2026. Для расширения обратитесь к администратору.',
    );
  });

  it('is_admin=false c back=2 — окно применяется', () => {
    expect(getSelfHistoryLimitForUser({ is_admin: false, timesheet_months_back: 2 }, REF).minDate).toBe('2026-03-01');
  });
});
