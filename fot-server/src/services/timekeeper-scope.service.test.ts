import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

import {
  isTimekeeper,
  listTimekeeperDepartmentSeeds,
  listTimekeeperDirectEmployeeIds,
  resolveTimekeeperDepartmentSeeds,
  resolveTimekeeperDirectEmployeeIds,
  resolveTimekeeperObjectIds,
} from './timekeeper-scope.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

function buildReq(roleCode = 'timekeeper', id = 'tk-1'): AuthenticatedRequest {
  return {
    user: {
      id,
      email: 't@e.com',
      system_role_id: 'role-tk',
      role_code: roleCode,
      is_admin: false,
      employee_variant: null,
      show_actual_hours: true,
      employee_id: null,
      department_id: null,
      is_approved: true,
      two_factor_enabled: false,
      two_factor_verified: true,
    },
  } as unknown as AuthenticatedRequest;
}

beforeEach(() => {
  pgQuery.mockReset();
});

describe('isTimekeeper', () => {
  it('true только для role_code timekeeper', () => {
    expect(isTimekeeper(buildReq('timekeeper'))).toBe(true);
    expect(isTimekeeper(buildReq('manager_obj'))).toBe(false);
    expect(isTimekeeper(buildReq('admin'))).toBe(false);
  });
});

describe('listTimekeeperDepartmentSeeds', () => {
  it('возвращает уникальные org_department_id', async () => {
    pgQuery.mockResolvedValue([
      { org_department_id: 'dept-A' },
      { org_department_id: 'dept-B' },
    ]);
    const seeds = await listTimekeeperDepartmentSeeds('tk-1');
    expect(seeds).toEqual(['dept-A', 'dept-B']);
    expect(pgQuery).toHaveBeenCalledTimes(1);
    const [, params] = pgQuery.mock.calls[0];
    expect(params).toEqual(['tk-1']);
  });
});

describe('listTimekeeperDirectEmployeeIds', () => {
  it('приводит к числам и дедуплицирует', async () => {
    pgQuery.mockResolvedValue([
      { employee_id: 10 },
      { employee_id: '20' },
      { employee_id: 10 },
    ]);
    const ids = await listTimekeeperDirectEmployeeIds('tk-1');
    expect(ids).toEqual([10, 20]);
  });

  it('берёт сотрудников из обоих источников: явных назначений и места работы СКУД', async () => {
    pgQuery.mockResolvedValue([{ employee_id: 5 }]);
    await listTimekeeperDirectEmployeeIds('tk-1');
    const [sql, params] = pgQuery.mock.calls[0];
    expect(sql).toContain('employee_object_assignment');
    expect(sql).toContain('employee_skud_object_access');
    expect(sql).toContain('UNION');
    expect(params).toEqual(['tk-1']);
  });
});

describe('resolveTimekeeperObjectIds', () => {
  it('уникальные skud_object_id', async () => {
    pgQuery.mockResolvedValue([{ skud_object_id: 'o1' }, { skud_object_id: 'o1' }, { skud_object_id: 'o2' }]);
    expect(await resolveTimekeeperObjectIds('tk-1')).toEqual(['o1', 'o2']);
  });
});

describe('resolveTimekeeperDepartmentSeeds (кэш на req)', () => {
  it('второй вызов не дёргает БД', async () => {
    pgQuery.mockResolvedValue([{ org_department_id: 'dept-A' }]);
    const req = buildReq();
    const first = await resolveTimekeeperDepartmentSeeds(req);
    const second = await resolveTimekeeperDepartmentSeeds(req);
    expect(first).toEqual(['dept-A']);
    expect(second).toEqual(['dept-A']);
    expect(req.user.__timekeeper_dept_seeds).toEqual(['dept-A']);
    expect(pgQuery).toHaveBeenCalledTimes(1);
  });
});

describe('resolveTimekeeperDirectEmployeeIds (кэш на req)', () => {
  it('возвращает Set и кэширует', async () => {
    pgQuery.mockResolvedValue([{ employee_id: 5 }, { employee_id: 7 }]);
    const req = buildReq();
    const set = await resolveTimekeeperDirectEmployeeIds(req);
    expect([...set]).toEqual([5, 7]);
    await resolveTimekeeperDirectEmployeeIds(req);
    expect(pgQuery).toHaveBeenCalledTimes(1);
  });
});
