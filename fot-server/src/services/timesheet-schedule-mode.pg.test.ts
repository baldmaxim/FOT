import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// «По графику» (миграция 358) на настоящем PostgreSQL: миграция и её повтор, триггер увольнения,
// даты «Добавить»/«Снять» (1-е месяца, согласованная подача, увольнение в месяце), повтор без
// изменений, обрезка периодов датой приёма. Запускается только при FOT_TEST_PG_URL — ПУСТАЯ
// тестовая БД (таблицы-заглушки пересоздаются).

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../config/postgres.js', async () => {
  const { Pool } = await import('pg');
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 5 }) : null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool.query(sql, params as unknown[]);
  };
  return {
    getPool: () => pg.pool,
    query: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows[0] ?? null,
  };
});
vi.mock('./data-scope.service.js', () => ({ canWriteEmployeeInScope: vi.fn(async () => true) }));

const { applyScheduleChanges, validateScheduleChanges } = await import('./timesheet-schedule-mode.service.js');
const { loadScheduleBasedRanges } = await import('./timesheet-schedule-ranges.service.js');

const MIGRATION = readFileSync(
  fileURLToPath(new URL('../../../docs/migrations/358_employee_schedule_timesheet_periods.sql', import.meta.url)),
  'utf8',
);
const USER = '00000000-0000-4000-8000-000000000001';
const DEPT = '11111111-1111-4111-8111-111111111111';
// 20.11.2026 12:00 МСК.
const NOW = new Date('2026-11-20T12:00:00+03:00');

const q = async <T extends import('pg').QueryResultRow>(sql: string, params?: unknown[]) =>
  (await pg.pool!.query<T>(sql, params)).rows;

/** Одна транзакция окна: проверки до неё, запись — в ней. */
async function save(changes: { add?: number[]; remove?: number[] }, now: Date = NOW) {
  const prepared = await validateScheduleChanges({ add: changes.add ?? [], remove: changes.remove ?? [] }, new Set());
  const client = await pg.pool!.connect();
  try {
    await client.query('BEGIN');
    const result = await applyScheduleChanges(client, prepared, { userId: USER, now });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const periods = (employeeId: number) => q<{ date_from: string; date_to: string | null; closed_reason: string | null }>(
  `SELECT date_from::text AS date_from, date_to::text AS date_to, closed_reason
     FROM employee_schedule_timesheet_periods WHERE employee_id = $1 ORDER BY date_from`,
  [employeeId],
);

describe.skipIf(!PG_URL)('«По графику» на PostgreSQL (миграция 358)', () => {
  beforeAll(async () => {
    await q(`DROP TABLE IF EXISTS employee_schedule_timesheet_periods, timesheet_approval_employees,
             timesheet_approvals, employees, user_profiles CASCADE`);
    await q('CREATE TABLE user_profiles (id uuid PRIMARY KEY)');
    await q(`CREATE TABLE employees (
               id integer PRIMARY KEY, full_name text, is_archived boolean NOT NULL DEFAULT false,
               employment_status text NOT NULL DEFAULT 'active', org_department_id uuid,
               hire_date date, dismissal_date date)`);
    await q(`CREATE TABLE timesheet_approvals (
               id bigserial PRIMARY KEY, status text NOT NULL, unlocked_at timestamptz,
               start_date date NOT NULL, end_date date NOT NULL)`);
    await q(`CREATE TABLE timesheet_approval_employees (
               approval_id bigint NOT NULL, employee_id bigint NOT NULL, PRIMARY KEY (approval_id, employee_id))`);
    await q('INSERT INTO user_profiles VALUES ($1)', [USER]);
    await q(MIGRATION);
    await q(MIGRATION);
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  beforeEach(async () => {
    await q('TRUNCATE employee_schedule_timesheet_periods, timesheet_approval_employees, timesheet_approvals, employees');
    await q(
      `INSERT INTO employees (id, full_name, org_department_id, hire_date)
       VALUES (1, 'Коровин', $1, '2020-01-01'), (2, 'Галкин', $1, '2026-11-15'), (3, 'Колганов', $1, NULL)`,
      [DEPT],
    );
  });

  it('повтор миграции не ломает схему: один открытый период на сотрудника', async () => {
    await q("INSERT INTO employee_schedule_timesheet_periods (employee_id, date_from) VALUES (1, '2026-11-01')");
    await expect(q("INSERT INTO employee_schedule_timesheet_periods (employee_id, date_from) VALUES (1, '2026-12-01')"))
      .rejects.toThrow(/employee_schedule_timesheet_periods_open/);
    await expect(q(`INSERT INTO employee_schedule_timesheet_periods (employee_id, date_from, date_to)
                    VALUES (1, '2026-10-01', '2026-10-31')`)).rejects.toThrow(/closed/);
  });

  it('«Добавить» — с 1-го месяца; повтор — без изменений', async () => {
    expect(await save({ add: [1] })).toMatchObject({ added: 1, removed: 0 });
    expect(await save({ add: [1] })).toMatchObject({ added: 0, removed: 0, audit: [] });
    expect(await periods(1)).toEqual([{ date_from: '2026-11-01', date_to: null, closed_reason: null }]);
  });

  it('согласованная незакрытая подача 1–15 — с 16-го; открытая заново подача не мешает', async () => {
    const [approved] = await q<{ id: number }>(
      "INSERT INTO timesheet_approvals (status, start_date, end_date) VALUES ('approved', '2026-11-01', '2026-11-15') RETURNING id",
    );
    const [unlocked] = await q<{ id: number }>(
      `INSERT INTO timesheet_approvals (status, unlocked_at, start_date, end_date)
       VALUES ('approved', now(), '2026-11-01', '2026-11-15') RETURNING id`,
    );
    await q('INSERT INTO timesheet_approval_employees VALUES ($1, 1), ($2, 3)', [approved.id, unlocked.id]);
    await save({ add: [1, 3] });
    expect((await periods(1))[0].date_from).toBe('2026-11-16');
    expect((await periods(3))[0].date_from).toBe('2026-11-01');

    // «Снять»: согласованные 1–15 остаются как были — от периода с 16-го ничего не осталось.
    await save({ remove: [1] });
    expect(await periods(1)).toEqual([]);
  });

  it('«Снять» давнего — закрывается концом прошлого месяца или согласованной подачи', async () => {
    await q(`INSERT INTO employee_schedule_timesheet_periods (employee_id, date_from)
             VALUES (1, '2026-09-01'), (3, '2026-09-01')`);
    const [approved] = await q<{ id: number }>(
      "INSERT INTO timesheet_approvals (status, start_date, end_date) VALUES ('approved', '2026-11-01', '2026-11-15') RETURNING id",
    );
    await q('INSERT INTO timesheet_approval_employees VALUES ($1, 3)', [approved.id]);
    expect(await save({ remove: [1, 3] })).toMatchObject({ removed: 2 });
    expect(await periods(1)).toEqual([{ date_from: '2026-09-01', date_to: '2026-10-31', closed_reason: 'manual' }]);
    expect(await periods(3)).toEqual([{ date_from: '2026-09-01', date_to: '2026-11-15', closed_reason: 'manual' }]);
    expect(await save({ remove: [1, 3] })).toMatchObject({ removed: 0, audit: [] });

    // Снова «Добавить» — с дня после прошлого периода, без пересечений.
    await save({ add: [1, 3] });
    expect((await periods(1)).map(p => p.date_from)).toEqual(['2026-09-01', '2026-11-01']);
    expect((await periods(3)).map(p => p.date_from)).toEqual(['2026-09-01', '2026-11-16']);
  });

  it('увольнение закрывает период датой увольнения; после восстановления — с дня новой отметки', async () => {
    await save({ add: [1] });
    await q("UPDATE employees SET employment_status = 'fired', dismissal_date = '2026-11-05' WHERE id = 1");
    expect(await periods(1)).toEqual([{ date_from: '2026-11-01', date_to: '2026-11-05', closed_reason: 'dismissal' }]);

    // Восстановление очищает дату увольнения — старый период уже закрыт.
    await q("UPDATE employees SET employment_status = 'active', dismissal_date = NULL WHERE id = 1");
    await save({ add: [1] });
    expect((await periods(1)).map(p => [p.date_from, p.date_to])).toEqual([
      ['2026-11-01', '2026-11-05'],
      ['2026-11-20', null],
    ]);
    const ranges = await loadScheduleBasedRanges([1], '2026-11-01', '2026-11-30');
    expect(ranges.get(1)).toEqual([{ from: '2026-11-01', to: '2026-11-05' }, { from: '2026-11-20', to: null }]);
  });

  it('увольнение раньше начала периода — строка удаляется; повторное UPDATE статуса триггер не будит', async () => {
    await q("INSERT INTO employee_schedule_timesheet_periods (employee_id, date_from) VALUES (1, '2026-11-16')");
    await q("UPDATE employees SET employment_status = 'fired', dismissal_date = '2026-11-05' WHERE id = 1");
    expect(await periods(1)).toEqual([]);

    await q("INSERT INTO employee_schedule_timesheet_periods (employee_id, date_from, date_to, closed_reason, closed_at) VALUES (1, '2026-10-01', '2026-10-31', 'manual', now())");
    await q("UPDATE employees SET employment_status = 'fired', dismissal_date = '2026-10-10' WHERE id = 1");
    expect(await periods(1)).toEqual([{ date_from: '2026-10-01', date_to: '2026-10-31', closed_reason: 'manual' }]);
  });

  it('«Добавить» уволенному — 400; «Снять» уволенному без действующей отметки — no-op', async () => {
    await q("UPDATE employees SET employment_status = 'fired' WHERE id = 3");
    await expect(validateScheduleChanges({ add: [3], remove: [] }, new Set())).rejects.toMatchObject({ status: 400 });
    expect(await validateScheduleChanges({ add: [], remove: [3] }, new Set())).toEqual({ add: [], remove: [] });
  });

  it('уволили между проверкой и записью — 409, ничего не записано', async () => {
    const prepared = await validateScheduleChanges({ add: [1], remove: [] }, new Set());
    await q("UPDATE employees SET employment_status = 'fired' WHERE id = 1");
    const client = await pg.pool!.connect();
    try {
      await client.query('BEGIN');
      await expect(applyScheduleChanges(client, prepared, { userId: USER, now: NOW }))
        .rejects.toMatchObject({ status: 409, code: 'TIMESHEET_OFFICE_CHANGED' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await periods(1)).toEqual([]);
  });

  it('загрузка для расчёта: обрезка датой приёма, вне диапазона — нет', async () => {
    await save({ add: [2] });
    expect((await loadScheduleBasedRanges([2], '2026-11-01', '2026-11-30')).get(2)).toEqual([{ from: '2026-11-15', to: null }]);
    expect((await loadScheduleBasedRanges([2], '2026-10-01', '2026-10-31')).size).toBe(0);
  });
});
