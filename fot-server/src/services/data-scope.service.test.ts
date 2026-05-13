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
  loadEmployeeAccessMap: vi.fn().mockResolvedValue(new Map()),
}));

const mockState = vi.hoisted(() => ({
  /** Записи user_company_access по user_id */
  userCompanyAccess: [] as Array<{ user_id: string; company_root_id: string }>,
  /** Вернёт ids потомков для p_root_ids (включая сами корни). */
  rpcSubtree: new Map<string, string[]>(),
}));

import { invalidateAccessibleScopeCache, resolveAccessibleDepartmentIds, resolveCompanyScope } from './data-scope.service.js';
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
