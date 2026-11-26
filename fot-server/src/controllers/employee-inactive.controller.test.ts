/**
 * «Перевести в неактивные» / «Вернуть в активные» (миграция 381).
 *
 * Право — только флаг учётки can_manage_staff_inactive (админу роль его не даёт). Каждое действие — один условный
 * UPDATE в транзакции с аудитом в ней же; перевод отзывает токены учёток сотрудника (кроме служебных) и после коммита
 * закрывает их открытые вкладки. Отказы 409 выбираются чтением строки, только если UPDATE ничего не изменил.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';

const h = vi.hoisted(() => ({
  queryOne: vi.fn(),
  txQuery: vi.fn(),
  audit: vi.fn(),
  canWriteEmployeeInScope: vi.fn(),
  invalidateEmployee: vi.fn(),
  invalidateCaches: vi.fn(),
  blockUserSockets: vi.fn(),
  committed: { value: false },
}));

vi.mock('../config/postgres.js', () => ({
  queryOne: h.queryOne,
  withTransaction: async <T>(fn: (client: { query: typeof h.txQuery }) => Promise<T>) => {
    // Транзакция: ошибка внутри — отката «коммита» нет, побочные эффекты после коммита не должны случиться.
    const result = await fn({ query: h.txQuery });
    h.committed.value = true;
    return result;
  },
}));
vi.mock('../services/audit.service.js', () => ({ auditService: { logFromRequestWithClient: h.audit } }));
vi.mock('../services/data-scope.service.js', () => ({ canWriteEmployeeInScope: h.canWriteEmployeeInScope }));
vi.mock('../services/employee-cache.service.js', () => ({ employeeCache: { invalidate: h.invalidateEmployee } }));
vi.mock('../middleware/cacheResponse.js', () => ({ invalidateCaches: h.invalidateCaches }));
vi.mock('../socket/io-instance.js', () => ({ blockUserSockets: h.blockUserSockets }));
vi.mock('../services/employee-inactive.service.js', () => ({
  loadAutoInactiveDepartments: async () => ({
    ids: ['decret', 'decret-child', 'archive'],
    nameById: new Map([['decret', 'Декрет'], ['decret-child', 'Декрет'], ['archive', 'Архив']]),
  }),
}));

const { deactivateEmployee, reactivateEmployee } = await import('./employee-inactive.controller.js');

const CHEPIKOV = 'a51b9047-273c-445f-bf7a-e186ced3f65d';

const makeReq = (id: string, user: Partial<{ id: string; employee_id: number | null; is_admin: boolean }> = {}) => ({
  params: { id },
  user: { id: CHEPIKOV, employee_id: 2063, is_admin: true, ...user },
  headers: {},
  ip: '127.0.0.1',
  socket: {},
}) as never;

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; return res; },
  };
  return res;
};

/** queryOne: первый вызов — флаг учётки, следующие — строка сотрудника для текста отказа. */
const mockRight = (allowed: boolean, employeeRow?: Record<string, unknown> | null) => {
  h.queryOne.mockImplementation(async (sql: string) => {
    if (sql.includes('can_manage_staff_inactive')) return { allowed };
    return employeeRow ?? null;
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  h.committed.value = false;
  h.canWriteEmployeeInScope.mockResolvedValue(true);
  h.audit.mockResolvedValue(undefined);
});

describe('права', () => {
  it('без флага учётки — 403, даже администратору; в БД ничего не пишется', async () => {
    mockRight(false);
    for (const handler of [deactivateEmployee, reactivateEmployee]) {
      const res = makeRes();
      await handler(makeReq('811', { is_admin: true }), res as unknown as Response);
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatchObject({ code: 'STAFF_INACTIVE_FORBIDDEN' });
    }
    expect(h.txQuery).not.toHaveBeenCalled();
  });

  it('вне охвата — 403; некорректный id — 400', async () => {
    mockRight(true);
    h.canWriteEmployeeInScope.mockResolvedValue(false);
    let res = makeRes();
    await deactivateEmployee(makeReq('811'), res as unknown as Response);
    expect(res.statusCode).toBe(403);
    res = makeRes();
    await deactivateEmployee(makeReq('abc'), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(h.txQuery).not.toHaveBeenCalled();
  });
});

describe('POST /:id/deactivate', () => {
  it('один условный UPDATE, отзыв токенов кроме служебных учёток, аудит в транзакции, затем — закрытие вкладок', async () => {
    mockRight(true);
    h.txQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE employees')) {
        return { rows: [{ id: 811, full_name: 'Квасова Татьяна Геннадьевна', staff_inactive_at: new Date('2026-11-26T09:00:00Z') }] };
      }
      if (sql.includes('UPDATE user_profiles')) return { rows: [{ id: 'u-1' }] };
      return { rows: [] };
    });
    const res = makeRes();
    await deactivateEmployee(makeReq('811'), res as unknown as Response);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: { id: 811, staff_inactive_at: '2026-11-26T09:00:00.000Z' } });

    const [updateSql, updateParams] = h.txQuery.mock.calls[0] as [string, unknown[]];
    expect(updateSql).toContain("employment_status <> 'fired'");
    expect(updateSql).toContain('staff_inactive_at IS NULL');
    expect(updateSql).toContain('org_department_id <> ALL($3::uuid[])');
    expect(updateSql).toContain('id IS DISTINCT FROM $4::int');
    expect(updateParams).toEqual([811, CHEPIKOV, ['decret', 'decret-child', 'archive'], 2063]);

    const [revokeSql, revokeParams] = h.txQuery.mock.calls[1] as [string, unknown[]];
    expect(revokeSql).toContain('token_version = token_version + 1');
    expect(revokeSql).toContain('login_when_staff_inactive IS NOT TRUE');
    expect(revokeParams).toEqual([811]);

    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ query: h.txQuery }), expect.anything(), CHEPIKOV,
      'EMPLOYEE_DEACTIVATED', expect.objectContaining({ entityId: '811', details: expect.objectContaining({ revoked_user_ids: ['u-1'] }) }));
    expect(h.blockUserSockets).toHaveBeenCalledWith(['u-1'], {
      code: 'EMPLOYEE_INACTIVE', message: 'Учётная запись отключена: сотрудник переведён в неактивные',
    });
    expect(h.invalidateEmployee).toHaveBeenCalledWith(811);
    expect(h.invalidateCaches).toHaveBeenCalledWith('admin:users:list');
  });

  it('служебная учётка не отозвана — вкладки не закрываются', async () => {
    mockRight(true);
    h.txQuery.mockImplementation(async (sql: string) => (sql.includes('UPDATE employees')
      ? { rows: [{ id: 15745, full_name: 'Учет проживания сотрудников', staff_inactive_at: new Date() }] }
      : { rows: [] }));
    const res = makeRes();
    await deactivateEmployee(makeReq('15745'), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(h.blockUserSockets).toHaveBeenCalledWith([], expect.anything());
  });

  it.each([
    [{ employment_status: 'fired', org_department_id: 'x', staff_inactive_at: null }, 'EMPLOYEE_FIRED', 'Сотрудник уволен'],
    [{ employment_status: 'active', org_department_id: 'x', staff_inactive_at: new Date() }, 'ALREADY_INACTIVE', 'Сотрудник уже переведён в неактивные'],
    [{ employment_status: 'active', org_department_id: 'decret-child', staff_inactive_at: null }, 'INACTIVE_BY_DEPARTMENT', 'Сотрудник неактивен по отделу «Декрет»'],
  ])('UPDATE не изменил строку → 409 %#', async (row, code, error) => {
    mockRight(true, { id: 811, full_name: 'Х', ...row });
    h.txQuery.mockResolvedValue({ rows: [] });
    const res = makeRes();
    await deactivateEmployee(makeReq('811'), res as unknown as Response);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code, error });
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.blockUserSockets).not.toHaveBeenCalled();
    expect(h.invalidateCaches).not.toHaveBeenCalled();
  });

  it('себя перевести нельзя → 409 SELF_DEACTIVATION; сотрудника нет → 404', async () => {
    mockRight(true, { id: 2063, full_name: 'Чепиков', employment_status: 'active', org_department_id: 'x', staff_inactive_at: null });
    h.txQuery.mockResolvedValue({ rows: [] });
    let res = makeRes();
    await deactivateEmployee(makeReq('2063'), res as unknown as Response);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'SELF_DEACTIVATION' });

    mockRight(true, null);
    res = makeRes();
    await deactivateEmployee(makeReq('999'), res as unknown as Response);
    expect(res.statusCode).toBe(404);
  });

  it('аудит упал — ошибка из транзакции (метка откатывается), вкладки и кэши не трогаются', async () => {
    mockRight(true);
    h.txQuery.mockImplementation(async (sql: string) => (sql.includes('UPDATE employees')
      ? { rows: [{ id: 811, full_name: 'Х', staff_inactive_at: new Date() }] }
      : { rows: [{ id: 'u-1' }] }));
    h.audit.mockRejectedValue(new Error('audit down'));
    const res = makeRes();
    await deactivateEmployee(makeReq('811'), res as unknown as Response);
    expect(res.statusCode).toBe(500);
    expect(h.committed.value).toBe(false);
    expect(h.blockUserSockets).not.toHaveBeenCalled();
    expect(h.invalidateCaches).not.toHaveBeenCalled();
  });
});

describe('POST /:id/reactivate', () => {
  it('снимает только ручную метку; аудит в транзакции; токены не трогает', async () => {
    mockRight(true);
    h.txQuery.mockResolvedValue({ rows: [{ id: 811, full_name: 'Х', org_department_id: 'vent' }] });
    const res = makeRes();
    await reactivateEmployee(makeReq('811'), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: { id: 811, inactive_department_name: null } });
    const [sql] = h.txQuery.mock.calls[0] as [string];
    expect(sql).toContain('staff_inactive_at = NULL');
    expect(sql).toContain('staff_inactive_at IS NOT NULL');
    expect(h.txQuery).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), expect.anything(), CHEPIKOV, 'EMPLOYEE_REACTIVATED', expect.anything());
    expect(h.blockUserSockets).not.toHaveBeenCalled();
    expect(h.invalidateCaches).toHaveBeenCalledWith('admin:users:list');
  });

  it('метка снята, но отдел во вложенном «Декрете» — ответ называет ветку', async () => {
    mockRight(true);
    h.txQuery.mockResolvedValue({ rows: [{ id: 811, full_name: 'Х', org_department_id: 'decret-child' }] });
    const res = makeRes();
    await reactivateEmployee(makeReq('811'), res as unknown as Response);
    expect(res.body).toEqual({ success: true, data: { id: 811, inactive_department_name: 'Декрет' } });
  });

  it('ручной метки нет (в т.ч. второй одновременный запрос) → 409; уволен → 409', async () => {
    mockRight(true, { id: 811, full_name: 'Х', employment_status: 'active', org_department_id: 'decret', staff_inactive_at: null });
    h.txQuery.mockResolvedValue({ rows: [] });
    let res = makeRes();
    await reactivateEmployee(makeReq('811'), res as unknown as Response);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'NOT_INACTIVE_MANUALLY' });

    mockRight(true, { id: 811, full_name: 'Х', employment_status: 'fired', org_department_id: 'x', staff_inactive_at: null });
    res = makeRes();
    await reactivateEmployee(makeReq('811'), res as unknown as Response);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'EMPLOYEE_FIRED' });
    expect(h.audit).not.toHaveBeenCalled();
  });
});
