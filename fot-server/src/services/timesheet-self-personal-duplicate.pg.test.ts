import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

// Один сотрудник-день — не более чем в одной утверждённой подаче: поиск пересечений по
// последним редакциям (защита утверждения) и разовая чистка персональных подач, где
// строка руководителя дублирует подачу его отдела. Настоящий SQL: jsonb-разбор редакций,
// FOR UPDATE, advisory-локи, снимок состава; аудит — заглушка.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы-заглушки пересоздаются).
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

const { auditLogMock } = vi.hoisted(() => ({ auditLogMock: vi.fn(async () => undefined) }));
vi.mock('./audit.service.js', () => ({
  auditService: { log: auditLogMock },
  AUDIT_ACTIONS: new Proxy({}, { get: (_target, key) => key }),
}));

import { findApprovedDayConflicts } from './timesheet-approved-day-conflicts.service.js';
import { listSelfPersonalDuplicates, recallSelfPersonalDuplicate } from './timesheet-self-personal-duplicate.service.js';

const SECRETARIAT = '00000000-0000-4000-8000-0000000000c1';
const BRIGADE_A = '00000000-0000-4000-8000-0000000000c2';
const BRIGADE_B = '00000000-0000-4000-8000-0000000000c3';

const DUSHANOVA = 567; // руководитель Секретариата, строка в личной и в подаче отдела
const SECRETARY = 568;
const MOVED = 600; // переведён из бригады A в бригаду B 08.09 — дни не пересекаются
const IDLE = 601; // строка без активности в обеих бригадах

const q = async <T extends import('pg').QueryResultRow>(sql: string, params?: unknown[]) =>
  (await pg.pool!.query<T>(sql, params)).rows;

const days = (from: number, to: number, hours = 8): Record<string, { status: string; hours: number }> => {
  const result: Record<string, { status: string; hours: number }> = {};
  for (let day = from; day <= to; day += 1) {
    result[`2026-09-${String(day).padStart(2, '0')}`] = { status: 'Я', hours };
  }
  return result;
};

const employeeRow = (
  id: number,
  dayMap: Record<string, { status: string; hours: number }>,
  zeroActivity = false,
) => ({
  identity: { employee_id: id, sigur_employee_id: null, tab_number: null, full_name: `Сотрудник ${id}` },
  position: null,
  total_hours: Object.values(dayMap).reduce((sum, day) => sum + day.hours, 0),
  zero_activity: zeroActivity,
  days: dayMap,
  object_rows: [],
});

const insertApproval = async (input: {
  departmentId?: string | null;
  managerEmployeeId?: number | null;
  status?: string;
  roster: number[];
  employees: ReturnType<typeof employeeRow>[];
  acked?: boolean;
}): Promise<number> => {
  const [row] = await q<{ id: number }>(
    `INSERT INTO timesheet_approvals (department_id, manager_employee_id, start_date, end_date, status,
       submitted_by, submitted_at, reviewed_by, reviewed_at)
     VALUES ($1, $2, '2026-09-01', '2026-09-15', $3,
       '00000000-0000-4000-8000-0000000000f1', now(), '00000000-0000-4000-8000-0000000000f2', now())
     RETURNING id`,
    [input.departmentId ?? null, input.managerEmployeeId ?? null, input.status ?? 'approved'],
  );
  for (const employeeId of input.roster) {
    await q('INSERT INTO timesheet_approval_employees (approval_id, employee_id) VALUES ($1, $2)', [row.id, employeeId]);
  }
  // Старая редакция с другим составом: сравнивать должно только последнюю.
  await q(
    `INSERT INTO timesheet_versions (approval_id, revision, payload) VALUES ($1, 1, $2::jsonb)`,
    [row.id, JSON.stringify({ employees: [] })],
  );
  const [version] = await q<{ id: number }>(
    `INSERT INTO timesheet_versions (approval_id, revision, payload) VALUES ($1, 2, $2::jsonb) RETURNING id`,
    [row.id, JSON.stringify({ employees: input.employees })],
  );
  if (input.acked) await q('INSERT INTO timesheet_1c_exports (version_id) VALUES ($1)', [version.id]);
  return row.id;
};

describe.skipIf(!PG_URL)('пересечения дней между утверждёнными подачами (PostgreSQL)', () => {
  beforeAll(async () => {
    await pg.pool!.query(`
      DROP TABLE IF EXISTS timesheet_1c_exports, timesheet_versions, timesheet_approval_employees,
        timesheet_approvals, employees, org_departments CASCADE;
      CREATE TABLE org_departments (id uuid PRIMARY KEY, name text NOT NULL);
      CREATE TABLE employees (id integer PRIMARY KEY, full_name text NULL);
      CREATE TABLE timesheet_approvals (
        id bigserial PRIMARY KEY, department_id uuid NULL, manager_employee_id integer NULL,
        start_date date NOT NULL, end_date date NOT NULL, status text NOT NULL,
        submitted_by uuid NULL, submitted_at timestamptz NULL, reviewed_by uuid NULL, reviewed_at timestamptz NULL,
        review_comment text NULL, unlocked_at timestamptz NULL, unlocked_by uuid NULL, unlock_reason text NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE timesheet_approval_employees (
        approval_id bigint NOT NULL REFERENCES timesheet_approvals(id) ON DELETE CASCADE,
        employee_id bigint NOT NULL, full_name text NULL,
        PRIMARY KEY (approval_id, employee_id)
      );
      CREATE TABLE timesheet_versions (
        id bigserial PRIMARY KEY, approval_id bigint NOT NULL, revision integer NOT NULL, payload jsonb NOT NULL
      );
      CREATE TABLE timesheet_1c_exports (version_id bigint NOT NULL);
    `);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await pg.pool!.query(`TRUNCATE timesheet_1c_exports, timesheet_versions, timesheet_approval_employees,
      timesheet_approvals, employees, org_departments RESTART IDENTITY CASCADE`);
    await q(`INSERT INTO org_departments (id, name) VALUES ($1, 'Секретариат'), ($2, 'бр.А'), ($3, 'бр.Б')`,
      [SECRETARIAT, BRIGADE_A, BRIGADE_B]);
    await q(`INSERT INTO employees (id, full_name) VALUES
      ($1, 'Душанова Елена Анатольевна'), ($2, 'Секретарь Анна Петровна'), ($3, 'Переведённый Иван'), ($4, 'Простой Пётр')`,
    [DUSHANOVA, SECRETARY, MOVED, IDLE]);
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  describe('findApprovedDayConflicts', () => {
    it('руководитель в личной подаче и в подаче отдела — пересечение по всем дням', async () => {
      const personal = await insertApproval({
        managerEmployeeId: DUSHANOVA, roster: [DUSHANOVA], employees: [employeeRow(DUSHANOVA, days(1, 11))],
      });
      const department = await insertApproval({
        departmentId: SECRETARIAT, roster: [DUSHANOVA, SECRETARY],
        employees: [employeeRow(DUSHANOVA, days(1, 11)), employeeRow(SECRETARY, days(1, 11))],
      });

      const conflicts = await findApprovedDayConflicts(undefined, department);

      expect(conflicts).toEqual([{
        employeeId: DUSHANOVA,
        fullName: 'Душанова Елена Анатольевна',
        approvalId: personal,
        departmentId: null,
        departmentName: null,
        managerFullName: 'Душанова Елена Анатольевна',
        firstDay: '2026-09-01',
        lastDay: '2026-09-11',
        days: 11,
        hours: 88,
        otherHours: 88,
      }]);
    });

    it('перевод по окнам без общих дней, неутверждённая подача и zero_activity — не пересечения', async () => {
      await insertApproval({
        departmentId: BRIGADE_A, roster: [MOVED, IDLE],
        employees: [employeeRow(MOVED, days(1, 7)), employeeRow(IDLE, days(1, 15, 0), true)],
      });
      await insertApproval({
        departmentId: SECRETARIAT, status: 'submitted', roster: [MOVED], employees: [employeeRow(MOVED, days(1, 15))],
      });
      const brigadeB = await insertApproval({
        departmentId: BRIGADE_B, roster: [MOVED, IDLE],
        employees: [employeeRow(MOVED, days(8, 15)), employeeRow(IDLE, days(1, 15, 0))],
      });

      expect(await findApprovedDayConflicts(undefined, brigadeB)).toEqual([]);
    });

    it('сравнивается последняя редакция другой подачи, не ранние', async () => {
      const brigadeA = await insertApproval({
        departmentId: BRIGADE_A, roster: [MOVED], employees: [employeeRow(MOVED, days(1, 7))],
      });
      // Последняя редакция бригады A без сотрудника.
      await q(`INSERT INTO timesheet_versions (approval_id, revision, payload) VALUES ($1, 3, '{"employees": []}'::jsonb)`,
        [brigadeA]);
      const brigadeB = await insertApproval({
        departmentId: BRIGADE_B, roster: [MOVED], employees: [employeeRow(MOVED, days(1, 15))],
      });

      expect(await findApprovedDayConflicts(undefined, brigadeB)).toEqual([]);
    });
  });

  describe('чистка личных подач-дублей', () => {
    it('личная подача руководителя уходит в пустой черновик, подача отдела не меняется; повтор — no-op', async () => {
      const personal = await insertApproval({
        managerEmployeeId: DUSHANOVA, roster: [DUSHANOVA], employees: [employeeRow(DUSHANOVA, days(1, 11))],
      });
      const department = await insertApproval({
        departmentId: SECRETARIAT, roster: [DUSHANOVA, SECRETARY],
        employees: [employeeRow(DUSHANOVA, days(1, 11)), employeeRow(SECRETARY, days(1, 11))],
      });

      const listed = await listSelfPersonalDuplicates('2026-09-01');
      expect(listed).toEqual([expect.objectContaining({
        approvalId: personal, managerEmployeeId: DUSHANOVA, days: 11, hours: 88,
        keptInApprovalIds: [department], manualReason: null,
      })]);

      const result = await recallSelfPersonalDuplicate(personal);
      expect(result.recalled).toBe(true);

      const [row] = await q<{ status: string; reviewed_by: string | null; submitted_at: string | null }>(
        'SELECT status, reviewed_by, submitted_at FROM timesheet_approvals WHERE id = $1', [personal],
      );
      expect(row).toEqual({ status: 'draft', reviewed_by: null, submitted_at: null });
      expect(await q('SELECT 1 FROM timesheet_approval_employees WHERE approval_id = $1', [personal])).toHaveLength(0);
      // Редакции остаются историей; подача отдела не тронута.
      expect(await q('SELECT 1 FROM timesheet_versions WHERE approval_id = $1', [personal])).toHaveLength(2);
      const [dept] = await q<{ status: string }>('SELECT status FROM timesheet_approvals WHERE id = $1', [department]);
      expect(dept.status).toBe('approved');
      expect(await q('SELECT 1 FROM timesheet_approval_employees WHERE approval_id = $1', [department])).toHaveLength(2);
      expect(await findApprovedDayConflicts(undefined, department)).toEqual([]);
      expect(auditLogMock).toHaveBeenCalledTimes(1);
      expect(auditLogMock).toHaveBeenCalledWith(expect.objectContaining({
        action: 'TIMESHEET_APPROVAL_RECALLED',
        entity_id: String(personal),
        details: expect.objectContaining({ reason: 'duplicate_self_row', kept_in_approval_ids: [department] }),
      }));

      expect(await listSelfPersonalDuplicates('2026-09-01')).toEqual([]);
      expect((await recallSelfPersonalDuplicate(personal)).recalled).toBe(false);
      expect(auditLogMock).toHaveBeenCalledTimes(1);
    });

    it('подчинённые в составе, не все дни или другие часы в подаче отдела — только вручную', async () => {
      // Подчинённый в составе личной подачи.
      const withSubordinate = await insertApproval({
        managerEmployeeId: SECRETARY, roster: [SECRETARY, IDLE], employees: [employeeRow(SECRETARY, days(1, 11))],
      });
      await insertApproval({
        departmentId: SECRETARIAT, roster: [SECRETARY], employees: [employeeRow(SECRETARY, days(1, 11))],
      });
      // В подаче отдела только часть дней.
      const partial = await insertApproval({
        managerEmployeeId: MOVED, roster: [MOVED], employees: [employeeRow(MOVED, days(1, 15))],
      });
      await insertApproval({
        departmentId: BRIGADE_B, roster: [MOVED], employees: [employeeRow(MOVED, days(8, 15))],
      });
      // Дни те же, часы в подаче отдела меньше — личную снимать нельзя, часы потеряются.
      const otherHours = await insertApproval({
        managerEmployeeId: DUSHANOVA, roster: [DUSHANOVA], employees: [employeeRow(DUSHANOVA, days(1, 11, 8))],
      });
      await insertApproval({
        departmentId: BRIGADE_A, roster: [DUSHANOVA], employees: [employeeRow(DUSHANOVA, days(1, 11, 7))],
      });

      const listed = await listSelfPersonalDuplicates('2026-09-01');
      const reasons = new Map(listed.map(item => [item.approvalId, item.manualReason]));

      expect(reasons.get(withSubordinate)).toBe('в составе есть подчинённые');
      expect(reasons.get(partial)).toBe('в подачах отделов 8 из 15 дней');
      expect(reasons.get(otherHours)).toBe('часы расходятся: в личной 88 ч, в подачах отделов 77 ч');
      for (const approvalId of [withSubordinate, partial, otherHours]) {
        expect((await recallSelfPersonalDuplicate(approvalId)).recalled).toBe(false);
      }
      const statuses = await q<{ status: string }>(
        'SELECT status FROM timesheet_approvals WHERE manager_employee_id IS NOT NULL ORDER BY id',
      );
      expect(statuses.map(row => row.status)).toEqual(['approved', 'approved', 'approved']);
      expect(auditLogMock).not.toHaveBeenCalled();
    });

    it('подача с ACK 1С не снимается', async () => {
      const acked = await insertApproval({
        managerEmployeeId: DUSHANOVA, roster: [DUSHANOVA], employees: [employeeRow(DUSHANOVA, days(1, 11))], acked: true,
      });
      await insertApproval({
        departmentId: SECRETARIAT, roster: [DUSHANOVA], employees: [employeeRow(DUSHANOVA, days(1, 11))],
      });

      const [item] = await listSelfPersonalDuplicates('2026-09-01');
      expect(item).toEqual(expect.objectContaining({
        approvalId: acked, manualReason: '1С уже подтвердила редакцию — снимать только вместе с 1С',
      }));
      expect((await recallSelfPersonalDuplicate(acked)).recalled).toBe(false);
    });
  });
});
