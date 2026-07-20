import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pgQuery } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

import {
  listRecentSkudObjectNamesByEmployee,
  resolveAccessibleObjectIdsForRequest,
} from './employee-skud-object-access.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const makeReq = (overrides: {
  employee_id: number | null;
  is_admin?: boolean;
}): AuthenticatedRequest => {
  return {
    user: {
      id: 'u1',
      email: 'e@e',
      system_role_id: 'r',
      role_code: 'manager_obj',
      is_admin: overrides.is_admin ?? false,
      employee_variant: null,
      show_actual_hours: false,
      timesheet_months_back: 1,
      timesheet_months_forward: 1,
      employee_id: overrides.employee_id,
      department_id: null,
      is_approved: true,
      two_factor_enabled: false,
      two_factor_verified: false,
    },
  } as unknown as AuthenticatedRequest;
};

describe('resolveAccessibleObjectIdsForRequest', () => {
  beforeEach(() => {
    pgQuery.mockReset();
  });

  it('тех-юзер без employee_id → is_unrestricted=true, БД не дергается', async () => {
    const req = makeReq({ employee_id: null });
    const scope = await resolveAccessibleObjectIdsForRequest(req);

    expect(scope).toEqual({ is_unrestricted: true, object_ids: [] });
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('админ без активных привязок → is_unrestricted=true, БД не дергается', async () => {
    const req = makeReq({ employee_id: 1001, is_admin: true });
    const scope = await resolveAccessibleObjectIdsForRequest(req);

    expect(scope).toEqual({ is_unrestricted: true, object_ids: [] });
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('не-админ с 0 активных привязок → is_unrestricted=false, object_ids=[] (фикс бага)', async () => {
    pgQuery.mockResolvedValueOnce([]);
    const req = makeReq({ employee_id: 1002, is_admin: false });
    const scope = await resolveAccessibleObjectIdsForRequest(req);

    expect(scope).toEqual({ is_unrestricted: false, object_ids: [] });
    expect(pgQuery).toHaveBeenCalledTimes(1);
  });

  it('не-админ с активными привязками → is_unrestricted=false, object_ids=[...]', async () => {
    pgQuery.mockResolvedValueOnce([
      { skud_object_id: '11111111-1111-1111-1111-111111111111' },
      { skud_object_id: '22222222-2222-2222-2222-222222222222' },
    ]);
    const req = makeReq({ employee_id: 1003, is_admin: false });
    const scope = await resolveAccessibleObjectIdsForRequest(req);

    expect(scope).toEqual({
      is_unrestricted: false,
      object_ids: [
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
      ],
    });
  });

  it('результат кэшируется в req.user.__skud_object_scope', async () => {
    pgQuery.mockResolvedValueOnce([{ skud_object_id: '33333333-3333-3333-3333-333333333333' }]);
    const req = makeReq({ employee_id: 1004, is_admin: false });

    const first = await resolveAccessibleObjectIdsForRequest(req);
    const second = await resolveAccessibleObjectIdsForRequest(req);

    expect(second).toBe(first);
    expect(pgQuery).toHaveBeenCalledTimes(1);
  });
});

describe('listRecentSkudObjectNamesByEmployee', () => {
  beforeEach(() => {
    pgQuery.mockReset();
  });

  it('группирует имена объектов по employee_id (bigint строкой тоже)', async () => {
    pgQuery.mockResolvedValueOnce([
      { employee_id: '1', object_name: 'Объект А' },
      { employee_id: '1', object_name: 'Объект Б' },
      { employee_id: 2, object_name: 'Объект В' },
    ]);

    const map = await listRecentSkudObjectNamesByEmployee([1, 2]);

    expect(map.get(1)).toEqual(['Объект А', 'Объект Б']);
    expect(map.get(2)).toEqual(['Объект В']);
  });

  it('дедуплицирует входные ID и отбрасывает невалидные, дубли имён не добавляет', async () => {
    pgQuery.mockResolvedValueOnce([
      { employee_id: 1, object_name: 'Объект А' },
      { employee_id: 1, object_name: 'Объект А' },
    ]);

    const map = await listRecentSkudObjectNamesByEmployee([1, 1, 0, -5, 1.5, NaN]);

    expect(pgQuery).toHaveBeenCalledTimes(1);
    expect(pgQuery.mock.calls[0][1]).toEqual([[1]]);
    expect(map.get(1)).toEqual(['Объект А']);
  });

  it('пустой вход → пустая Map без запроса', async () => {
    const map = await listRecentSkudObjectNamesByEmployee([]);

    expect(map.size).toBe(0);
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('42P01 (нет таблицы) → пустая Map, не бросает', async () => {
    pgQuery.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: '42P01' }));

    const map = await listRecentSkudObjectNamesByEmployee([1]);

    expect(map.size).toBe(0);
  });

  it('прочая ошибка пробрасывается', async () => {
    pgQuery.mockRejectedValueOnce(new Error('boom'));

    await expect(listRecentSkudObjectNamesByEmployee([1])).rejects.toThrow('boom');
  });
});
