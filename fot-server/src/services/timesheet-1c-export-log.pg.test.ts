import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Request } from 'express';

// Журнал выгрузок «Единый файл для 1С» (миграция 308) на настоящем PostgreSQL: миграция и её
// повтор, запись трёх таблиц одной транзакцией, откат при ошибке, CHECK-и, надгробие автора,
// и снимок членства — флаги допуска совпадают с фильтром состава выгрузки.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы-заглушки пересоздаются).

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
    execute: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rowCount ?? 0,
    withTransaction: async <T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> => {
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
    },
  };
});

import {
  classifyDepartmentCandidates,
  recordUnified1CExport,
  type IUnified1CLogCandidate,
} from './timesheet-1c-export-log.service.js';
import type { IUnifiedRow } from './timesheet-1c-unified.service.js';
import {
  listScopedMembersByDepartment,
  listScopedMembershipCandidates,
} from './timesheet-department-assignments.service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../docs/migrations/', import.meta.url));
const MIGRATION = readFileSync(`${MIGRATIONS_DIR}308_timesheet_1c_export_log.sql`, 'utf8');

const TOMBSTONE = '00000000-0000-0000-0000-00000000dead';
const AUTHOR = '0a0a0a0a-0000-4000-8000-0000000000a0';
const DEPT = '11111111-1111-4111-8111-111111111111';
const OTHER_DEPT = '22222222-2222-4222-8222-222222222222';
const OBJ = '33333333-3333-4333-8333-333333333333';

const req = { ip: '10.0.0.7', socket: {}, headers: { 'user-agent': 'vitest' } } as unknown as Request;

const q = async <T extends import('pg').QueryResultRow>(sql: string, params?: unknown[]) =>
  (await pg.pool!.query<T>(sql, params)).rows;

const row = (employeeId: number, fullName: string, over: Partial<IUnifiedRow> = {}): IUnifiedRow => ({
  oneCRow: {
    employeeId,
    fullName,
    dayValues: new Map([
      [1, { hours: 8, isUnderwork: false }],
      [2, { hours: 0, label: 'Б', isUnderwork: false }],
      [4, { hours: 0, isUnderwork: false, isWeekend: true }],
    ]),
    totalHours: 8,
    workedDays: 1,
    workedDayNumbers: [1],
  },
  departmentName: 'Отдел',
  objectAddress: 'ЖК Сад',
  managerName: 'Начальник Н.',
  position: 'Монтажник',
  departmentId: DEPT,
  objectId: OBJ,
  departmentNameSort: 'Отдел',
  departmentIdSort: DEPT,
  fullNameSort: fullName,
  employeeIdSort: employeeId,
  objectNameSort: 'ЖК Сад',
  objectKeySort: OBJ,
  ...over,
});

const baseEntry = {
  source: 'hr_departments' as const,
  month: '2026-10',
  periodStart: '2026-10-01',
  periodEnd: '2026-10-31',
  departmentIds: [DEPT],
  fileName: 'Единый_1С_Октябрь_2026.xlsx',
  buffer: Buffer.from('xlsx-bytes'),
};

const resetSchema = async (): Promise<void> => {
  await pg.pool!.query(`
    DROP TABLE IF EXISTS timesheet_1c_export_log_candidates, timesheet_1c_export_log_rows, timesheet_1c_export_log,
      employee_dismissal_events, employee_assignments, employees, user_profiles CASCADE;
    CREATE TABLE user_profiles (id uuid PRIMARY KEY, full_name text NULL);
    INSERT INTO user_profiles (id, full_name) VALUES ('${TOMBSTONE}', 'Удалённый пользователь'), ('${AUTHOR}', 'Кадровик К.');
    CREATE TABLE employees (
      id integer PRIMARY KEY, full_name text NULL, org_department_id uuid NULL,
      is_archived boolean NOT NULL DEFAULT false, employment_status text NULL DEFAULT 'active',
      dismissal_date date NULL, excluded_from_timesheet boolean NOT NULL DEFAULT false,
      excluded_from_timesheet_date date NULL
    );
    CREATE TABLE employee_assignments (
      id serial PRIMARY KEY, employee_id integer NOT NULL, org_department_id uuid NULL,
      effective_from date NOT NULL, effective_to date NULL
    );
    CREATE TABLE employee_dismissal_events (
      id serial PRIMARY KEY, employee_id integer NOT NULL, from_department_id uuid NULL,
      dismissal_date date NULL, cancelled boolean NOT NULL DEFAULT false
    );
  `);
};

describe.skipIf(!PG_URL)('журнал выгрузок «Единый файл для 1С» (PG)', () => {
  beforeAll(async () => {
    await resetSchema();
    await pg.pool!.query(MIGRATION);
    // Повторный запуск миграции безопасен.
    await pg.pool!.query(MIGRATION);
  });

  beforeEach(async () => {
    await pg.pool!.query('TRUNCATE timesheet_1c_export_log CASCADE');
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('шапка, строки и кандидаты записываются одной транзакцией, значения — как в ячейках', async () => {
    const candidates: IUnified1CLogCandidate[] = [
      { employee_id: 1, department_id: DEPT, sources: ['assignment'], drop_stage: null },
      { employee_id: 2, department_id: DEPT, sources: ['dismissal'], drop_stage: 'fired' },
    ];
    const id = await recordUnified1CExport(req, AUTHOR, {
      ...baseEntry,
      rows: [
        row(1, '=Иванов'),
        row(1, 'Иванов', { objectId: null, oneCRow: { employeeId: 1, fullName: 'Иванов', dayValues: new Map(), totalHours: 0, workedDays: 0, workedDayNumbers: [] } }),
      ],
      candidates,
    });

    const [header] = await q<Record<string, unknown>>(
      `SELECT user_id, source, month::text, period_start::text, period_end::text, department_ids, object_ids,
              file_sha256, file_bytes, row_count, employee_count, candidate_count, ip_address, user_agent
         FROM timesheet_1c_export_log WHERE id = $1`,
      [id],
    );
    expect(header).toMatchObject({
      user_id: AUTHOR,
      source: 'hr_departments',
      month: '2026-10-01',
      period_start: '2026-10-01',
      period_end: '2026-10-31',
      department_ids: [DEPT],
      object_ids: [],
      file_bytes: 10,
      row_count: 2,
      employee_count: 1,
      candidate_count: 2,
      ip_address: '10.0.0.7',
      user_agent: 'vitest',
    });
    expect(header.file_sha256).toMatch(/^[0-9a-f]{64}$/);

    const rows = await q<Record<string, unknown>>(
      `SELECT excel_row, employee_id, full_name, department_id, object_id, days, total_hours::float AS total_hours, worked_days
         FROM timesheet_1c_export_log_rows WHERE export_id = $1 ORDER BY excel_row`,
      [id],
    );
    expect(rows).toEqual([
      {
        excel_row: 4, employee_id: 1, full_name: "'=Иванов", department_id: DEPT, object_id: OBJ,
        days: { 1: 8, 2: 'Б' }, total_hours: 8, worked_days: 1,
      },
      {
        excel_row: 5, employee_id: 1, full_name: 'Иванов', department_id: DEPT, object_id: null,
        days: {}, total_hours: null, worked_days: null,
      },
    ]);

    const stored = await q<Record<string, unknown>>(
      `SELECT employee_id, department_id, sources, drop_stage
         FROM timesheet_1c_export_log_candidates WHERE export_id = $1 ORDER BY employee_id`,
      [id],
    );
    expect(stored).toEqual(candidates);
  });

  it('ошибка вставки кандидатов откатывает и шапку, и строки', async () => {
    await expect(recordUnified1CExport(req, AUTHOR, {
      ...baseEntry,
      rows: [row(1, 'Иванов')],
      candidates: [{ employee_id: 1, department_id: DEPT, sources: ['assignment'], drop_stage: 'bogus' as never }],
    })).rejects.toThrow();

    expect(await q('SELECT 1 FROM timesheet_1c_export_log')).toHaveLength(0);
    expect(await q('SELECT 1 FROM timesheet_1c_export_log_rows')).toHaveLength(0);
  });

  it('CHECK-и шапки: месяц — первое число, период внутри месяца, sha256', async () => {
    const insert = (month: string, start: string, end: string, sha = 'a'.repeat(64)) => pg.pool!.query(
      `INSERT INTO timesheet_1c_export_log (user_id, source, month, period_start, period_end, file_name, file_sha256,
         file_bytes, row_count, employee_count, candidate_count)
       VALUES ($1, 'hr_objects', $2, $3, $4, 'f.xlsx', $5, 1, 0, 0, 0)`,
      [AUTHOR, month, start, end, sha],
    );
    await expect(insert('2026-10-15', '2026-10-15', '2026-10-31')).rejects.toThrow(/timesheet_1c_export_log_month/);
    await expect(insert('2026-10-01', '2026-10-01', '2026-11-01')).rejects.toThrow(/timesheet_1c_export_log_period/);
    await expect(insert('2026-10-01', '2026-10-20', '2026-10-01')).rejects.toThrow(/timesheet_1c_export_log_period/);
    await expect(insert('2026-10-01', '2026-10-01', '2026-10-31', 'XYZ')).rejects.toThrow(/timesheet_1c_export_log_sha256/);
    await expect(insert('2026-10-01', '2026-10-01', '2026-10-15')).resolves.toBeDefined();
  });

  it('удаление автора переводит запись на надгробие; удаление выгрузки уносит строки и кандидатов', async () => {
    const id = await recordUnified1CExport(req, AUTHOR, {
      ...baseEntry,
      rows: [row(1, 'Иванов')],
      candidates: [{ employee_id: 1, department_id: DEPT, sources: ['assignment'], drop_stage: null }],
    });

    await pg.pool!.query('DELETE FROM user_profiles WHERE id = $1', [AUTHOR]);
    expect((await q<{ user_id: string }>('SELECT user_id FROM timesheet_1c_export_log WHERE id = $1', [id]))[0].user_id)
      .toBe(TOMBSTONE);
    await pg.pool!.query('INSERT INTO user_profiles (id, full_name) VALUES ($1, $2)', [AUTHOR, 'Кадровик К.']);

    await pg.pool!.query('DELETE FROM timesheet_1c_export_log WHERE id = $1', [id]);
    expect(await q('SELECT 1 FROM timesheet_1c_export_log_rows WHERE export_id = $1', [id])).toHaveLength(0);
    expect(await q('SELECT 1 FROM timesheet_1c_export_log_candidates WHERE export_id = $1', [id])).toHaveLength(0);
  });

  it('снимок членства: допущенные совпадают с составом выгрузки, отсеянные — с причиной, а не «нет в составе»', async () => {
    await pg.pool!.query('TRUNCATE employees, employee_assignments, employee_dismissal_events');
    await pg.pool!.query(`
      INSERT INTO employees (id, full_name, org_department_id, is_archived, employment_status, dismissal_date,
                             excluded_from_timesheet, excluded_from_timesheet_date) VALUES
        (1, 'Работает',              '${DEPT}',       false, 'active', NULL,         false, NULL),
        (2, 'Уволен в октябре',      '${OTHER_DEPT}', false, 'fired',  '2026-10-10', false, NULL),
        (3, 'Архивный',              '${DEPT}',       true,  'active', NULL,         false, NULL),
        (4, 'Исключён из табеля',    '${DEPT}',       false, 'active', NULL,         true,  NULL),
        (5, 'Уволен в августе',      '${DEPT}',       false, 'fired',  '2026-08-20', false, NULL),
        (6, 'Исключён с 15 октября', '${DEPT}',       false, 'active', NULL,         true,  '2026-10-15'),
        (7, 'Чужой отдел',           '${OTHER_DEPT}', false, 'active', NULL,         false, NULL),
        (8, 'Без статуса',           '${DEPT}',       false, NULL,     NULL,         false, NULL);
      INSERT INTO employee_assignments (employee_id, org_department_id, effective_from, effective_to) VALUES
        (1, '${DEPT}', '2026-01-01', NULL),
        (7, '${OTHER_DEPT}', '2026-01-01', NULL);
      INSERT INTO employee_dismissal_events (employee_id, from_department_id, dismissal_date, cancelled) VALUES
        (2, '${DEPT}', '2026-10-10', false);
    `);

    const members = await listScopedMembersByDepartment([DEPT], '2026-10-01', '2026-10-31');
    const snapshot = await listScopedMembershipCandidates([DEPT], '2026-10-01', '2026-10-31');

    expect([...members.keys()].sort()).toEqual([1, 6]);
    const admitted = snapshot.filter(c => c.notArchived && c.firedEligible && c.notExcluded);
    expect(new Map(admitted.map(c => [c.employeeId, c.departmentId]))).toEqual(members);

    const stages = classifyDepartmentCandidates({
      candidates: snapshot,
      memberByEmp: members,
      bucketedEmployeeIds: new Set([1, 6]),
      roster: { ineligibleIds: [], zeroActivityIds: [6] },
      dataEmployeeIds: new Set([1]),
      rowEmployeeIds: new Set([1]),
    });
    expect(Object.fromEntries(stages.map(c => [c.employee_id, [c.sources[0], c.drop_stage]]))).toEqual({
      1: ['assignment', null],
      2: ['dismissal', 'fired'],
      3: ['snapshot', 'archived'],
      4: ['snapshot', 'excluded_from_timesheet'],
      5: ['snapshot', 'fired'],
      6: ['snapshot', 'zero_activity'],
      // NULL-статус не допущен и составом (WHERE), и снимком (COALESCE) — как уволенный.
      8: ['snapshot', 'fired'],
    });
  });
});
