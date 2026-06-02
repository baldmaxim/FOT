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

interface IDeptRow {
  id: string;
  parent_id: string | null;
}
interface IAccessRow {
  employee_id: number;
  department_id: string;
  is_active: boolean;
  source: string;
}
interface IEmployeeRow {
  id: number;
  is_archived: boolean;
  excluded_from_timesheet: boolean;
}

const mockedState = vi.hoisted(() => ({
  departments: [] as Array<{ id: string; parent_id: string | null }>,
  access: [] as Array<{ employee_id: number; department_id: string; is_active: boolean; source: string }>,
  employees: [] as Array<{ id: number; is_archived: boolean; excluded_from_timesheet: boolean }>,
}));

import { fetchManagerIdsForDepartments, mergeManagerIdsIntoGroups } from './timesheet-objects-export.service.js';

// Эмулирует рекурсивный CTE fetchManagerIdsForDepartments в JS:
// поднимается вверх по parent_id от каждого appearing-отдела и собирает
// руководителей из access, прошедших фильтры.
function emulateManagerQuery(appearingIds: string[]): Array<{ department_id: string; employee_ids: number[] }> {
  const deptById = new Map<string, IDeptRow>(mockedState.departments.map(d => [d.id, d]));
  const empById = new Map<number, IEmployeeRow>(mockedState.employees.map(e => [e.id, e]));
  const out = new Map<string, Set<number>>();

  for (const appearing of appearingIds) {
    // собрать сам отдел + всех предков
    const chain: string[] = [];
    let cur: string | null | undefined = appearing;
    while (cur && deptById.has(cur)) {
      chain.push(cur);
      cur = deptById.get(cur)!.parent_id;
    }
    for (const deptId of chain) {
      for (const acc of mockedState.access as IAccessRow[]) {
        if (acc.department_id !== deptId) continue;
        if (!acc.is_active) continue;
        if (acc.source === 'sigur_sync') continue;
        const emp = empById.get(acc.employee_id);
        if (!emp || emp.is_archived || emp.excluded_from_timesheet) continue;
        if (!out.has(appearing)) out.set(appearing, new Set());
        out.get(appearing)!.add(acc.employee_id);
      }
    }
  }

  return [...out.entries()].map(([department_id, ids]) => ({
    department_id,
    employee_ids: [...ids].sort((a, b) => a - b),
  }));
}

describe('timesheet-objects-export.service', () => {
  beforeEach(() => {
    mockedState.departments = [];
    mockedState.access = [];
    mockedState.employees = [];
    pgQuery.mockReset();
    pgQueryOne.mockReset();
    pgExecute.mockReset();
    pgTx.mockReset();

    pgQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (/employee_department_access/i.test(sql) && /WITH RECURSIVE ancestry/i.test(sql)) {
        const appearingIds = (params[0] as string[]) || [];
        return emulateManagerQuery(appearingIds);
      }
      throw new Error(`Unexpected query SQL: ${sql}`);
    });
  });

  describe('fetchManagerIdsForDepartments', () => {
    it('включает руководителя, назначенного на родительский отдел появившейся бригады', async () => {
      mockedState.departments = [
        { id: 'D', parent_id: null },
        { id: 'B', parent_id: 'D' },
      ];
      mockedState.access = [{ employee_id: 100, department_id: 'D', is_active: true, source: 'manual_admin_ui' }];
      mockedState.employees = [{ id: 100, is_archived: false, excluded_from_timesheet: false }];

      const map = await fetchManagerIdsForDepartments(['B']);
      expect(map.get('B')).toEqual([100]);
    });

    it('включает руководителя при прямом назначении на саму бригаду', async () => {
      mockedState.departments = [{ id: 'B', parent_id: null }];
      mockedState.access = [{ employee_id: 101, department_id: 'B', is_active: true, source: 'manual_admin_ui' }];
      mockedState.employees = [{ id: 101, is_archived: false, excluded_from_timesheet: false }];

      const map = await fetchManagerIdsForDepartments(['B']);
      expect(map.get('B')).toEqual([101]);
    });

    it('исключает membership-строки source=sigur_sync', async () => {
      mockedState.departments = [{ id: 'B', parent_id: null }];
      mockedState.access = [{ employee_id: 102, department_id: 'B', is_active: true, source: 'sigur_sync' }];
      mockedState.employees = [{ id: 102, is_archived: false, excluded_from_timesheet: false }];

      const map = await fetchManagerIdsForDepartments(['B']);
      expect(map.has('B')).toBe(false);
    });

    it('исключает неактивные назначения', async () => {
      mockedState.departments = [{ id: 'B', parent_id: null }];
      mockedState.access = [{ employee_id: 103, department_id: 'B', is_active: false, source: 'manual_admin_ui' }];
      mockedState.employees = [{ id: 103, is_archived: false, excluded_from_timesheet: false }];

      const map = await fetchManagerIdsForDepartments(['B']);
      expect(map.has('B')).toBe(false);
    });

    it('исключает архивных и excluded руководителей', async () => {
      mockedState.departments = [{ id: 'B', parent_id: null }];
      mockedState.access = [
        { employee_id: 104, department_id: 'B', is_active: true, source: 'manual_admin_ui' },
        { employee_id: 105, department_id: 'B', is_active: true, source: 'manual_admin_ui' },
      ];
      mockedState.employees = [
        { id: 104, is_archived: true, excluded_from_timesheet: false },
        { id: 105, is_archived: false, excluded_from_timesheet: true },
      ];

      const map = await fetchManagerIdsForDepartments(['B']);
      expect(map.has('B')).toBe(false);
    });

    it('для отдела без руководителя ключ отсутствует', async () => {
      mockedState.departments = [{ id: 'B', parent_id: null }];
      const map = await fetchManagerIdsForDepartments(['B']);
      expect(map.has('B')).toBe(false);
    });

    it('возвращает всех руководителей отдела', async () => {
      mockedState.departments = [{ id: 'B', parent_id: null }];
      mockedState.access = [
        { employee_id: 100, department_id: 'B', is_active: true, source: 'manual_admin_ui' },
        { employee_id: 101, department_id: 'B', is_active: true, source: 'excel_admin_ui' },
      ];
      mockedState.employees = [
        { id: 100, is_archived: false, excluded_from_timesheet: false },
        { id: 101, is_archived: false, excluded_from_timesheet: false },
      ];

      const map = await fetchManagerIdsForDepartments(['B']);
      expect(map.get('B')).toEqual([100, 101]);
    });

    it('возвращает пустую Map при отсутствии таблицы (42P01)', async () => {
      pgQuery.mockImplementationOnce(async () => {
        const err: Error & { code?: string } = new Error('relation does not exist');
        err.code = '42P01';
        throw err;
      });
      const map = await fetchManagerIdsForDepartments(['B']);
      expect(map.size).toBe(0);
    });

    it('возвращает пустую Map при пустом списке отделов без запроса в БД', async () => {
      const map = await fetchManagerIdsForDepartments([]);
      expect(map.size).toBe(0);
      expect(pgQuery).not.toHaveBeenCalled();
    });
  });

  describe('mergeManagerIdsIntoGroups', () => {
    it('добавляет руководителя в группу без дублей с уже пробившим СКУД', () => {
      const groups = new Map([['B', { name: 'Бригада 1', ids: [1, 100] }]]);
      mergeManagerIdsIntoGroups(groups, new Map([['B', [100, 200]]]));
      expect(groups.get('B')!.ids).toEqual([1, 100, 200]);
    });

    it('дедуп между бригадами — руководитель только в первой по сортировке ключей', () => {
      const groups = new Map([
        ['B2', { name: 'Бригада 2', ids: [2] }],
        ['B1', { name: 'Бригада 1', ids: [1] }],
      ]);
      // один руководитель 100 вернулся для обеих бригад
      mergeManagerIdsIntoGroups(groups, new Map([['B1', [100]], ['B2', [100]]]));
      expect(groups.get('B1')!.ids).toEqual([1, 100]);
      expect(groups.get('B2')!.ids).toEqual([2]);
    });

    it('не трогает группы без руководителей', () => {
      const groups = new Map([['B', { name: 'Бригада 1', ids: [1] }]]);
      mergeManagerIdsIntoGroups(groups, new Map());
      expect(groups.get('B')!.ids).toEqual([1]);
    });
  });
});
