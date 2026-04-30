import { beforeEach, describe, expect, it, vi } from 'vitest';

type QueryRecord = {
  table: string;
  operations: Array<{ method: string; args: unknown[] }>;
};

type QueryResponse = {
  data?: unknown;
  error?: { message?: string } | null;
};

const mockedState = vi.hoisted(() => ({
  employeeDepartmentAccess: [] as Array<{
    employee_id: number;
    department_id: string;
    is_active: boolean;
    source: string;
  }>,
  userDepartmentAccess: [] as Array<{
    user_id: string;
    department_id: string;
    is_active: boolean;
    source: string;
  }>,
}));

function matchesQueryRecord<T extends Record<string, unknown>>(row: T, query: QueryRecord): boolean {
  return query.operations.every((operation) => {
    if (operation.method === 'eq') {
      const [field, value] = operation.args;
      return row[String(field)] === value;
    }

    if (operation.method === 'neq') {
      const [field, value] = operation.args;
      return row[String(field)] !== value;
    }

    if (operation.method === 'in') {
      const [field, values] = operation.args;
      return Array.isArray(values) && values.includes(row[String(field)]);
    }

    return true;
  });
}

function resolveQuery(query: QueryRecord): QueryResponse {
  if (query.table === 'employee_department_access') {
    return {
      data: mockedState.employeeDepartmentAccess.filter(row => matchesQueryRecord(row, query)),
      error: null,
    };
  }

  if (query.table === 'user_department_access') {
    return {
      data: mockedState.userDepartmentAccess.filter(row => matchesQueryRecord(row, query)),
      error: null,
    };
  }

  throw new Error(`Unexpected query for table ${query.table}`);
}

function createBuilder(table: string) {
  const query: QueryRecord = { table, operations: [] };

  const builder = {
    select: (...args: unknown[]) => {
      query.operations.push({ method: 'select', args });
      return builder;
    },
    eq: (...args: unknown[]) => {
      query.operations.push({ method: 'eq', args });
      return builder;
    },
    neq: (...args: unknown[]) => {
      query.operations.push({ method: 'neq', args });
      return builder;
    },
    in: (...args: unknown[]) => {
      query.operations.push({ method: 'in', args });
      return builder;
    },
    then: (onFulfilled: (value: QueryResponse) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(resolveQuery(query)).then(onFulfilled, onRejected),
  };

  return builder;
}

vi.mock('../config/database.js', () => ({
  supabase: {
    from: vi.fn((table: string) => createBuilder(table)),
  },
}));

import { listManagedDepartmentIdsForUser, loadManagedDepartmentMap } from './department-access.service.js';

describe('department-access.service', () => {
  beforeEach(() => {
    mockedState.employeeDepartmentAccess = [];
    mockedState.userDepartmentAccess = [];
  });

  it('возвращает только активные руководительские назначения сотрудника', async () => {
    mockedState.employeeDepartmentAccess = [
      { employee_id: 10, department_id: 'dept-a', is_active: true, source: 'manual_admin_ui' },
      { employee_id: 10, department_id: 'dept-b', is_active: true, source: 'manual_admin_ui' },
      { employee_id: 10, department_id: 'dept-c', is_active: false, source: 'manual_admin_ui' },
    ];

    const result = await listManagedDepartmentIdsForUser('user-1', null, 10);

    expect(result).toEqual(['dept-a', 'dept-b']);
  });

  it('без employee_id читает назначения из user_department_access', async () => {
    mockedState.employeeDepartmentAccess = [
      { employee_id: 10, department_id: 'dept-other', is_active: true, source: 'manual_admin_ui' },
    ];
    mockedState.userDepartmentAccess = [
      { user_id: 'user-1', department_id: 'dept-a', is_active: true, source: 'manual_admin_ui' },
      { user_id: 'user-1', department_id: 'dept-b', is_active: true, source: 'manual_admin_ui' },
      { user_id: 'user-1', department_id: 'dept-old', is_active: false, source: 'manual_admin_ui' },
      { user_id: 'user-2', department_id: 'dept-c', is_active: true, source: 'manual_admin_ui' },
    ];

    const result = await listManagedDepartmentIdsForUser('user-1', null, null);

    expect(result.sort()).toEqual(['dept-a', 'dept-b']);
  });

  it('без employee_id и без записей в user_department_access возвращает пустой список', async () => {
    const result = await listManagedDepartmentIdsForUser('user-1', null, null);

    expect(result).toEqual([]);
  });

  it('исключает sigur_sync (членство) из руководительских назначений', async () => {
    mockedState.employeeDepartmentAccess = [
      { employee_id: 10, department_id: 'dept-x', is_active: true, source: 'manual_admin_ui' },
      { employee_id: 10, department_id: 'dept-y', is_active: true, source: 'sigur_sync' },
    ];

    const result = await listManagedDepartmentIdsForUser('user-1', null, 10);

    expect(result).toEqual(['dept-x']);
  });

  it('возвращает [] если у сотрудника только membership-строка', async () => {
    mockedState.employeeDepartmentAccess = [
      { employee_id: 10, department_id: 'dept-y', is_active: true, source: 'sigur_sync' },
    ];

    const result = await listManagedDepartmentIdsForUser('user-1', null, 10);

    expect(result).toEqual([]);
  });

  it('строит карту назначений для нескольких сотрудников и исключает sigur_sync', async () => {
    mockedState.employeeDepartmentAccess = [
      { employee_id: 11, department_id: 'dept-a', is_active: true, source: 'manual_admin_ui' },
      { employee_id: 22, department_id: 'dept-b', is_active: true, source: 'manual_admin_ui' },
      { employee_id: 22, department_id: 'dept-c', is_active: true, source: 'manual_admin_ui' },
      { employee_id: 22, department_id: 'dept-self', is_active: true, source: 'sigur_sync' },
    ];
    mockedState.userDepartmentAccess = [
      { user_id: 'user-3', department_id: 'dept-d', is_active: true, source: 'manual_admin_ui' },
      { user_id: 'user-3', department_id: 'dept-e', is_active: false, source: 'manual_admin_ui' },
      { user_id: 'user-4', department_id: 'dept-x', is_active: true, source: 'manual_admin_ui' },
    ];

    const result = await loadManagedDepartmentMap([
      { user_id: 'user-1', employee_id: 11 },
      { user_id: 'user-2', employee_id: 22 },
      { user_id: 'user-3', employee_id: null },
      { user_id: 'user-5', employee_id: null },
    ]);

    expect(result.get('user-1')?.managed_department_ids).toEqual(['dept-a']);
    expect(result.get('user-2')?.managed_department_ids?.sort()).toEqual(['dept-b', 'dept-c']);
    expect(result.get('user-3')?.managed_department_ids).toEqual(['dept-d']);
    expect(result.get('user-5')?.managed_department_ids).toEqual([]);
  });
});
