import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { PoolClient } from 'pg';

/**
 * Переход «ждёт согласования выходных» → «готов к утверждению» на НАСТОЯЩЕМ PostgreSQL.
 *
 * Мок не докажет главного: две параллельные «последние» мутации дают ровно одно
 * уведомление, повтор решения — ни одного, цикл «готов → новое заявление → снова готов» —
 * второе; затронутые табели находятся все; запись в строку табеля выбивает параллельное
 * HR-утверждение (REPEATABLE READ) в повтор со свежим снимком.
 *
 * Запуск: FOT_TEST_PG_URL=postgres://... npx vitest run src/services/timesheet-pending-decisions.pg.test.ts
 * Без переменной набор скипается. БД — пустая тестовая: срез таблиц пересоздаётся.
 */
const PG_URL = process.env.FOT_TEST_PG_URL;
const describeIf = PG_URL ? describe : describe.skip;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));
vi.mock('../config/postgres.js', async () => {
  const { Pool, types } = await import('pg');
  types.setTypeParser(1082, (val: string) => val);
  types.setTypeParser(20, (val: string) => Number.parseInt(val, 10));
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 6 }) : null;
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

// Дерево отделов — справочник за кэшем; для среза хватает «отдел = сам отдел».
vi.mock('./skud-shared.service.js', async (importActual) => ({
  ...(await importActual<typeof import('./skud-shared.service.js')>()),
  collectDeptIds: vi.fn(async (departmentId: string) => [departmentId]),
}));
// Завершённость месяца зависит от сегодняшней даты — фиксируем: сентябрь 2026 завершён,
// октябрь ещё идёт.
vi.mock('./timesheet-period.service.js', async (importActual) => ({
  ...(await importActual<typeof import('./timesheet-period.service.js')>()),
  isRangeWithinCompletedPeriods: vi.fn((startDate: string) => startDate < '2026-10-01'),
}));
const HR_USER = '44444444-4444-4444-4444-444444444444';
vi.mock('./timesheet-workflow-recipients.service.js', () => ({
  listTimesheetWorkflowRecipientIds: vi.fn(async () => [HR_USER]),
}));
vi.mock('./push.service.js', () => ({ pushService: { sendGenericNotification: vi.fn(async () => []) } }));
vi.mock('./realtime-broadcast.service.js', () => ({ emitDomainChange: vi.fn() }));
vi.mock('../socket/io-instance.js', () => ({ getIo: vi.fn(() => null) }));

import { countPendingDecisionsForApproval } from './timesheet-pending-decisions.service.js';
import {
  lockAffectedApprovals,
  withPendingDecisionTracking,
} from './timesheet-pending-decisions-tracking.service.js';
import { listTimesheetWorkflowRecipientIds } from './timesheet-workflow-recipients.service.js';

const PARENT = '00000000-0000-4000-8000-0000000000a1';
const DISPATCH = '00000000-0000-4000-8000-0000000000a2';
const MANAGER_USER = '55555555-5555-5555-5555-555555555555';
const DEMCHUK = 523;
const SARY = 1600;
const CHEPIKOV = 2063;
const PERIOD = { start: '2026-09-01', end: '2026-09-15' };

const SLICE_SQL = `
DROP TABLE IF EXISTS notifications, leave_requests, attendance_adjustments, timesheet_approval_employees,
  timesheet_approvals, employee_dismissal_events, employee_assignments, employees, org_departments CASCADE;
CREATE TABLE org_departments (id uuid PRIMARY KEY, parent_id uuid, name text);
CREATE TABLE employees (
  id integer PRIMARY KEY, org_department_id uuid, full_name text,
  employment_status text NOT NULL DEFAULT 'active', dismissal_date date,
  is_archived boolean NOT NULL DEFAULT false,
  excluded_from_timesheet boolean NOT NULL DEFAULT false, excluded_from_timesheet_date date
);
CREATE TABLE employee_assignments (
  id bigserial PRIMARY KEY, employee_id integer NOT NULL, org_department_id uuid,
  effective_from date NOT NULL, effective_to date
);
CREATE TABLE employee_dismissal_events (
  id bigserial PRIMARY KEY, employee_id integer NOT NULL, from_department_id uuid,
  dismissal_date date, cancelled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE timesheet_approvals (
  id bigserial PRIMARY KEY, department_id uuid, manager_employee_id integer,
  start_date date NOT NULL, end_date date NOT NULL, status text NOT NULL,
  submitted_by uuid, unlocked_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE timesheet_approval_employees (approval_id bigint NOT NULL, employee_id integer NOT NULL, full_name text);
CREATE TABLE attendance_adjustments (
  id bigserial PRIMARY KEY, employee_id integer NOT NULL, work_date date NOT NULL,
  status text NOT NULL DEFAULT 'work', source_type text, source_id text, approval_status text NOT NULL
);
CREATE TABLE leave_requests (
  id bigserial PRIMARY KEY, employee_id integer NOT NULL, request_type text NOT NULL, status text NOT NULL,
  start_date date NOT NULL, end_date date NOT NULL, selected_dates date[]
);
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, type text NOT NULL,
  title text NOT NULL, body text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}',
  is_read boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
`;

const q = async <T extends import('pg').QueryResultRow>(sql: string, params?: unknown[]) =>
  (await pg.pool!.query<T>(sql, params)).rows;

/** Транзакция на отдельном соединении — как withTransaction приложения. */
async function inTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pg.pool!.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const monthKey = (workDate: string): number => Number(workDate.slice(0, 4)) * 100 + Number(workDate.slice(5, 7));

/** Решение по дню у согласующего — под месячным локом сотрудника и трекингом, как в контроллере. */
const decideDay = (adjustmentId: number, employeeId: number, workDate: string) => inTx(async client => {
  await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [employeeId, monthKey(workDate)]);
  return withPendingDecisionTracking(client, [{ employeeId, workDate }], async () => {
    const updated = await client.query(
      `UPDATE attendance_adjustments SET approval_status = 'approved'
        WHERE id = $1 AND approval_status = 'pending' RETURNING id`,
      [adjustmentId],
    );
    return { value: updated.rowCount ?? 0, changed: (updated.rowCount ?? 0) > 0 };
  });
});

const readyCount = async (): Promise<number> => Number((await q<{ n: string }>(
  `SELECT count(*) AS n FROM notifications WHERE type = 'timesheet_approval_ready'`,
))[0].n);

interface INote {
  type: string;
  user_id: string;
  body: string;
  metadata: { approvalId?: number; departmentId?: string; start_date: string; end_date: string };
}
const notesOf = (type: string) => q<INote>(
  'SELECT type, user_id, body, metadata FROM notifications WHERE type = $1 ORDER BY created_at, id', [type],
);
const closeReadyNotes = () => notesOf('timesheet_close_ready');

describeIf('нерешённые выходные: переход «готов к утверждению» (реальный PG)', () => {
  let personalId: number;
  let dayDemchuk: number;
  let daySary: number;

  beforeAll(async () => {
    await pg.pool!.query(SLICE_SQL);
  });

  afterAll(async () => {
    await pg.pool?.query(`DROP TABLE IF EXISTS notifications, leave_requests, attendance_adjustments,
      timesheet_approval_employees, timesheet_approvals, employee_dismissal_events, employee_assignments,
      employees, org_departments CASCADE`);
    await pg.pool?.end();
  });

  beforeEach(async () => {
    await q(`TRUNCATE notifications, leave_requests, attendance_adjustments, timesheet_approval_employees,
      timesheet_approvals, employee_dismissal_events, employee_assignments, employees, org_departments RESTART IDENTITY`);
    await q(`INSERT INTO org_departments (id, parent_id, name) VALUES ($1, NULL, 'СУ-10'), ($2, $1, 'Диспетчерская служба')`,
      [PARENT, DISPATCH]);
    await q(`INSERT INTO employees (id, org_department_id, full_name) VALUES
      (${DEMCHUK}, $1, 'Демчук Анна Александровна'),
      (${SARY}, $1, 'Сары Мария Петровна'),
      (${CHEPIKOV}, $2, 'Чепиков Алексей Владимирович')`, [DISPATCH, PARENT]);
    // Персональная подача Чепикова 1–15.09: оба сотрудника в снимке.
    personalId = Number((await q<{ id: string }>(
      `INSERT INTO timesheet_approvals (manager_employee_id, start_date, end_date, status, submitted_by)
       VALUES (${CHEPIKOV}, $1, $2, 'submitted', $3) RETURNING id`,
      [PERIOD.start, PERIOD.end, MANAGER_USER],
    ))[0].id);
    await q(`INSERT INTO timesheet_approval_employees (approval_id, employee_id, full_name) VALUES
      ($1, ${DEMCHUK}, 'Демчук'), ($1, ${SARY}, 'Сары')`, [personalId]);
    // По выходному у каждого ждёт решения ответственного.
    [dayDemchuk, daySary] = (await q<{ id: string }>(
      `INSERT INTO attendance_adjustments (employee_id, work_date, approval_status) VALUES
        (${DEMCHUK}, '2026-09-05', 'pending'), (${SARY}, '2026-09-06', 'pending') RETURNING id`,
    )).map(row => Number(row.id));
  });

  it('две параллельные «последние» решения → ровно одно уведомление; повтор решения — ни одного', async () => {
    expect(await countPendingDecisionsForApproval(
      { id: personalId, department_id: null, manager_employee_id: CHEPIKOV, start_date: PERIOD.start, end_date: PERIOD.end },
    )).toBe(2);

    await Promise.all([
      decideDay(dayDemchuk, DEMCHUK, '2026-09-05'),
      decideDay(daySary, SARY, '2026-09-06'),
    ]);
    expect(await readyCount()).toBe(1);
    const [note] = await q<{ user_id: string; metadata: { approvalId: number } }>(
      `SELECT user_id, metadata FROM notifications WHERE type = 'timesheet_approval_ready'`,
    );
    expect(note.user_id).toBe(HR_USER);
    expect(note.metadata.approvalId).toBe(personalId);

    const retry = await decideDay(dayDemchuk, DEMCHUK, '2026-09-05');
    expect(retry.value).toBe(0);
    expect(retry.effects.notifications).toEqual([]);
    expect(await readyCount()).toBe(1);
  });

  it('цикл «готов → новое заявление → решено» даёт второе уведомление, само заявление — нет', async () => {
    await decideDay(dayDemchuk, DEMCHUK, '2026-09-05');
    await decideDay(daySary, SARY, '2026-09-06');
    expect(await readyCount()).toBe(1);

    const requestId = await inTx(async client => {
      await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [DEMCHUK, 202609]);
      const { value } = await withPendingDecisionTracking(
        client, [{ employeeId: DEMCHUK, workDate: '2026-09-12' }],
        async () => {
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO leave_requests (employee_id, request_type, status, start_date, end_date, selected_dates)
             VALUES (${DEMCHUK}, 'work', 'pending', '2026-09-12', '2026-09-12', ARRAY['2026-09-12']::date[])
             RETURNING id`,
          );
          return { value: Number(inserted.rows[0].id), changed: true };
        },
      );
      return value;
    });
    expect(await readyCount()).toBe(1);

    await inTx(async client => {
      await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [DEMCHUK, 202609]);
      await withPendingDecisionTracking(client, [{ employeeId: DEMCHUK, workDate: '2026-09-12' }], async () => {
        const updated = await client.query(
          `UPDATE leave_requests SET status = 'rejected' WHERE id = $1 AND status = 'pending'`,
          [requestId],
        );
        return { value: null, changed: (updated.rowCount ?? 0) > 0 };
      });
    });
    expect(await readyCount()).toBe(2);
  });

  it('затронутые табели: отделовая, персональная и временно открытая подачи; утверждённая — нет', async () => {
    const insertApproval = async (departmentId: string, status: string, unlocked = false) => Number((await q<{ id: string }>(
      `INSERT INTO timesheet_approvals (department_id, start_date, end_date, status, unlocked_at)
       VALUES ($1, $2, $3, $4, ${unlocked ? 'now()' : 'NULL'}) RETURNING id`,
      [departmentId, PERIOD.start, PERIOD.end, status],
    ))[0].id);
    const dispatchId = await insertApproval(DISPATCH, 'submitted');
    const parentOpenedId = await insertApproval(PARENT, 'submitted', true); // отдел-предок, открыт для правок
    await insertApproval(DISPATCH, 'approved'); // закрыт: решений по нему нет
    const approvedOpenedId = await insertApproval(DISPATCH, 'approved', true); // утверждён, открыт на правки

    const affected = await inTx(client => lockAffectedApprovals(
      client, [{ employeeId: DEMCHUK, workDate: '2026-09-05' }],
    ));

    expect(affected.map(a => [a.id, a.status])).toEqual([
      [personalId, 'submitted'], [dispatchId, 'submitted'], [parentOpenedId, 'submitted'], [approvedOpenedId, 'approved'],
    ].sort((a, b) => Number(a[0]) - Number(b[0])));
  });

  it('новое заявление, закоммиченное во время HR-утверждения, выбивает его в повтор (40001)', async () => {
    const creator = await pg.pool!.connect();
    const hr = await pg.pool!.connect();
    try {
      await creator.query('BEGIN');
      await creator.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [DEMCHUK, 202609]);
      await withPendingDecisionTracking(creator, [{ employeeId: DEMCHUK, workDate: '2026-09-12' }], async () => {
        await creator.query(
          `INSERT INTO leave_requests (employee_id, request_type, status, start_date, end_date)
           VALUES (${DEMCHUK}, 'work', 'pending', '2026-09-12', '2026-09-12')`,
        );
        return { value: null, changed: true };
      });

      // HR-утверждение: REPEATABLE READ и FOR UPDATE строки табеля — ждёт создающего.
      await hr.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const hrLock = hr.query('SELECT id FROM timesheet_approvals WHERE id = $1 FOR UPDATE', [personalId])
        .then(() => 'locked', (error: { code?: string }) => error.code ?? 'error');
      await new Promise(resolve => setTimeout(resolve, 200));
      await creator.query('COMMIT');

      expect(await hrLock).toBe('40001');
      await hr.query('ROLLBACK');
    } finally {
      creator.release();
      hr.release();
    }

    // Повтор со свежим снимком видит заявление: утверждать нельзя.
    expect(await countPendingDecisionsForApproval(
      { id: personalId, department_id: null, manager_employee_id: CHEPIKOV, start_date: PERIOD.start, end_date: PERIOD.end },
    )).toBe(3);
  });

  describe('неподанный табель завершённого месяца → «Табель можно закрыть»', () => {
    const insertDeptApproval = async (
      status: string, start: string, end: string, unlocked = false,
    ) => Number((await q<{ id: string }>(
      `INSERT INTO timesheet_approvals (department_id, start_date, end_date, status, unlocked_at)
       VALUES ($1, $2, $3, $4, ${unlocked ? 'now()' : 'NULL'}) RETURNING id`,
      [DISPATCH, start, end, status],
    ))[0].id);

    beforeEach(async () => {
      // Табель отдела никто не подавал: ни персональной, ни отделовой подачи.
      await q('TRUNCATE timesheet_approval_employees, timesheet_approvals RESTART IDENTITY');
      vi.mocked(listTimesheetWorkflowRecipientIds).mockClear();
    });

    it('решён 1–15, в 16–30 ещё ждёт → уведомления нет; решён последний → ровно одно за весь месяц', async () => {
      await q(`UPDATE attendance_adjustments SET work_date = '2026-09-19' WHERE id = $1`, [daySary]);

      await decideDay(dayDemchuk, DEMCHUK, '2026-09-05');
      expect(await closeReadyNotes()).toEqual([]);

      await decideDay(daySary, SARY, '2026-09-19');
      const notes = await closeReadyNotes();
      expect(notes).toHaveLength(1);
      expect(notes[0].user_id).toBe(HR_USER);
      expect(notes[0].body).toBe(
        'Отдел Диспетчерская служба: табель за 1–30 сен 2026 — выходные согласованы. '
        + 'Выгрузите единый файл для 1С и закройте табель.',
      );
      expect(notes[0].metadata).toMatchObject({ departmentId: DISPATCH, start_date: '2026-09-01', end_date: '2026-09-30' });
      // Только тем, кто закрывает табель: наблюдателям (табельщицам) не шлём.
      expect(vi.mocked(listTimesheetWorkflowRecipientIds).mock.calls).toEqual([[DISPATCH, ['review']]]);
      expect(await readyCount()).toBe(0);
    });

    it('два параллельных «последних» решения по разным сотрудникам → ровно одно уведомление', async () => {
      await Promise.all([
        decideDay(dayDemchuk, DEMCHUK, '2026-09-05'),
        decideDay(daySary, SARY, '2026-09-06'),
      ]);

      expect(await closeReadyNotes()).toHaveLength(1);
    });

    it('параллельно откат по одному сотруднику и «последнее» решение по другому → ложного уведомления нет', async () => {
      // День Демчук уже решён; ждёт только Сары. Откат Демчук возвращает её день в ожидание.
      await q(`UPDATE attendance_adjustments SET approval_status = 'approved' WHERE id = $1`, [dayDemchuk]);

      const reverter = await pg.pool!.connect();
      let decision: Promise<unknown>;
      try {
        await reverter.query('BEGIN');
        await reverter.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [DEMCHUK, 202609]);
        await withPendingDecisionTracking(reverter, [{ employeeId: DEMCHUK, workDate: '2026-09-05' }], async () => {
          const updated = await reverter.query(
            `UPDATE attendance_adjustments SET approval_status = 'pending'
              WHERE id = $1 AND approval_status = 'approved'`,
            [dayDemchuk],
          );
          return { value: null, changed: (updated.rowCount ?? 0) > 0 };
        });

        // «Последнее» решение стартует, пока откат не закоммичен, и ждёт лок отдела.
        decision = decideDay(daySary, SARY, '2026-09-06');
        await new Promise(resolve => setTimeout(resolve, 200));
        await reverter.query('COMMIT');
      } catch (error) {
        await reverter.query('ROLLBACK');
        throw error;
      } finally {
        reverter.release();
      }
      await decision;

      // День Демчук снова ждёт решения — закрывать нечего.
      expect(await closeReadyNotes()).toEqual([]);
      expect(await q(`SELECT id FROM attendance_adjustments WHERE approval_status = 'pending'`))
        .toEqual([{ id: dayDemchuk }]);
    });

    it('1–15 подан, 16–30 не подан → два уведомления о своих периодах', async () => {
      const submittedId = await insertDeptApproval('submitted', '2026-09-01', '2026-09-15');
      await q('DELETE FROM attendance_adjustments WHERE id = $1', [daySary]);

      await decideDay(dayDemchuk, DEMCHUK, '2026-09-05');

      const ready = await notesOf('timesheet_approval_ready');
      expect(ready).toHaveLength(1);
      expect(ready[0].metadata).toMatchObject({ approvalId: submittedId, start_date: '2026-09-01', end_date: '2026-09-15' });
      const closeReady = await closeReadyNotes();
      expect(closeReady).toHaveLength(1);
      expect(closeReady[0].metadata).toMatchObject({ start_date: '2026-09-16', end_date: '2026-09-30' });
      expect(closeReady[0].body).toContain('табель за 16–30 сен 2026');
    });

    it('утверждённый открытый 1–15 → «можно закрыть» по подаче с напоминанием о файле; 16–30 не подан — своё уведомление', async () => {
      const openedId = await insertDeptApproval('approved', '2026-09-01', '2026-09-15', true);
      await q('DELETE FROM attendance_adjustments WHERE id = $1', [daySary]);

      await decideDay(dayDemchuk, DEMCHUK, '2026-09-05');

      const notes = await closeReadyNotes();
      expect(notes.map(note => [note.metadata.approvalId ?? null, note.metadata.start_date, note.metadata.end_date]).sort())
        .toEqual([[null, '2026-09-16', '2026-09-30'], [openedId, '2026-09-01', '2026-09-15']].sort());
      expect(notes.find(note => note.metadata.approvalId === openedId)?.body).toBe(
        'Отдел Диспетчерская служба: табель за 1–15 сен 2026 — выходные согласованы. '
        + 'Закройте табель и выгрузите единый файл для 1С заново.',
      );
    });

    it('выходной, застрявший в уже закрытой половине, закрытию остального не мешает', async () => {
      await insertDeptApproval('approved', '2026-09-01', '2026-09-15'); // закрыт, в нём ждёт день Демчук
      await q(`UPDATE attendance_adjustments SET work_date = '2026-09-19' WHERE id = $1`, [daySary]);

      await decideDay(daySary, SARY, '2026-09-19');

      const notes = await closeReadyNotes();
      expect(notes).toHaveLength(1);
      expect(notes[0].metadata).toMatchObject({ start_date: '2026-09-16', end_date: '2026-09-30' });
    });

    it('возвращённая подача нестандартного диапазона — её закрывают вручную, уведомления нет', async () => {
      await insertDeptApproval('returned', '2026-09-10', '2026-09-20');

      await decideDay(dayDemchuk, DEMCHUK, '2026-09-05');
      await decideDay(daySary, SARY, '2026-09-06');

      expect(await closeReadyNotes()).toEqual([]);
    });

    it('оба полупериода поданы → только «готов к утверждению», месячного уведомления нет', async () => {
      await insertDeptApproval('submitted', '2026-09-01', '2026-09-15');
      await insertDeptApproval('submitted', '2026-09-16', '2026-09-30');

      await decideDay(dayDemchuk, DEMCHUK, '2026-09-05');
      await decideDay(daySary, SARY, '2026-09-06');

      expect(await readyCount()).toBe(1);
      expect(await closeReadyNotes()).toEqual([]);
    });

    it('последний выходной решён до конца месяца → уведомления нет: закрывать ещё нечего', async () => {
      const [october] = await q<{ id: string }>(
        `INSERT INTO attendance_adjustments (employee_id, work_date, approval_status)
         VALUES (${DEMCHUK}, '2026-10-10', 'pending') RETURNING id`,
      );

      const result = await decideDay(Number(october.id), DEMCHUK, '2026-10-10');

      expect(result.value).toBe(1);
      expect(await closeReadyNotes()).toEqual([]);
    });
  });
});
