import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));

vi.mock('../config/postgres.js', async (importActual) => ({
  ...(await importActual<typeof import('../config/postgres.js')>()),
  query: pgQuery,
}));

import {
  findApprovalLockForEmployeeDate,
  findApprovalLockForMembershipChange,
  findApprovalLocksForEmployeeDates,
  flattenApprovalLockDates,
  loadApprovalLocksForEmployeesInPeriod,
  lockKey,
  lockTimesheetMonthsOnClient,
} from './timesheet-lock.service.js';

beforeEach(() => {
  pgQuery.mockReset();
  pgQuery.mockResolvedValue([]);
});

describe('findApprovalLocksForEmployeeDates', () => {
  it('раскладывает строки в карту по (сотрудник, дата)', async () => {
    pgQuery.mockResolvedValue([
      { employee_id: '10', work_date: '2026-08-05', id: '7', start_date: '2026-08-01', end_date: '2026-08-15', status: 'approved' },
      { employee_id: 11, work_date: '2026-08-06', id: 8, start_date: '2026-08-01', end_date: '2026-08-15', status: 'submitted' },
    ]);

    const locks = await findApprovalLocksForEmployeeDates([
      { employeeId: 10, workDate: '2026-08-05' },
      { employeeId: 11, workDate: '2026-08-06' },
    ]);

    expect(locks.get(lockKey(10, '2026-08-05'))).toEqual({
      id: 7, start_date: '2026-08-01', end_date: '2026-08-15', status: 'approved',
    });
    expect(locks.get(lockKey(11, '2026-08-06'))?.status).toBe('submitted');
  });

  it('не ходит в БД на пустом и на невалидном наборе', async () => {
    expect((await findApprovalLocksForEmployeeDates([])).size).toBe(0);
    expect((await findApprovalLocksForEmployeeDates([
      { employeeId: 0, workDate: '2026-08-05' },
      { employeeId: 10, workDate: 'не-дата' },
    ])).size).toBe(0);
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('дедуплицирует пары перед запросом', async () => {
    await findApprovalLocksForEmployeeDates([
      { employeeId: 10, workDate: '2026-08-05' },
      { employeeId: 10, workDate: '2026-08-05' },
      { employeeId: 10, workDate: '2026-08-06' },
    ]);
    const [, params] = pgQuery.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toEqual([10, 10]);
    expect(params[1]).toEqual(['2026-08-05', '2026-08-06']);
  });

  it('учитывает и снимок состава, и отдел сотрудника с предками', async () => {
    await findApprovalLocksForEmployeeDates([{ employeeId: 10, workDate: '2026-08-05' }]);
    const [sql] = pgQuery.mock.calls[0] as [string];
    expect(sql).toContain('timesheet_approval_employees');
    expect(sql).toMatch(/JOIN org_departments d ON d\.id = c\.parent_id/);
    // Защита от циклов в parent_id: UNION (не UNION ALL) + ограничение глубины.
    expect(sql).toContain('UNION\n');
    expect(sql).toMatch(/c\.depth < \d+/);
  });

  it('приоритет approved над submitted задан явно, а не через ORDER BY status', async () => {
    await findApprovalLocksForEmployeeDates([{ employeeId: 10, workDate: '2026-08-05' }]);
    const [sql] = pgQuery.mock.calls[0] as [string];
    // Лексикографически 'submitted' > 'approved', поэтому ORDER BY status DESC врал.
    expect(sql).toContain("(a.status = 'approved') DESC");
    expect(sql).not.toMatch(/ORDER BY[^)]*a\.status DESC/);
  });

  it('берёт только submitted/approved — returned/draft период не запирают', async () => {
    await findApprovalLocksForEmployeeDates([{ employeeId: 10, workDate: '2026-08-05' }]);
    const [sql] = pgQuery.mock.calls[0] as [string];
    expect(sql).toContain("a.status IN ('submitted', 'approved')");
  });

  it('период, открытый кадровой службой, замка не даёт', async () => {
    await findApprovalLocksForEmployeeDates([{ employeeId: 10, workDate: '2026-08-05' }]);
    const [sql] = pgQuery.mock.calls[0] as [string];
    expect(sql).toContain('a.unlocked_at IS NULL');
  });
});

describe('findApprovalLocksForEmployeeDates — владение днём', () => {
  // Кейс Ибрагимова: подача бр.Каримова (утверждена) держит его в снимке, но с
  // 25.08 он в бр.Эрматовой — эти дни закрывать нельзя.
  const candidates = (workDate: string) => [
    { employee_id: 661, work_date: workDate, id: 1551, department_id: 'dept-karimov', start_date: '2026-08-16', end_date: '2026-08-31', status: 'approved' },
    { employee_id: 661, work_date: workDate, id: 1428, department_id: 'dept-ermatova', start_date: '2026-08-16', end_date: '2026-08-31', status: 'submitted' },
  ];
  const intervals = [
    { employee_id: 661, effective_from: '2026-07-30', effective_to: '2026-08-24', owning_approval_ids: [1551] },
    { employee_id: 661, effective_from: '2026-08-25', effective_to: null, owning_approval_ids: [1428] },
  ];

  it('день после перевода не закрывает подача прежнего отдела', async () => {
    pgQuery.mockResolvedValueOnce(candidates('2026-08-30')).mockResolvedValueOnce(intervals);

    const locks = await findApprovalLocksForEmployeeDates([{ employeeId: 661, workDate: '2026-08-30' }]);

    // Владеет подача новой бригады, она ещё submitted — замок от неё, не от approved-чужой.
    expect(locks.get(lockKey(661, '2026-08-30'))).toMatchObject({ id: 1428, status: 'submitted' });
  });

  it('день до перевода остаётся за подачей прежнего отдела', async () => {
    pgQuery.mockResolvedValueOnce(candidates('2026-08-20')).mockResolvedValueOnce(intervals);

    const locks = await findApprovalLocksForEmployeeDates([{ employeeId: 661, workDate: '2026-08-20' }]);

    expect(locks.get(lockKey(661, '2026-08-20'))).toMatchObject({ id: 1551, status: 'approved' });
  });

  it('когда владеющих подач нет, замка нет вовсе', async () => {
    pgQuery
      .mockResolvedValueOnce([candidates('2026-08-30')[0]])
      .mockResolvedValueOnce(intervals);

    const locks = await findApprovalLocksForEmployeeDates([{ employeeId: 661, workDate: '2026-08-30' }]);

    expect(locks.has(lockKey(661, '2026-08-30'))).toBe(false);
  });

  it('без истории назначений замок остаётся снимочным', async () => {
    pgQuery.mockResolvedValueOnce([candidates('2026-08-30')[0]]).mockResolvedValueOnce([]);

    const locks = await findApprovalLocksForEmployeeDates([{ employeeId: 661, workDate: '2026-08-30' }]);

    expect(locks.get(lockKey(661, '2026-08-30'))).toMatchObject({ id: 1551 });
  });

  it('SQL отдаёт всех кандидатов: приоритетная подача выбирается после проверки владения', async () => {
    await findApprovalLocksForEmployeeDates([{ employeeId: 661, workDate: '2026-08-30' }]);
    const [sql] = pgQuery.mock.calls[0] as [string];
    expect(sql).not.toContain('DISTINCT ON');
    expect(sql).toContain('a.department_id');
  });
});

describe('loadApprovalLocksForEmployeesInPeriod', () => {
  it('режет интервал по дате перевода и склеивает соседние дни', async () => {
    pgQuery
      .mockResolvedValueOnce([
        { employee_id: 661, id: 1551, department_id: 'dept-karimov', start_date: '2026-08-16', end_date: '2026-08-31', status: 'approved' },
      ])
      .mockResolvedValueOnce([
        { employee_id: 661, effective_from: '2026-07-30', effective_to: '2026-08-24', owning_approval_ids: [1551] },
        { employee_id: 661, effective_from: '2026-08-25', effective_to: null, owning_approval_ids: [1428] },
      ]);

    const locks = await loadApprovalLocksForEmployeesInPeriod([661], '2026-08-16', '2026-08-31');

    expect(locks).toEqual([
      { employee_id: 661, start_date: '2026-08-16', end_date: '2026-08-24', status: 'approved' },
    ]);
  });

  it('уход и возврат в бригаду дают два интервала замка', async () => {
    pgQuery
      .mockResolvedValueOnce([
        { employee_id: 661, id: 1551, department_id: 'dept-karimov', start_date: '2026-08-01', end_date: '2026-08-15', status: 'approved' },
      ])
      .mockResolvedValueOnce([
        { employee_id: 661, effective_from: '2026-08-01', effective_to: '2026-08-05', owning_approval_ids: [1551] },
        { employee_id: 661, effective_from: '2026-08-06', effective_to: '2026-08-10', owning_approval_ids: [] },
        { employee_id: 661, effective_from: '2026-08-11', effective_to: null, owning_approval_ids: [1551] },
      ]);

    const locks = await loadApprovalLocksForEmployeesInPeriod([661], '2026-08-01', '2026-08-15');

    expect(locks).toEqual([
      { employee_id: 661, start_date: '2026-08-01', end_date: '2026-08-05', status: 'approved' },
      { employee_id: 661, start_date: '2026-08-11', end_date: '2026-08-15', status: 'approved' },
    ]);
  });

  it('подсветка в гриде тоже игнорирует открытый период', async () => {
    await loadApprovalLocksForEmployeesInPeriod([10], '2026-08-01', '2026-08-15');
    const [sql] = pgQuery.mock.calls[0] as [string];
    expect(sql).toContain("a.status IN ('submitted', 'approved')");
    expect(sql).toContain('a.unlocked_at IS NULL');
  });
});

describe('findApprovalLockForEmployeeDate', () => {
  it('возвращает null, когда замка нет', async () => {
    expect(await findApprovalLockForEmployeeDate(10, '2026-08-05')).toBeNull();
  });

  it('возвращает найденный замок', async () => {
    pgQuery.mockResolvedValue([
      { employee_id: 10, work_date: '2026-08-05', id: 7, start_date: '2026-08-01', end_date: '2026-08-15', status: 'approved' },
    ]);
    expect(await findApprovalLockForEmployeeDate(10, '2026-08-05')).toMatchObject({ id: 7, status: 'approved' });
  });
});

describe('lockTimesheetMonthsOnClient', () => {
  it('берёт advisory-локи по (сотрудник, YYYYMM) в детерминированном порядке без дублей', async () => {
    const calls: unknown[][] = [];
    const client = { query: vi.fn(async (_sql: string, params?: unknown[]) => { calls.push(params ?? []); return { rows: [] }; }) };

    await lockTimesheetMonthsOnClient(client as never, [
      { employeeId: 20, workDate: '2026-09-10' },
      { employeeId: 10, workDate: '2026-08-31' },
      { employeeId: 10, workDate: '2026-08-01' },
      { employeeId: 10, workDate: '2026-07-15' },
    ]);

    expect(calls).toEqual([[10, 202607], [10, 202608], [20, 202609]]);
    expect(client.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock($1::int, $2::int)', expect.anything(),
    );
  });

  it('ничего не блокирует на пустом наборе', async () => {
    const client = { query: vi.fn() };
    await lockTimesheetMonthsOnClient(client as never, []);
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe('flattenApprovalLockDates', () => {
  it('разворачивает интервалы в отсортированные уникальные даты', () => {
    expect(flattenApprovalLockDates([
      { employee_id: 1, start_date: '2026-08-03', end_date: '2026-08-05', status: 'submitted' },
      { employee_id: 2, start_date: '2026-08-04', end_date: '2026-08-04', status: 'approved' },
    ])).toEqual(['2026-08-03', '2026-08-04', '2026-08-05']);
  });

  it('переход через границу месяца не ломает разворот', () => {
    expect(flattenApprovalLockDates([
      { employee_id: 1, start_date: '2026-08-30', end_date: '2026-09-01', status: 'approved' },
    ])).toEqual(['2026-08-30', '2026-08-31', '2026-09-01']);
  });
});

describe('findApprovalLockForMembershipChange', () => {
  it('открытый период не блокирует изменение состава', async () => {
    await findApprovalLockForMembershipChange({
      employeeId: 10, departmentIds: ['d'], fromDate: '2026-08-05',
    });
    const [sql] = pgQuery.mock.calls[0] as [string];
    expect(sql).toContain('a.unlocked_at IS NULL');
  });

  it('проверяет интервал от даты и оба отдела сразу', async () => {
    pgQuery.mockResolvedValue([
      { id: 9, start_date: '2026-08-01', end_date: '2026-08-15', status: 'submitted' },
    ]);

    const lock = await findApprovalLockForMembershipChange({
      employeeId: 10,
      departmentIds: ['d-old', null, 'd-new', 'd-old'],
      fromDate: '2026-08-05',
    });

    expect(lock).toMatchObject({ id: 9, status: 'submitted' });
    const [sql, params] = pgQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('a.end_date >= $3::date');
    expect(params[1]).toEqual(['d-old', 'd-new']);
    expect(params[3]).toBeNull();
  });

  it('возвращает null для некорректного сотрудника, не ходя в БД', async () => {
    expect(await findApprovalLockForMembershipChange({
      employeeId: 0, departmentIds: ['d'], fromDate: '2026-08-05',
    })).toBeNull();
    expect(pgQuery).not.toHaveBeenCalled();
  });
});
