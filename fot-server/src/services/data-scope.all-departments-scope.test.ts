import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest, SystemRole } from '../types/index.js';

/**
 * Флаг роли all_departments_scope (миграция 270). Проверяем ровно две вещи:
 *  - он расширяет СКОУП ДАННЫХ и на чтение, и на запись (в отличие от
 *    view_all_departments, который остаётся read-only);
 *  - он не задевает ни is_admin (у него свой company-scope), ни company-admin.
 *
 * Право на конкретное действие флаг не даёт — это проверяется отдельно, на
 * page-access соответствующей страницы.
 */

const { pgQuery, getRoleByCode } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  getRoleByCode: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../config/db-instrumentation.js', () => ({
  withDbSlot: vi.fn((_label: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./roles-cache.service.js', () => ({ getRoleByCode }));
vi.mock('./department-access.service.js', () => ({
  listExplicitDepartmentIdsForUser: vi.fn(async () => []),
  listEditableDepartmentIdsForUser: vi.fn(async () => []),
  loadEmployeeAccessMap: vi.fn(async () => new Map()),
}));
vi.mock('./employee-skud-object-access.service.js', () => ({
  listObjectIdsForEmployee: vi.fn(async () => []),
}));
vi.mock('./employee-direct-reports.service.js', () => ({
  listDirectSubordinates: vi.fn(async () => []),
}));
vi.mock('./timekeeper-scope.service.js', () => ({
  isTimekeeper: () => false,
  resolveTimekeeperDepartmentSeeds: vi.fn(async () => []),
  resolveTimekeeperDirectEmployeeIds: vi.fn(async () => new Set<number>()),
}));

import {
  hasAllDepartmentsScope,
  hasGlobalDepartmentReadScope,
  resolveAccessibleDepartmentIds,
  resolveEditableDepartmentIds,
} from './data-scope.service.js';

const makeReq = (user: Partial<AuthenticatedRequest['user']>): AuthenticatedRequest => ({
  user: { id: 'u1', is_admin: false, role_code: 'hr_admin', employee_id: 1, ...user },
} as unknown as AuthenticatedRequest);

const role = (overrides: Partial<SystemRole>): SystemRole => ({
  is_admin: false,
  all_departments_scope: false,
  view_all_departments: false,
  ...overrides,
} as SystemRole);

beforeEach(() => {
  vi.clearAllMocks();
  getRoleByCode.mockResolvedValue(role({ all_departments_scope: true }));
});

describe('all_departments_scope: скоуп данных', () => {
  it('видимый скоуп — вся организация', async () => {
    expect(await resolveAccessibleDepartmentIds(makeReq({}))).toBe('all');
  });

  it('редактируемый скоуп — тоже вся организация (в отличие от view_all_departments)', async () => {
    expect(await resolveEditableDepartmentIds(makeReq({}))).toBe('all');
  });

  it('роль без флага остаётся на своих назначенных отделах', async () => {
    getRoleByCode.mockResolvedValue(role({ all_departments_scope: false }));
    const req = makeReq({ role_code: 'manager' });
    expect(await resolveAccessibleDepartmentIds(req)).toEqual([]);
    expect(await resolveEditableDepartmentIds(makeReq({ role_code: 'manager' }))).toEqual([]);
  });

  it('значение считается один раз на запрос', async () => {
    const req = makeReq({});
    await hasAllDepartmentsScope(req);
    await hasAllDepartmentsScope(req);
    expect(getRoleByCode).toHaveBeenCalledTimes(1);
  });

  it('недоступный кеш ролей не роняет скоуп: fail-closed', async () => {
    getRoleByCode.mockRejectedValue(new Error('roles cache down'));
    expect(await hasAllDepartmentsScope(makeReq({}))).toBe(false);
  });
});

describe('all_departments_scope: чего флаг НЕ делает', () => {
  it('к is_admin не применяется — у него собственный company-scope', async () => {
    expect(await hasAllDepartmentsScope(makeReq({ is_admin: true }))).toBe(false);
    expect(getRoleByCode).not.toHaveBeenCalled();
  });

  it('company-admin (is_admin со скоупом компаний) поведение не меняет', async () => {
    pgQuery.mockResolvedValue([{ company_root_id: 'root-1' }]);
    const req = makeReq({ is_admin: true, role_code: 'admin' });
    const scope = await resolveAccessibleDepartmentIds(req);
    // Не 'all': остаётся прежняя ветка company-scope (поддерево назначенных корней).
    expect(scope).not.toBe('all');
  });

  it('не включает read-only предикат view_all_departments', async () => {
    expect(await hasGlobalDepartmentReadScope(makeReq({}))).toBe(false);
  });
});
