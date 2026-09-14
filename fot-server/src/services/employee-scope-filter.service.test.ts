import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Скоуп чтения «Управления кадрами» для произвольного набора id: тот же охват,
 * что у списка (getAll), включая глобальное чтение по view_all_departments.
 */

const scope = vi.hoisted(() => ({
  dataScope: 'all' as 'self' | 'department' | 'all',
  globalRead: false,
  managedDepartmentIds: [] as string[],
  explicitDepartmentIds: [] as string[],
  directSubordinates: [] as number[],
}));

vi.mock('./data-scope.service.js', () => ({
  resolveRequestDataScopeWithDirectReports: vi.fn(async () => scope.dataScope),
  hasGlobalDepartmentReadScope: vi.fn(async () => scope.globalRead),
  resolveManagedDepartmentIds: vi.fn(async () => scope.managedDepartmentIds),
  resolveScopedDepartmentId: vi.fn(async () => null),
}));
vi.mock('./department-access.service.js', () => ({
  listExplicitDepartmentIdsForUser: vi.fn(async () => scope.explicitDepartmentIds),
}));
vi.mock('./employee-direct-reports.service.js', () => ({
  listDirectSubordinates: vi.fn(async () => scope.directSubordinates),
}));
vi.mock('./skud-shared.service.js', () => ({
  collectDeptIds: vi.fn(async (id: string) => [id]),
}));

const queryMock = vi.hoisted(() => vi.fn());
vi.mock('../config/postgres.js', () => ({ query: queryMock }));

const { filterEmployeeIdsByReadScope, resolveEmployeeListReadScope } = await import('./employee-scope-filter.service.js');

const req = (employeeId: number | null = 10): AuthenticatedRequest =>
  ({ user: { id: 'user-1', employee_id: employeeId } } as unknown as AuthenticatedRequest);

/**
 * Эмулятор SQL: возвращает id из пула «существующих», удовлетворяющие условию, которое
 * контроллер отправил в запросе. Разбираем параметры, а не текст — так тест проверяет смысл.
 */
const EMPLOYEES: Record<number, string | null> = {
  1: 'mine', 2: 'foreign', 77: 'foreign', 10: 'mine',
};
queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
  const ids = params[0] as number[];
  const existing = ids.filter(id => id in EMPLOYEES);
  if (sql.includes('org_department_id = ANY')) {
    const depts = params[1] as string[];
    const direct = params[2] as number[];
    return existing.filter(id => depts.includes(EMPLOYEES[id] ?? '') || direct.includes(id)).map(id => ({ id }));
  }
  if (sql.includes('id = ANY($2')) {
    const direct = params[1] as number[];
    return existing.filter(id => direct.includes(id)).map(id => ({ id }));
  }
  if (sql.includes('id = $2')) {
    return existing.filter(id => id === params[1]).map(id => ({ id }));
  }
  return existing.map(id => ({ id: String(id) }));
});

beforeEach(() => {
  queryMock.mockClear();
  scope.dataScope = 'all';
  scope.globalRead = false;
  scope.managedDepartmentIds = [];
  scope.explicitDepartmentIds = [];
  scope.directSubordinates = [];
});

describe('resolveEmployeeListReadScope', () => {
  it('view_all_departments расширяет department-скоуп до глобального чтения', async () => {
    scope.dataScope = 'department';
    scope.globalRead = true;
    expect(await resolveEmployeeListReadScope(req())).toEqual({ scope: 'all', globalRead: true });
  });

  it('без флага скоуп не меняется', async () => {
    scope.dataScope = 'department';
    expect(await resolveEmployeeListReadScope(req())).toEqual({ scope: 'department', globalRead: false });
  });
});

describe('filterEmployeeIdsByReadScope', () => {
  it('scope=all — только существующие id, мусорные id отброшены без запроса', async () => {
    expect(await filterEmployeeIdsByReadScope(req(), [1, 2, 404])).toEqual([1, 2]);
    expect(await filterEmployeeIdsByReadScope(req(), [0, -5])).toEqual([]);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('отделы скоупа + прямой подчинённый из чужого отдела; чужой сотрудник отсекается', async () => {
    scope.dataScope = 'department';
    scope.managedDepartmentIds = ['mine'];
    scope.directSubordinates = [77];

    expect((await filterEmployeeIdsByReadScope(req(), [1, 2, 77])).sort((a, b) => a - b)).toEqual([1, 77]);
  });

  it('view_all_departments — видны и чужие отделы (как в списке)', async () => {
    scope.dataScope = 'department';
    scope.globalRead = true;
    scope.managedDepartmentIds = ['mine'];

    expect(await filterEmployeeIdsByReadScope(req(), [1, 2])).toEqual([1, 2]);
  });

  it('только прямые подчинённые без отделов', async () => {
    scope.dataScope = 'department';
    scope.directSubordinates = [77];
    expect((await filterEmployeeIdsByReadScope(req(), [1, 77, 10])).sort((a, b) => a - b)).toEqual([10, 77]);
  });

  it('self — только свой id', async () => {
    scope.dataScope = 'self';
    expect(await filterEmployeeIdsByReadScope(req(10), [1, 10])).toEqual([10]);
  });

  it('department-скоуп без отделов и назначений — пусто, без запроса', async () => {
    scope.dataScope = 'department';
    expect(await filterEmployeeIdsByReadScope(req(), [1, 2])).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
