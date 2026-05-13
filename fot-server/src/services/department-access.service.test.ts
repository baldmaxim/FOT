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

const mockedState = vi.hoisted(() => ({
  employeeDepartmentAccess: [] as Array<{
    employee_id: number;
    department_id: string;
    is_active: boolean;
    source: string;
  }>,
}));

import { listManagedDepartmentIdsForUser, loadManagedDepartmentMap } from './department-access.service.js';

describe('department-access.service', () => {
  beforeEach(() => {
    mockedState.employeeDepartmentAccess = [];
    pgQuery.mockReset();
    pgQueryOne.mockReset();
    pgExecute.mockReset();
    pgTx.mockReset();

    // Эмулирует чтения из employee_department_access по различным SQL-формам:
    //  - WHERE employee_id = $1 AND is_active = true [AND source <> $N]
    //  - WHERE is_active = true [AND source <> $N] [AND employee_id = ANY($N::int[])]
    pgQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (!/employee_department_access/i.test(sql)) {
        throw new Error(`Unexpected query SQL: ${sql}`);
      }

      let rows = mockedState.employeeDepartmentAccess.filter(row => row.is_active);

      // Извлекаем фильтры по позиционным параметрам через регексп с захватом номера
      const employeeIdMatch = /employee_id\s*=\s*\$(\d+)/.exec(sql);
      const employeeAnyMatch = /employee_id\s*=\s*ANY\(\$(\d+)/i.exec(sql);
      const excludeSourceMatch = /source\s*<>\s*\$(\d+)/.exec(sql);

      if (employeeIdMatch) {
        const idx = Number(employeeIdMatch[1]) - 1;
        const val = params[idx];
        rows = rows.filter(row => row.employee_id === val);
      }
      if (employeeAnyMatch) {
        const idx = Number(employeeAnyMatch[1]) - 1;
        const arr = (params[idx] as number[]) || [];
        const set = new Set(arr);
        rows = rows.filter(row => set.has(row.employee_id));
      }
      if (excludeSourceMatch) {
        const idx = Number(excludeSourceMatch[1]) - 1;
        const val = params[idx];
        rows = rows.filter(row => row.source !== val);
      }

      if (/SELECT\s+department_id\s/i.test(sql)) {
        return rows.map(row => ({ department_id: row.department_id }));
      }
      if (/SELECT\s+employee_id\s*,\s*department_id/i.test(sql)) {
        return rows.map(row => ({ employee_id: row.employee_id, department_id: row.department_id }));
      }
      return rows;
    });
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

  it('без employee_id возвращает пустой список', async () => {
    mockedState.employeeDepartmentAccess = [
      { employee_id: 10, department_id: 'dept-a', is_active: true, source: 'manual_admin_ui' },
    ];

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

    const result = await loadManagedDepartmentMap([
      { user_id: 'user-1', employee_id: 11 },
      { user_id: 'user-2', employee_id: 22 },
      { user_id: 'user-3', employee_id: null },
    ]);

    expect(result.get('user-1')?.managed_department_ids).toEqual(['dept-a']);
    expect(result.get('user-2')?.managed_department_ids?.sort()).toEqual(['dept-b', 'dept-c']);
    expect(result.get('user-3')?.managed_department_ids).toEqual([]);
  });
});
