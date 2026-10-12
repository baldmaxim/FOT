import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

// Закрытие табелей отдела за месяц кадрами. Настоящий SQL: EXCLUDE на пересечение подач,
// FOR UPDATE, advisory-локи, savepoint-цикл исключения уже утверждённых, разбор редакций
// по парам «сотрудник + день», история в той же транзакции. Заглушки — расчёт табеля
// (редакция собирается из снимка состава), членство в отделах и нерешённые выходные.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы пересоздаются).
const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));
vi.mock('../config/postgres.js', async () => {
  const { Pool, types } = await import('pg');
  types.setTypeParser(1082, (val: string) => val);
  types.setTypeParser(20, (val: string) => Number.parseInt(val, 10));
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 5 }) : null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool.query(sql, params as unknown[]);
  };
  return {
    pool: () => pg.pool,
    query: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows[0] ?? null,
    execute: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rowCount ?? 0,
  };
});

/** Оргструктура и состав отделов теста. */
const org = vi.hoisted(() => ({
  tree: [] as Array<{ id: string; parent_id: string | null; name: string; sigur_department_id: number | null }>,
  direct: new Map<string, number[]>(),
}));
const subtreeIds = (rootId: string): string[] => {
  const ids = [rootId];
  for (let i = 0; i < ids.length; i += 1) {
    for (const node of org.tree) if (node.parent_id === ids[i]) ids.push(node.id);
  }
  return ids;
};

vi.mock('./skud-shared.service.js', async (importActual) => ({
  ...(await importActual<typeof import('./skud-shared.service.js')>()),
  getAllDepartmentsTree: vi.fn(async () => org.tree),
  collectDeptIds: vi.fn(async (departmentId: string) => subtreeIds(departmentId)),
}));

// Как в бою: состав подачи отдела раскрывает поддерево, членство экспорта — точный отдел.
vi.mock('./timesheet-department-assignments.service.js', async (importActual) => ({
  ...(await importActual<typeof import('./timesheet-department-assignments.service.js')>()),
  listEmployeeIdsAssignedToDepartmentPeriod: vi.fn(async (departmentId: string) => (
    subtreeIds(departmentId).flatMap(id => org.direct.get(id) ?? [])
  )),
  listScopedMembersByDepartment: vi.fn(async (departmentIds: string[]) => {
    const result = new Map<number, string>();
    for (const id of departmentIds) for (const employeeId of org.direct.get(id) ?? []) result.set(employeeId, id);
    return result;
  }),
}));

const pending = vi.hoisted(() => ({ precheck: 0, inTransaction: 0 }));
vi.mock('./timesheet-pending-decisions.service.js', () => ({
  listPendingDecisionFacts: vi.fn(async () => ({ days: [], requests: [] })),
  countPendingDecisionDays: vi.fn(() => pending.precheck),
  countPendingDecisionsForApproval: vi.fn(async (_approval: unknown, exec?: unknown) => (
    exec ? pending.inTransaction : pending.precheck
  )),
}));

const { relinkMock } = vi.hoisted(() => ({ relinkMock: vi.fn(async () => undefined) }));
vi.mock('./timesheet-approval-attachments.service.js', () => ({ relinkApprovalAttachments: relinkMock }));

/** Редакция = снимок состава × дни сотрудника (по умолчанию — весь диапазон подачи). */
const version = vi.hoisted(() => ({
  daysByEmployee: new Map<number, string[]>(),
  failWith: null as unknown,
  calls: 0,
}));
vi.mock('./timesheet-version.service.js', async (importActual) => {
  const actual = await importActual<typeof import('./timesheet-version.service.js')>();
  const allDays = (startDate: string, endDate: string): string[] => {
    const result: string[] = [];
    const cursor = new Date(`${startDate}T00:00:00Z`);
    const stop = new Date(`${endDate}T00:00:00Z`);
    while (cursor <= stop) {
      result.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return result;
  };
  return {
    ...actual,
    clearVersionDirty: vi.fn(async () => undefined),
    materializeVersion: vi.fn(async (
      client: import('pg').PoolClient,
      approval: { id: number; start_date: string; end_date: string },
      source: string,
    ) => {
      version.calls += 1;
      if (version.failWith) throw version.failWith;
      const roster = (await client.query<{ employee_id: number | string }>(
        'SELECT employee_id FROM timesheet_approval_employees WHERE approval_id = $1 ORDER BY employee_id',
        [approval.id],
      )).rows;
      if (roster.length === 0) throw new actual.TimesheetVersionEmptyRosterError(approval.id);
      const employees = roster.map(row => {
        const employeeId = Number(row.employee_id);
        const dayList = (version.daysByEmployee.get(employeeId) ?? allDays(approval.start_date, approval.end_date))
          .filter(day => day >= approval.start_date && day <= approval.end_date);
        return {
          identity: { employee_id: employeeId },
          zero_activity: dayList.length === 0,
          days: Object.fromEntries(dayList.map(day => [day, { status: 'Я', hours: 8 }])),
        };
      });
      const revision = Number((await client.query<{ revision: number }>(
        'SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM timesheet_versions WHERE approval_id = $1',
        [approval.id],
      )).rows[0].revision);
      await client.query(
        'INSERT INTO timesheet_versions (approval_id, revision, payload, source) VALUES ($1, $2, $3::jsonb, $4)',
        [approval.id, revision, JSON.stringify({ employees }), source],
      );
      return { version: { revision }, created: true };
    }),
  };
});

import { closeDepartmentMonth, MONTH_CLOSE_COMMENT } from './timesheet-month-close.service.js';

const COMPANY = '00000000-0000-4000-8000-0000000000a0';
const DEPARTMENT = '00000000-0000-4000-8000-0000000000a1'; // узел-группа
const BRIGADE_A = '00000000-0000-4000-8000-0000000000a2';
const BRIGADE_B = '00000000-0000-4000-8000-0000000000a3';
const HR_USER = '00000000-0000-4000-8000-0000000000f1';
const MANAGER_USER = '00000000-0000-4000-8000-0000000000f2';
const MONTH = '2026-09';

const IVANOV = 101;
const PETROV = 102;
const SIDOROV = 103; // бригада B
const MANAGER = 900; // руководитель с личной подачей «по людям»

const q = async <T extends import('pg').QueryResultRow>(sql: string, params?: unknown[]) =>
  (await pg.pool!.query<T>(sql, params)).rows;

const septemberDays = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_unused, index) => `2026-09-${String(from + index).padStart(2, '0')}`);

interface IApprovalRow {
  id: number;
  department_id: string | null;
  start_date: string;
  end_date: string;
  status: string;
  submitted_by: string | null;
  reviewed_by: string | null;
  review_comment: string | null;
  unlocked_at: string | null;
}

const approvalsOf = (departmentId: string) => q<IApprovalRow>(
  `SELECT id, department_id, start_date, end_date, status, submitted_by, reviewed_by, review_comment, unlocked_at
     FROM timesheet_approvals WHERE department_id = $1 ORDER BY start_date, id`,
  [departmentId],
);

const rosterOf = async (approvalId: number): Promise<number[]> => (
  await q<{ employee_id: number }>(
    'SELECT employee_id FROM timesheet_approval_employees WHERE approval_id = $1 ORDER BY employee_id',
    [approvalId],
  )
).map(row => Number(row.employee_id));

const eventsOf = (departmentId: string) => q<{
  approval_id: number; action: string; from_status: string | null; to_status: string; metadata: Record<string, unknown>;
}>(
  `SELECT approval_id, action, from_status, to_status, metadata
     FROM timesheet_approval_events WHERE department_id = $1 ORDER BY id`,
  [departmentId],
);

const insertApproval = async (input: {
  departmentId?: string | null;
  managerEmployeeId?: number | null;
  startDate: string;
  endDate: string;
  status: string;
  roster?: number[];
  /** Дни сотрудников в готовой редакции (для утверждённых). */
  versionDays?: Record<number, string[]>;
  unlocked?: boolean;
}): Promise<number> => {
  const [row] = await q<{ id: number }>(
    `INSERT INTO timesheet_approvals (department_id, manager_employee_id, start_date, end_date, status,
       submitted_by, submitted_at, unlocked_at)
     VALUES ($1, $2, $3, $4, $5, $6, now(), $7)
     RETURNING id`,
    [
      input.departmentId ?? null, input.managerEmployeeId ?? null, input.startDate, input.endDate, input.status,
      input.status === 'draft' ? null : MANAGER_USER,
      input.unlocked ? new Date().toISOString() : null,
    ],
  );
  for (const employeeId of input.roster ?? []) {
    await q('INSERT INTO timesheet_approval_employees (approval_id, employee_id) VALUES ($1, $2)', [row.id, employeeId]);
  }
  if (input.versionDays) {
    const employees = Object.entries(input.versionDays).map(([employeeId, dayList]) => ({
      identity: { employee_id: Number(employeeId) },
      zero_activity: false,
      days: Object.fromEntries(dayList.map(day => [day, { status: 'Я', hours: 8 }])),
    }));
    await q(
      `INSERT INTO timesheet_versions (approval_id, revision, payload, source) VALUES ($1, 1, $2::jsonb, 'approve')`,
      [row.id, JSON.stringify({ employees })],
    );
  }
  return row.id;
};

describe.skipIf(!PG_URL)('закрытие табелей отдела за месяц (PostgreSQL)', () => {
  beforeAll(async () => {
    await pg.pool!.query(`
      CREATE EXTENSION IF NOT EXISTS btree_gist;
      DROP TABLE IF EXISTS timesheet_approval_events, timesheet_versions, timesheet_approval_employees,
        timesheet_approvals, employees, org_departments CASCADE;
      CREATE TABLE org_departments (id uuid PRIMARY KEY, name text NOT NULL, parent_id uuid NULL);
      CREATE TABLE employees (id integer PRIMARY KEY, full_name text NULL);
      CREATE TABLE timesheet_approvals (
        id bigserial PRIMARY KEY, department_id uuid NULL, manager_employee_id integer NULL,
        start_date date NOT NULL, end_date date NOT NULL, status text NOT NULL DEFAULT 'draft',
        submitted_by uuid NULL, submitted_at timestamptz NULL, reviewed_by uuid NULL, reviewed_at timestamptz NULL,
        review_comment text NULL, unlocked_at timestamptz NULL, unlocked_by uuid NULL, unlock_reason text NULL,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT timesheet_approvals_unlock_status_check
          CHECK (unlocked_at IS NULL OR status IN ('submitted', 'approved')),
        CONSTRAINT timesheet_approvals_dept_no_overlap EXCLUDE USING gist (
          department_id WITH =, daterange(start_date, end_date, '[]') WITH &&
        ) WHERE (status IN ('submitted', 'approved', 'returned') AND department_id IS NOT NULL)
      );
      CREATE TABLE timesheet_approval_employees (
        approval_id bigint NOT NULL REFERENCES timesheet_approvals(id) ON DELETE CASCADE,
        employee_id bigint NOT NULL, full_name text NULL,
        PRIMARY KEY (approval_id, employee_id)
      );
      CREATE TABLE timesheet_versions (
        id bigserial PRIMARY KEY, approval_id bigint NOT NULL, revision integer NOT NULL,
        payload jsonb NOT NULL, source text NULL
      );
      CREATE TABLE timesheet_approval_events (
        id bigserial PRIMARY KEY,
        approval_id bigint NOT NULL REFERENCES timesheet_approvals(id) ON DELETE CASCADE,
        department_id uuid NULL, start_date date NOT NULL, end_date date NOT NULL,
        action text NOT NULL, from_status text NULL, to_status text NOT NULL,
        actor_user_id uuid NOT NULL, comment text NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await pg.pool!.query(`TRUNCATE timesheet_approval_events, timesheet_versions, timesheet_approval_employees,
      timesheet_approvals, employees, org_departments RESTART IDENTITY CASCADE`);
    await q(
      `INSERT INTO org_departments (id, name, parent_id) VALUES
        ($1, 'СУ-10', NULL), ($2, 'Департамент строительства', $1), ($3, 'бр.А', $2), ($4, 'бр.Б', $2)`,
      [COMPANY, DEPARTMENT, BRIGADE_A, BRIGADE_B],
    );
    await q(
      `INSERT INTO employees (id, full_name) VALUES
        ($1, 'Иванов Иван Иванович'), ($2, 'Петров Пётр Петрович'), ($3, 'Сидоров Сидор Сидорович'),
        ($4, 'Начальников Олег Олегович')`,
      [IVANOV, PETROV, SIDOROV, MANAGER],
    );
    org.tree = [
      { id: COMPANY, parent_id: null, name: 'СУ-10', sigur_department_id: null },
      { id: DEPARTMENT, parent_id: COMPANY, name: 'Департамент строительства', sigur_department_id: null },
      { id: BRIGADE_A, parent_id: DEPARTMENT, name: 'бр.А', sigur_department_id: null },
      { id: BRIGADE_B, parent_id: DEPARTMENT, name: 'бр.Б', sigur_department_id: null },
    ];
    org.direct = new Map([[BRIGADE_A, [IVANOV, PETROV]], [BRIGADE_B, [SIDOROV]]]);
    pending.precheck = 0;
    pending.inTransaction = 0;
    version.daysByEmployee = new Map();
    version.failWith = null;
    version.calls = 0;
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('неподанный лист: две утверждённые подачи по полупериодам, без автора подачи, с историей', async () => {
    const result = await closeDepartmentMonth(HR_USER, BRIGADE_A, MONTH);

    expect(result.errors).toEqual([]);
    expect(result.halves).toEqual([
      { start_date: '2026-09-01', end_date: '2026-09-15', status: 'closed' },
      { start_date: '2026-09-16', end_date: '2026-09-30', status: 'closed' },
    ]);
    const rows = await approvalsOf(BRIGADE_A);
    expect(rows.map(row => [row.start_date, row.end_date, row.status])).toEqual([
      ['2026-09-01', '2026-09-15', 'approved'],
      ['2026-09-16', '2026-09-30', 'approved'],
    ]);
    for (const row of rows) {
      expect(row.submitted_by).toBeNull();
      expect(row.reviewed_by).toBe(HR_USER);
      expect(row.review_comment).toBe(MONTH_CLOSE_COMMENT);
      expect(row.unlocked_at).toBeNull();
      expect(await rosterOf(row.id)).toEqual([IVANOV, PETROV]);
    }
    expect(result.changes.map(change => [change.approvalId, change.kind, change.fromStatus])).toEqual([
      [rows[0].id, 'approved', null],
      [rows[1].id, 'approved', null],
    ]);
    // Событие — по каждой изменённой подаче, а не одно на отдел.
    expect(await eventsOf(BRIGADE_A)).toEqual([
      { approval_id: rows[0].id, action: 'approved', from_status: null, to_status: 'approved',
        metadata: { source: 'month_close', forced: true, excluded_count: 0 } },
      { approval_id: rows[1].id, action: 'approved', from_status: null, to_status: 'approved',
        metadata: { source: 'month_close', forced: true, excluded_count: 0 } },
    ]);
  });

  it('повторный запуск ничего не меняет: ни подач, ни событий, ни редакций', async () => {
    await closeDepartmentMonth(HR_USER, BRIGADE_A, MONTH);
    const versionsBefore = await q('SELECT id FROM timesheet_versions');
    const eventsBefore = await eventsOf(BRIGADE_A);
    version.calls = 0;

    const again = await closeDepartmentMonth(HR_USER, BRIGADE_A, MONTH);

    expect(again.halves.map(half => half.status)).toEqual(['already_closed', 'already_closed']);
    expect(again.changes).toEqual([]);
    expect(version.calls).toBe(0);
    expect(await q('SELECT id FROM timesheet_versions')).toHaveLength(versionsBefore.length);
    expect(await eventsOf(BRIGADE_A)).toEqual(eventsBefore);
  });

  it('родитель вместе с детьми: узел-группа не утверждается, дети утверждаются своими подачами', async () => {
    const parent = await closeDepartmentMonth(HR_USER, DEPARTMENT, MONTH);
    const brigadeA = await closeDepartmentMonth(HR_USER, BRIGADE_A, MONTH);
    const brigadeB = await closeDepartmentMonth(HR_USER, BRIGADE_B, MONTH);

    expect(parent.halves.map(half => half.status)).toEqual(['no_employees', 'no_employees']);
    expect(parent.changes).toEqual([]);
    expect(await approvalsOf(DEPARTMENT)).toEqual([]);
    expect(brigadeA.halves.map(half => half.status)).toEqual(['closed', 'closed']);
    expect(brigadeB.halves.map(half => half.status)).toEqual(['closed', 'closed']);
    const [firstB] = await approvalsOf(BRIGADE_B);
    expect(await rosterOf(firstB.id)).toEqual([SIDOROV]);
  });

  it('узел-группа со своими сотрудниками пропускается с причиной', async () => {
    org.direct.set(DEPARTMENT, [MANAGER]);

    const result = await closeDepartmentMonth(HR_USER, DEPARTMENT, MONTH);

    expect(result.halves.map(half => half.status)).toEqual(['skipped', 'skipped']);
    expect(result.halves[0].reason).toContain('подотделы');
    expect(await approvalsOf(DEPARTMENT)).toEqual([]);
  });

  it('утверждённая строка «весь месяц» покрывает оба полупериода', async () => {
    await insertApproval({
      departmentId: BRIGADE_A, startDate: '2026-09-01', endDate: '2026-09-30', status: 'approved',
      roster: [IVANOV, PETROV],
    });

    const result = await closeDepartmentMonth(HR_USER, BRIGADE_A, MONTH);

    expect(result.halves.map(half => half.status)).toEqual(['already_closed', 'already_closed']);
    expect(await approvalsOf(BRIGADE_A)).toHaveLength(1);
    expect(version.calls).toBe(0);
  });

  it('возвращённая строка «весь месяц» утверждается в своём диапазоне — одна подача, одно событие', async () => {
    const returnedId = await insertApproval({
      departmentId: BRIGADE_A, startDate: '2026-09-01', endDate: '2026-09-30', status: 'returned',
      roster: [IVANOV],
    });

    const result = await closeDepartmentMonth(HR_USER, BRIGADE_A, MONTH);

    expect(result.halves.map(half => half.status)).toEqual(['closed', 'closed']);
    const rows = await approvalsOf(BRIGADE_A);
    expect(rows.map(row => [row.id, row.start_date, row.end_date, row.status])).toEqual([
      [returnedId, '2026-09-01', '2026-09-30', 'approved'],
    ]);
    // Состав пересобран по текущему членству, а не оставлен от прежней подачи.
    expect(await rosterOf(returnedId)).toEqual([IVANOV, PETROV]);
    expect(result.changes).toEqual([{
      approvalId: returnedId, kind: 'approved', fromStatus: 'returned',
      startDate: '2026-09-01', endDate: '2026-09-30', submittedBy: null,
    }]);
    expect((await eventsOf(BRIGADE_A)).map(event => [event.approval_id, event.from_status])).toEqual([
      [returnedId, 'returned'],
    ]);
  });

  it('черновик точного диапазона переиспользуется, прочие черновики вытесняются с переносом вложений', async () => {
    const exactDraft = await insertApproval({
      departmentId: BRIGADE_A, startDate: '2026-09-01', endDate: '2026-09-15', status: 'draft',
    });
    const wideDraft = await insertApproval({
      departmentId: BRIGADE_A, startDate: '2026-09-01', endDate: '2026-09-30', status: 'draft',
    });

    const result = await closeDepartmentMonth(HR_USER, BRIGADE_A, MONTH);

    expect(result.halves.map(half => half.status)).toEqual(['closed', 'closed']);
    const rows = await approvalsOf(BRIGADE_A);
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(exactDraft);
    expect(rows.every(row => row.status === 'approved')).toBe(true);
    expect(rows.some(row => row.id === wideDraft)).toBe(false);
    expect(relinkMock).toHaveBeenCalledWith(expect.anything(), [wideDraft], exactDraft);
    expect(result.changes[0].fromStatus).toBe('draft');
  });

  it('сотрудник, утверждённый в личной подаче целиком, в подачу отдела не попадает', async () => {
    await insertApproval({
      managerEmployeeId: MANAGER, startDate: '2026-09-01', endDate: '2026-09-15', status: 'approved',
      roster: [PETROV], versionDays: { [PETROV]: septemberDays(1, 15) },
    });

    const result = await closeDepartmentMonth(HR_USER, BRIGADE_A, MONTH);

    expect(result.halves).toEqual([
      { start_date: '2026-09-01', end_date: '2026-09-15', status: 'closed', excluded_count: 1 },
      { start_date: '2026-09-16', end_date: '2026-09-30', status: 'closed' },
    ]);
    const [first, second] = await approvalsOf(BRIGADE_A);
    expect(await rosterOf(first.id)).toEqual([IVANOV]);
    expect(await rosterOf(second.id)).toEqual([IVANOV, PETROV]);
    // Отброшенная редакция с лишним сотрудником откатилась — осталась одна, без него.
    const versions = await q<{ payload: { employees: Array<{ identity: { employee_id: number } }> } }>(
      'SELECT payload FROM timesheet_versions WHERE approval_id = $1',
      [first.id],
    );
    expect(versions).toHaveLength(1);
    expect(versions[0].payload.employees.map(employee => employee.identity.employee_id)).toEqual([IVANOV]);
  });

  it('весь состав уже утверждён в других подачах — подача не создаётся', async () => {
    await insertApproval({
      managerEmployeeId: MANAGER, startDate: '2026-09-01', endDate: '2026-09-15', status: 'approved',
      roster: [IVANOV, PETROV],
      versionDays: { [IVANOV]: septemberDays(1, 15), [PETROV]: septemberDays(1, 15) },
    });

    const result = await closeDepartmentMonth(HR_USER, BRIGADE_A, MONTH);

    expect(result.halves.map(half => half.status)).toEqual(['covered_elsewhere', 'closed']);
    expect((await approvalsOf(BRIGADE_A)).map(row => row.start_date)).toEqual(['2026-09-16']);
    expect(result.changes).toHaveLength(1);
  });

  it('покрыта только часть дней сотрудника — отдел пропускается, ничего не записано', async () => {
    await insertApproval({
      managerEmployeeId: MANAGER, startDate: '2026-09-01', endDate: '2026-09-15', status: 'approved',
      roster: [PETROV], versionDays: { [PETROV]: septemberDays(1, 7) },
    });

    const result = await closeDepartmentMonth(HR_USER, BRIGADE_A, MONTH);

    expect(result.halves[0].status).toBe('skipped');
    expect(result.halves[0].reason).toContain('Петров П. П.');
    expect(result.halves[1].status).toBe('closed');
    expect((await approvalsOf(BRIGADE_A)).map(row => row.start_date)).toEqual(['2026-09-16']);
    expect((await eventsOf(BRIGADE_A))).toHaveLength(1);
  });

  it('день в двух чужих подачах считается один раз: покрыт весь — исключаем', async () => {
    // Дни 1–10 и 8–15 в двух личных подачах: вместе закрывают все 15 дней сотрудника.
    await insertApproval({
      managerEmployeeId: MANAGER, startDate: '2026-09-01', endDate: '2026-09-15', status: 'approved',
      roster: [PETROV], versionDays: { [PETROV]: septemberDays(1, 10) },
    });
    await insertApproval({
      managerEmployeeId: MANAGER + 1, startDate: '2026-09-01', endDate: '2026-09-15', status: 'approved',
      roster: [PETROV], versionDays: { [PETROV]: septemberDays(8, 15) },
    });

    const result = await closeDepartmentMonth(HR_USER, BRIGADE_A, MONTH);

    expect(result.halves[0]).toEqual({
      start_date: '2026-09-01', end_date: '2026-09-15', status: 'closed', excluded_count: 1,
    });
  });

  it('утверждённая, но открытая: возвращается замок, фиксируется редакция, события истории нет', async () => {
    const approvalId = await insertApproval({
      departmentId: BRIGADE_A, startDate: '2026-09-01', endDate: '2026-09-15', status: 'approved',
      roster: [IVANOV, PETROV], unlocked: true,
    });
    await insertApproval({
      departmentId: BRIGADE_A, startDate: '2026-09-16', endDate: '2026-09-30', status: 'approved',
      roster: [IVANOV, PETROV],
    });

    const result = await closeDepartmentMonth(HR_USER, BRIGADE_A, MONTH);

    expect(result.halves.map(half => half.status)).toEqual(['closed', 'already_closed']);
    expect(result.changes).toEqual([{
      approvalId, kind: 'closed', fromStatus: 'approved',
      startDate: '2026-09-01', endDate: '2026-09-15', submittedBy: MANAGER_USER,
    }]);
    const [row] = await approvalsOf(BRIGADE_A);
    expect(row.unlocked_at).toBeNull();
    expect(await q(`SELECT 1 FROM timesheet_versions WHERE approval_id = $1 AND source = 'close'`, [approvalId]))
      .toHaveLength(1);
    expect(await eventsOf(BRIGADE_A)).toEqual([]);
  });

  it('поданная и открытая: утверждается со своим составом, замок возвращён, автор подачи сохранён', async () => {
    const approvalId = await insertApproval({
      departmentId: BRIGADE_A, startDate: '2026-09-01', endDate: '2026-09-15', status: 'submitted',
      roster: [IVANOV], unlocked: true,
    });

    const result = await closeDepartmentMonth(HR_USER, BRIGADE_A, MONTH);

    expect(result.halves[0].status).toBe('closed');
    const [row] = await approvalsOf(BRIGADE_A);
    expect([row.id, row.status, row.unlocked_at, row.submitted_by, row.reviewed_by]).toEqual([
      approvalId, 'approved', null, MANAGER_USER, HR_USER,
    ]);
    // Состав поданной подачи не пересобираем — утверждаем то, что подал руководитель.
    expect(await rosterOf(approvalId)).toEqual([IVANOV]);
    expect((await eventsOf(BRIGADE_A))[0]).toMatchObject({
      approval_id: approvalId, from_status: 'submitted', metadata: { source: 'month_close', forced: false },
    });
  });

  it('нерешённые выходные: поданная остаётся поданной, неподанная не создаётся', async () => {
    const submittedId = await insertApproval({
      departmentId: BRIGADE_A, startDate: '2026-09-01', endDate: '2026-09-15', status: 'submitted',
      roster: [IVANOV],
    });
    pending.precheck = 2;

    const result = await closeDepartmentMonth(HR_USER, BRIGADE_A, MONTH);

    expect(result.halves.map(half => [half.status, half.reason])).toEqual([
      ['skipped', 'Ждёт согласования выходных (дней: 2)'],
      ['skipped', 'Ждёт согласования выходных (дней: 2)'],
    ]);
    expect((await approvalsOf(BRIGADE_A)).map(row => [row.id, row.status])).toEqual([[submittedId, 'submitted']]);
    expect(version.calls).toBe(0);
  });

  it('выходные появились уже под локами — транзакция откатывается целиком', async () => {
    pending.inTransaction = 1;

    const result = await closeDepartmentMonth(HR_USER, BRIGADE_A, MONTH);

    expect(result.halves.map(half => half.status)).toEqual(['skipped', 'skipped']);
    expect(await approvalsOf(BRIGADE_A)).toEqual([]);
    expect(await q('SELECT 1 FROM timesheet_approval_employees')).toEqual([]);
  });

  it('подача за нестандартный период не трогается', async () => {
    await insertApproval({
      departmentId: BRIGADE_A, startDate: '2026-09-01', endDate: '2026-09-07', status: 'approved',
      roster: [IVANOV],
    });

    const result = await closeDepartmentMonth(HR_USER, BRIGADE_A, MONTH);

    expect(result.halves[0].status).toBe('skipped');
    expect(result.halves[0].reason).toContain('нестандартный период');
    expect(result.halves[1].status).toBe('closed');
  });

  it('подача вышестоящего отдела: утверждённая — уже закрыто, поданная — пропуск', async () => {
    await insertApproval({
      departmentId: DEPARTMENT, startDate: '2026-09-01', endDate: '2026-09-15', status: 'approved',
      roster: [IVANOV, PETROV, SIDOROV],
    });
    await insertApproval({
      departmentId: DEPARTMENT, startDate: '2026-09-16', endDate: '2026-09-30', status: 'submitted',
      roster: [IVANOV, PETROV, SIDOROV],
    });

    const result = await closeDepartmentMonth(HR_USER, BRIGADE_A, MONTH);

    expect(result.halves[0].status).toBe('already_closed');
    expect(result.halves[1].status).toBe('skipped');
    expect(result.halves[1].reason).toContain('Департамент строительства');
    expect(await approvalsOf(BRIGADE_A)).toEqual([]);
  });

  it('отказ расчёта редакции и пересечение подач в БД — пропуск с причиной, без записи', async () => {
    version.failWith = Object.assign(new Error('conflicting key value violates exclusion constraint'), { code: '23P01' });

    const result = await closeDepartmentMonth(HR_USER, BRIGADE_A, MONTH);

    expect(result.errors).toEqual([]);
    expect(result.halves.map(half => half.status)).toEqual(['skipped', 'skipped']);
    expect(result.halves[0].reason).toContain('пересекается');
    expect(await approvalsOf(BRIGADE_A)).toEqual([]);
  });

  it('непредвиденная ошибка одного полупериода не теряет закрытый другой', async () => {
    const { materializeVersion } = await import('./timesheet-version.service.js');
    vi.mocked(materializeVersion).mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const result = await closeDepartmentMonth(HR_USER, BRIGADE_A, MONTH);

    expect(result.errors).toHaveLength(1);
    expect(result.halves.map(half => half.status)).toEqual(['skipped', 'closed']);
    expect(result.changes).toHaveLength(1);
    expect((await approvalsOf(BRIGADE_A)).map(row => row.start_date)).toEqual(['2026-09-16']);
  });

  it('отдел без сотрудников — подача не создаётся', async () => {
    org.direct.set(BRIGADE_A, []);

    const result = await closeDepartmentMonth(HR_USER, BRIGADE_A, MONTH);

    expect(result.halves.map(half => half.status)).toEqual(['no_employees', 'no_employees']);
    expect(await approvalsOf(BRIGADE_A)).toEqual([]);
  });
});
