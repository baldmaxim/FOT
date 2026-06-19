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
  TIMEKEEPER_PRESENCE_WINDOW_DAYS,
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
  it('пустые папки → пусто (строгое пересечение), один запрос', async () => {
    pgQuery.mockResolvedValueOnce([]); // folders
    const seeds = await listTimekeeperDepartmentSeeds('tk-1');
    expect(seeds).toEqual([]);
    expect(pgQuery).toHaveBeenCalledTimes(1);
  });

  it('пересечение present ∩ папки → уникальные видимые бригады', async () => {
    pgQuery
      .mockResolvedValueOnce([{ department_id: 'folder-1' }]) // folders
      .mockResolvedValueOnce([{ id: 'br-A' }, { id: 'br-B' }, { id: 'br-A' }]); // present ∩ folder_desc
    const seeds = await listTimekeeperDepartmentSeeds('tk-1');
    expect(seeds).toEqual(['br-A', 'br-B']);
    expect(pgQuery).toHaveBeenCalledTimes(2);
    const [, params] = pgQuery.mock.calls[1];
    expect(params).toEqual(['tk-1', ['folder-1']]);
  });

  it('present считает обе ветки: ручную привязку И фактические проходы СКУД (окно)', async () => {
    pgQuery
      .mockResolvedValueOnce([{ department_id: 'folder-1' }]) // folders
      .mockResolvedValueOnce([{ id: 'br-A' }]); // present ∩ folder_desc
    await listTimekeeperDepartmentSeeds('tk-1');
    const [sql] = pgQuery.mock.calls[1];
    expect(sql).toContain('employee_skud_object_access'); // ветка B (ручная)
    expect(sql).toContain('skud_object_access_points'); // ветка A (проходы)
    expect(sql).toContain('skud_events');
    expect(sql).toContain('UNION');
    expect(sql).toContain(`INTERVAL '${TIMEKEEPER_PRESENCE_WINDOW_DAYS} days'`);
    // гейт по папкам сохранён
    expect(sql).toContain('folder_desc');
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

  it('берёт сотрудников из трёх источников: явных назначений, места работы СКУД и фактических проходов', async () => {
    pgQuery.mockResolvedValue([{ employee_id: 5 }]);
    await listTimekeeperDirectEmployeeIds('tk-1');
    const [sql, params] = pgQuery.mock.calls[0];
    expect(sql).toContain('employee_object_assignment');
    expect(sql).toContain('employee_skud_object_access');
    expect(sql).toContain('skud_object_access_points');
    expect(sql).toContain('skud_events');
    expect(sql).toContain(`INTERVAL '${TIMEKEEPER_PRESENCE_WINDOW_DAYS} days'`);
    expect(sql.match(/UNION/g)?.length).toBe(2); // три источника → два UNION
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
    pgQuery
      .mockResolvedValueOnce([{ department_id: 'folder-1' }]) // folders
      .mockResolvedValueOnce([{ id: 'br-A' }]); // present ∩ folder_desc
    const req = buildReq();
    const first = await resolveTimekeeperDepartmentSeeds(req);
    const second = await resolveTimekeeperDepartmentSeeds(req);
    expect(first).toEqual(['br-A']);
    expect(second).toEqual(['br-A']);
    expect(req.user.__timekeeper_dept_seeds).toEqual(['br-A']);
    expect(pgQuery).toHaveBeenCalledTimes(2); // folders + intersection, далее из кэша
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
