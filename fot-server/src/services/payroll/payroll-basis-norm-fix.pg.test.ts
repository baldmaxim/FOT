import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Норма часов ноябрьских основ (payroll-basis-norm-fix.service) на настоящем PostgreSQL: одна новая revision с нормой
// графика, остальные поля и качество прежние, повтор — без эффекта, откат к календарю, всё или ничего. Запускается
// только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы-заглушки пересоздаются).

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../../config/postgres.js', async () => {
  const { Pool } = await import('pg');
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 4 }) : null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool.query(sql, params as unknown[]);
  };
  return {
    pool: () => pg.pool,
    query: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows[0] ?? null,
    execute: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rowCount ?? 0,
    withTransaction: async <T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> => {
      if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
      const client = await pg.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  };
});

// Графики и календарь: отчёту — один график на месяц, календарь ноября — 159 ч.
vi.mock('../schedule.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../schedule.service.js')>()),
  loadCalendarMonth: vi.fn(async () => ({
    year: 2026, month: 11, norm_days: 20, norm_hours: 159, holidays: [], mandatory_holidays: [], pre_holidays: [],
  })),
  resolveSchedulesForPeriod: vi.fn(async (employees: Array<{ id: number }>) => new Map(employees.map(employee => [
    employee.id,
    new Map(['2026-11-01', '2026-11-02'].map(date => [date, { schedule_id: 'line-10', name: 'ЛИНИЯ 10 ч' }])),
  ]))),
}));

import { insertPayrollBasis, type IPayrollBasisDraft } from './payroll-basis.service.js';
import { fixPayrollBasisNormMinutes } from './payroll-basis-norm-fix.service.js';

const migration = (name: string): string => readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../../../../docs/migrations/${name}`),
  'utf8',
);

const q = async <T extends import('pg').QueryResultRow>(sql: string, params?: unknown[]) =>
  (await pg.pool!.query<T>(sql, params)).rows;

const CALENDAR_NORM = 159 * 60;
const SCHEDULE_NORM = 230 * 60;

const draft = (employeeId: number, over: Partial<IPayrollBasisDraft> = {}): IPayrollBasisDraft => ({
  employeeId,
  month: '2026-11-01',
  normDays: 23,
  normMinutes: CALENDAR_NORM,
  workdayDates: ['2026-11-02', '2026-11-03'],
  dayoffDates: ['2026-11-01'],
  absenceDays: { vacation: 0, sick: 0, educational_leave: 0, unpaid: 0 },
  absenceDates: { vacation: [], sick: [], educational_leave: [], unpaid: [] },
  overtimeMinutes: { '2026-11-03': 120 },
  paidMinutes: { '2026-11-01': 600, '2026-11-02': 600, '2026-11-03': 720 },
  ...over,
});

const seedVersion = async (): Promise<number> => {
  const [approval] = await q<{ id: string }>(
    `INSERT INTO timesheet_approvals (status, start_date, end_date) VALUES ('approved', '2026-11-01', '2026-11-15')
     RETURNING id`,
  );
  const [version] = await q<{ id: string }>(
    `INSERT INTO timesheet_versions (approval_id, revision, payload) VALUES ($1, 1, '{"employees": []}'::jsonb) RETURNING id`,
    [approval.id],
  );
  return Number(version.id);
};

const rows = () => q<Record<string, unknown>>(
  `SELECT employee_id, to_char(month, 'YYYY-MM') AS month, revision, norm_days, norm_minutes,
          workday_dates::text[] AS workday_dates, dayoff_dates::text[] AS dayoff_dates, absence_days, absence_dates,
          overtime_minutes, paid_minutes, quality, reason
     FROM timesheet_version_payroll_basis ORDER BY employee_id, month, revision`,
);

describe.skipIf(!PG_URL)('норма часов ноябрьских основ на PostgreSQL', () => {
  beforeAll(async () => {
    await q(`DROP TABLE IF EXISTS timesheet_version_payroll_basis, timesheet_versions, timesheet_approvals,
             payroll_compensation_terms, employees, org_departments, employee_assignments, system_settings CASCADE`);
    await q('CREATE TABLE org_departments (id uuid PRIMARY KEY, name text, kind text, parent_id uuid)');
    await q(`CREATE TABLE employee_assignments (
               id bigserial PRIMARY KEY, employee_id int NOT NULL, org_department_id uuid,
               effective_from date NOT NULL, effective_to date)`);
    await q('CREATE TABLE system_settings (key text PRIMARY KEY, value text)');
    await q('CREATE TABLE employees (id int PRIMARY KEY, full_name text)');
    await q(`CREATE TABLE timesheet_approvals (
               id bigserial PRIMARY KEY, status text NOT NULL, unlocked_at timestamptz,
               start_date date NOT NULL, end_date date NOT NULL, manager_employee_id int)`);
    await q(`CREATE TABLE timesheet_versions (
               id bigserial PRIMARY KEY, approval_id bigint NOT NULL, revision int NOT NULL, department_id uuid,
               payload jsonb)`);
    await q('CREATE TABLE payroll_compensation_terms (id bigserial PRIMARY KEY, employee_id int NOT NULL)');
    await q(`INSERT INTO employees (id, full_name) VALUES (1566, 'Джумаев А.Х.'), (72, NULL)`);
    await q(migration('331_payroll_version_basis.sql'));
    await q(migration('339_payroll_housing_by_days.sql'));
    await q(migration('344_payroll_basis_paid_minutes.sql'));
    await q(migration('368_payroll_basis_norm_plan.sql'));
  });

  beforeEach(async () => {
    await q('TRUNCATE timesheet_version_payroll_basis, timesheet_versions, timesheet_approvals RESTART IDENTITY');
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('норма календаря → норма графика одной revision; поля и качество прежние; повтор — ничего; откат к календарю', async () => {
    const versionId = await seedVersion();
    await insertPayrollBasis(pg.pool!, versionId, [draft(1566), draft(1566, { month: '2026-10-01', normMinutes: 176 * 60 })], {
      quality: 'materialized', reason: 'close', mode: 'changed',
    });
    // Две revision ноября: берётся только последняя.
    await insertPayrollBasis(pg.pool!, versionId, [draft(1566, { normDays: 24 })], {
      quality: 'materialized', reason: 'close', mode: 'changed',
    });
    const rebuild = async () => [draft(1566, { normMinutes: SCHEDULE_NORM })];

    const dry = await fixPayrollBasisNormMinutes({ apply: false, rebuild });
    expect(dry).toMatchObject({ mode: 'schedule', candidates: 1, problems: [], written: 0 });
    expect(dry.changes).toEqual([{
      versionId, employeeId: 1566, fullName: 'Джумаев А.Х.', month: '2026-11', before: CALENDAR_NORM, after: SCHEDULE_NORM,
      schedules: ['2026-11-01..2026-11-02 ЛИНИЯ 10 ч (line-10)'],
    }]);
    expect(await rows()).toHaveLength(3);

    expect(await fixPayrollBasisNormMinutes({ apply: true, rebuild })).toMatchObject({ written: 1 });
    const after = await rows();
    const november = after.filter(row => row.month === '2026-11');
    expect(november.map(row => [row.revision, row.norm_minutes, row.reason])).toEqual([
      [1, CALENDAR_NORM, 'close'], [2, CALENDAR_NORM, 'close'], [3, SCHEDULE_NORM, 'backfill'],
    ]);
    // Кроме нормы и причины — всё как у последней revision.
    const strip = (row: Record<string, unknown>) => ({ ...row, revision: 0, norm_minutes: 0, reason: '' });
    expect(strip(november[2])).toEqual(strip(november[1]));
    // Октябрь не тронут.
    expect(after.filter(row => row.month === '2026-10').map(row => row.revision)).toEqual([1]);

    expect(await fixPayrollBasisNormMinutes({ apply: false, rebuild })).toMatchObject({ changes: [], problems: [] });
    expect(await fixPayrollBasisNormMinutes({ apply: true, rebuild })).toMatchObject({ written: 0 });

    // Откат бэкенда — норма календаря новой revision.
    expect(await fixPayrollBasisNormMinutes({ apply: true, mode: 'calendar', rebuild })).toMatchObject({ written: 1 });
    expect((await rows()).filter(row => row.month === '2026-11').map(row => row.norm_minutes))
      .toEqual([CALENDAR_NORM, CALENDAR_NORM, SCHEDULE_NORM, CALENDAR_NORM]);
  });

  it('всё или ничего: у одного сотрудника не построилась основа — никто не записан', async () => {
    const versionId = await seedVersion();
    await insertPayrollBasis(pg.pool!, versionId, [draft(1566), draft(72)], {
      quality: 'reconstructed', reason: 'backfill', mode: 'changed',
    });
    const result = await fixPayrollBasisNormMinutes({
      apply: true,
      rebuild: async () => [draft(1566, { normMinutes: SCHEDULE_NORM })],
    });
    expect(result.problems).toEqual([{ versionId, employeeId: 72, reason: 'основа не построилась' }]);
    expect(result.written).toBe(0);
    expect((await rows()).map(row => row.revision)).toEqual([1, 1]);
  });
});
