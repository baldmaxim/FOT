import { beforeEach, describe, expect, it, vi } from 'vitest';

type CompanyAccessRow = { company_root_id: string };
type AccessRow = { employee_id: number; department_id: string; source: string; is_active: boolean };

const mockState = vi.hoisted(() => ({
  userCompanyAccess: [] as Array<{ user_id: string } & CompanyAccessRow>,
  employeeDepartmentAccess: [] as AccessRow[],
  /** Вернёт ids потомков для p_root_ids (включая сами корни). */
  rpcSubtree: new Map<string, string[]>(),
}));

vi.mock('../config/database.js', () => {
  function buildCompanyAccessQuery(userId: string) {
    return Promise.resolve({
      data: mockState.userCompanyAccess
        .filter(r => r.user_id === userId)
        .map(({ company_root_id }) => ({ company_root_id })),
      error: null,
    });
  }

  return {
    supabase: {
      from(table: string) {
        if (table === 'user_company_access') {
          let userId = '';
          const builder = {
            select: () => builder,
            eq: (col: string, value: string) => {
              if (col === 'user_id') userId = value;
              return builder;
            },
            then: (onFulfilled: (v: unknown) => unknown) => buildCompanyAccessQuery(userId).then(onFulfilled),
          };
          return builder;
        }
        if (table === 'employee_department_access') {
          // Не используется в этих тестах — возвращаем пустоту.
          const builder = {
            select: () => builder,
            eq: () => builder,
            neq: () => builder,
            then: (onFulfilled: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(onFulfilled),
          };
          return builder;
        }
        throw new Error(`Unexpected table ${table}`);
      },
      rpc: (name: string, params: { p_root_ids: string[] }) => {
        if (name !== 'get_descendant_department_ids') {
          throw new Error(`Unexpected RPC ${name}`);
        }
        const ids = new Set<string>();
        for (const root of params.p_root_ids) {
          const subtree = mockState.rpcSubtree.get(root) ?? [root];
          for (const id of subtree) ids.add(id);
        }
        return Promise.resolve({
          data: [...ids].map(id => ({ id })),
          error: null,
        });
      },
    },
  };
});

// Также мокаем department-access.service: в тестах нам нужен только admin-путь.
vi.mock('./department-access.service.js', () => ({
  listExplicitDepartmentIdsForUser: vi.fn().mockResolvedValue([]),
  loadEmployeeAccessMap: vi.fn().mockResolvedValue(new Map()),
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
