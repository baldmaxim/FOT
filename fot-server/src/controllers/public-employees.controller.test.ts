import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

// Контракт справочника сотрудников для 1С: гейт ключа, разбор параметров, конверт ответа. Сервис замокан —
// состав проверяет employees-1c-directory.service.pg.test.ts и scripts/check-employees-1c-directory.ts.

const { getKeyTables, listDirectoryEmployees } = vi.hoisted(() => ({ getKeyTables: vi.fn(), listDirectoryEmployees: vi.fn() }));

vi.mock('../services/data-api-key.service.js', () => ({ dataApiKeyService: { getKeyTables } }));
vi.mock('../services/employees-1c-directory.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/employees-1c-directory.service.js')>()),
  listDirectoryEmployees,
}));

import { publicEmployeesController } from './public-employees.controller.js';

const ID_ALL = '259802EC-95A4-42FC-AB00-3BC40F22A5CD';

const makeReq = (query: Record<string, string | string[]>, withKey = true): Request => ({
  query,
  dataApiKey: withKey ? { id: 'key-1', name: 'api_1C', rate_limit_per_minute: 300 } : undefined,
}) as unknown as Request;

const makeRes = () => {
  const response = {
    statusCode: 200,
    payload: null as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.payload = body; return this; },
  };
  return response as unknown as Response & { statusCode: number; payload: any };
};

const ROW = {
  employee_id: 1544, id_all: ID_ALL.toLowerCase(), full_name: 'Савкин Дмитрий Александрович', last_name: 'Савкин',
  first_name: 'Дмитрий', middle_name: 'Александрович', birth_date: '1980-01-31', tab_number: '0000-01544',
  organization: { inn: '7736255508', name: 'СУ-10' }, department: { id: 'd1', name: 'Отдел' }, position: 'Инженер',
  hire_date: '2024-03-01', dismissal_date: '2026-11-20', status: 'fired',
};

describe('public-employees.controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getKeyTables.mockResolvedValue([{ table_name: 'employees' }]);
    listDirectoryEmployees.mockResolvedValue({ rows: [ROW, { ...ROW, employee_id: 1600, id_all: null }], nextAfterId: 1600 });
  });

  it('без ключа — 401, ключу не открыта employees — 403', async () => {
    const res401 = makeRes();
    await publicEmployeesController.list(makeReq({}, false), res401);
    expect(res401.statusCode).toBe(401);
    getKeyTables.mockResolvedValue([{ table_name: 'org_departments' }]);
    const res403 = makeRes();
    await publicEmployeesController.list(makeReq({}), res403);
    expect(res403.statusCode).toBe(403);
    expect(listDirectoryEmployees).not.toHaveBeenCalled();
  });

  it('параметры и конверт: по умолчанию 500 строк, id_all — в нижнем регистре, next_after_id', async () => {
    const res = makeRes();
    await publicEmployeesController.list(makeReq({ id_all: ID_ALL, status: 'fired', after_id: '1000', limit: '1000' }), res);
    expect(listDirectoryEmployees).toHaveBeenCalledWith({
      idAll: ID_ALL.toLowerCase(), employeeId: null, status: 'fired', afterId: 1000, limit: 1000,
    });
    expect(res.payload).toEqual({
      success: true, data: [ROW, { ...ROW, employee_id: 1600, id_all: null }], meta: { count: 2, with_id_all: 1 }, next_after_id: 1600,
    });
    const defaults = makeRes();
    await publicEmployeesController.list(makeReq({ employee_id: '1544' }), defaults);
    expect(listDirectoryEmployees).toHaveBeenLastCalledWith({ idAll: null, employeeId: 1544, status: null, afterId: null, limit: 500 });
  });

  it.each([
    [{ id_all: 'Савкин' }],
    [{ status: 'dismissed' }],
    [{ limit: '0' }],
    [{ limit: '1001' }],
    [{ employee_id: '-5' }],
    [{ after_id: 'x' }],
    [{ status: ['active', 'fired'] }],
  ])('400 invalid_filter на %o', async query => {
    const res = makeRes();
    await publicEmployeesController.list(makeReq(query), res);
    expect(res.statusCode).toBe(400);
    expect(res.payload).toMatchObject({ success: false, code: 'invalid_filter', retryable: false });
    expect(listDirectoryEmployees).not.toHaveBeenCalled();
  });

  it('сбой сервиса — 500 internal_error, повторяемая', async () => {
    listDirectoryEmployees.mockRejectedValueOnce(new Error('boom'));
    const res = makeRes();
    await publicEmployeesController.list(makeReq({}), res);
    expect(res.statusCode).toBe(500);
    expect(res.payload).toMatchObject({ code: 'internal_error', retryable: true });
  });
});
