import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  resolveAccessibleDepartmentIds: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  withTransaction: h.withTransaction,
}));
vi.mock('./data-scope.service.js', () => ({
  resolveAccessibleDepartmentIds: h.resolveAccessibleDepartmentIds,
}));

import {
  INDUCTION_ROOT_IDS,
  listInduction,
  listInductionDepartments,
  resolveInductionScopeIds,
  setInduction,
} from './employee-induction.service.js';

const [SU10, SM] = INDUCTION_ROOT_IDS;
const SU10_CHILD = '11111111-1111-1111-1111-111111111111';
const SM_CHILD = '22222222-2222-2222-2222-222222222222';
const BRANCH = [SU10, SU10_CHILD, SM, SM_CHILD];
const CONTRACTOR_DEPT = '33333333-3333-3333-3333-333333333333';

const makeReq = (roleCode: string) => ({ user: { id: 'u-1', role_code: roleCode } }) as never;

/** Мок клиента транзакции: очередь ответов на client.query в порядке вызовов. */
const makeTxClient = (results: Array<{ rows: unknown[] }>) => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return results.shift() ?? { rows: [] };
    }),
  };
  h.withTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(client));
  return { client, calls };
};

beforeEach(() => {
  Object.values(h).forEach(fn => fn.mockReset());
  h.query.mockResolvedValue([]);
});

describe('resolveInductionScopeIds', () => {
  const mockBranch = () => {
    h.query.mockResolvedValueOnce(BRANCH.map(id => ({ id })));
  };

  it('роль ОТиТБ получает обе ветки целиком', async () => {
    mockBranch();
    h.resolveAccessibleDepartmentIds.mockResolvedValue([]);

    await expect(resolveInductionScopeIds(makeReq('otitb'))).resolves.toEqual(BRANCH);
  });

  it('data-scope «all» (системный админ, кадры) — обе ветки', async () => {
    mockBranch();
    h.resolveAccessibleDepartmentIds.mockResolvedValue('all');

    await expect(resolveInductionScopeIds(makeReq('hr'))).resolves.toEqual(BRANCH);
  });

  it('руководитель — только пересечение своих отделов с ветками', async () => {
    mockBranch();
    h.resolveAccessibleDepartmentIds.mockResolvedValue([SU10_CHILD, CONTRACTOR_DEPT]);

    await expect(resolveInductionScopeIds(makeReq('manager'))).resolves.toEqual([SU10_CHILD]);
  });

  it('админ компании с чужим корнем не получает ветки СУ-10/СМ', async () => {
    mockBranch();
    h.resolveAccessibleDepartmentIds.mockResolvedValue([CONTRACTOR_DEPT]);

    await expect(resolveInductionScopeIds(makeReq('admin'))).resolves.toEqual([]);
  });

  it('админ компании со скоупом только на СУ-10 не видит СМ', async () => {
    mockBranch();
    h.resolveAccessibleDepartmentIds.mockResolvedValue([SU10, SU10_CHILD]);

    await expect(resolveInductionScopeIds(makeReq('admin'))).resolves.toEqual([SU10, SU10_CHILD]);
  });

  it('page-grant вкладки сам по себе не расширяет скоуп (решает роль, не право)', async () => {
    mockBranch();
    // Роль вне INDUCTION_FULL_SCOPE_ROLES, которой выдали /staff-control/induction.
    h.resolveAccessibleDepartmentIds.mockResolvedValue([SM_CHILD]);

    await expect(resolveInductionScopeIds(makeReq('security'))).resolves.toEqual([SM_CHILD]);
  });
});

describe('listInductionDepartments', () => {
  it('пустой скоуп — без запроса к БД', async () => {
    await expect(listInductionDepartments([])).resolves.toEqual([]);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('фильтрует отделы по переданному скоупу', async () => {
    h.query.mockResolvedValueOnce([{ id: SU10_CHILD, name: 'Участок 1' }]);

    await listInductionDepartments([SU10_CHILD]);

    const [sql, params] = h.query.mock.calls[0];
    expect(String(sql)).toContain('od.id = ANY($1::uuid[])');
    expect(params).toEqual([[SU10_CHILD], INDUCTION_ROOT_IDS]);
  });
});

describe('listInduction', () => {
  it('пустой скоуп — пустой результат без запросов', async () => {
    await expect(listInduction({ scopeIds: [], page: 1, pageSize: 100 })).resolves.toEqual({
      rows: [], total: 0, passed: 0,
    });
    expect(h.query).not.toHaveBeenCalled();
  });

  it('скрывает уволенных и архивных, ограничивает скоупом, считает total/passed как int', async () => {
    h.query
      .mockResolvedValueOnce([{ employee_id: 1, full_name: 'Иванов', inducted_on: '2026-07-01' }])
      .mockResolvedValueOnce([{ total: 12, passed: 5 }]);

    const result = await listInduction({ scopeIds: BRANCH, page: 2, pageSize: 50 });

    const [listSql, listParams] = h.query.mock.calls[0];
    expect(String(listSql)).toContain('e.is_archived = false');
    expect(String(listSql)).toContain(`e.employment_status <> 'fired'`);
    expect(String(listSql)).toContain('e.org_department_id = ANY($1::uuid[])');
    // LIMIT/OFFSET — последние два параметра.
    expect(listParams).toEqual([BRANCH, 50, 50]);

    const [countSql] = h.query.mock.calls[1];
    expect(String(countSql)).toContain('count(*)::int');
    expect(String(countSql)).toContain('count(i.employee_id)::int');
    expect(result).toEqual({
      rows: [{ employee_id: 1, full_name: 'Иванов', inducted_on: '2026-07-01' }],
      total: 12,
      passed: 5,
    });
  });

  it('фильтр статуса применяется к списку, но не к счётчикам', async () => {
    h.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 3, passed: 1 }]);

    await listInduction({ scopeIds: BRANCH, status: 'missing', page: 1, pageSize: 100 });

    expect(String(h.query.mock.calls[0][0])).toContain('i.employee_id IS NULL');
    expect(String(h.query.mock.calls[1][0])).not.toContain('i.employee_id IS NULL');
  });

  it('поиск по ФИО экранирует LIKE-символы', async () => {
    h.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0, passed: 0 }]);

    await listInduction({ scopeIds: BRANCH, search: ' 100%_ ', page: 1, pageSize: 100 });

    expect(h.query.mock.calls[0][1]).toContain('%100\\%\\_%');
  });
});

describe('setInduction', () => {
  const base = { employeeId: 7, userId: 'u-1', scopeIds: BRANCH };

  it('пустой скоуп — found:false, транзакция не открывается', async () => {
    await expect(setInduction({ ...base, inductedOn: '2026-07-01', scopeIds: [] }))
      .resolves.toEqual({ found: false });
    expect(h.withTransaction).not.toHaveBeenCalled();
  });

  it('сотрудник вне скоупа / уволенный / архивный — found:false', async () => {
    const { calls } = makeTxClient([{ rows: [] }]);

    await expect(setInduction({ ...base, inductedOn: '2026-07-01' }))
      .resolves.toEqual({ found: false });

    // Целевой SELECT повторяет условия списка и берёт блокировку.
    expect(calls[0].sql).toContain('e.is_archived = false');
    expect(calls[0].sql).toContain(`e.employment_status <> 'fired'`);
    expect(calls[0].sql).toContain('e.org_department_id = ANY($2::uuid[])');
    expect(calls[0].sql).toContain('FOR UPDATE');
    expect(calls).toHaveLength(1);
  });

  it('первая установка даты: previous=null, found=true, запись выполняется', async () => {
    const { calls } = makeTxClient([
      { rows: [{ id: 7 }] },   // сотрудник найден
      { rows: [] },            // прежней даты нет
      { rows: [] },            // upsert
    ]);

    await expect(setInduction({ ...base, inductedOn: '2026-07-01' })).resolves.toEqual({
      found: true, changed: true, previous: null, current: '2026-07-01',
    });
    expect(calls[2].sql).toContain('INSERT INTO employee_inductions');
    expect(calls[2].sql).toContain('ON CONFLICT (employee_id) DO UPDATE');
    expect(calls[2].sql).not.toContain('created_at =');
  });

  it('повтор той же даты — no-op: ни INSERT, ни DELETE', async () => {
    const { calls } = makeTxClient([
      { rows: [{ id: 7 }] },
      { rows: [{ inducted_on: '2026-07-01' }] },
    ]);

    await expect(setInduction({ ...base, inductedOn: '2026-07-01' })).resolves.toEqual({
      found: true, changed: false, previous: '2026-07-01', current: '2026-07-01',
    });
    expect(calls).toHaveLength(2);
  });

  it('очистка отсутствующей даты — идемпотентный no-op', async () => {
    const { calls } = makeTxClient([
      { rows: [{ id: 7 }] },
      { rows: [] },
    ]);

    await expect(setInduction({ ...base, inductedOn: null })).resolves.toEqual({
      found: true, changed: false, previous: null, current: null,
    });
    expect(calls).toHaveLength(2);
  });

  it('снятие существующей даты — DELETE и previous в результате', async () => {
    const { calls } = makeTxClient([
      { rows: [{ id: 7 }] },
      { rows: [{ inducted_on: '2026-07-01' }] },
      { rows: [] },
    ]);

    await expect(setInduction({ ...base, inductedOn: null })).resolves.toEqual({
      found: true, changed: true, previous: '2026-07-01', current: null,
    });
    expect(calls[2].sql).toContain('DELETE FROM employee_inductions');
  });

  it('прежняя дата читается под блокировкой (защита от гонки конкурентных PATCH)', async () => {
    const { calls } = makeTxClient([
      { rows: [{ id: 7 }] },
      { rows: [{ inducted_on: '2026-06-01' }] },
      { rows: [] },
    ]);

    await setInduction({ ...base, inductedOn: '2026-07-01' });

    expect(calls[1].sql).toContain('FROM employee_inductions');
    expect(calls[1].sql).toContain('FOR UPDATE');
  });
});
