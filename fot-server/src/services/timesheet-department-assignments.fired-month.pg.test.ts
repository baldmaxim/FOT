import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Уволенный в месяце увольнения на настоящем PostgreSQL (Холодов: Тендерный отдел, уволен
// 13.10.2026, при увольнении исключён из табеля с 14.10 и переведён в «Уволенные»).
// Состав табеля (firedInDismissalMonth) видит его до даты увольнения, состав подачи и 1С —
// нет. Запускается только при FOT_TEST_PG_URL; таблицы живут в отдельной схеме.

const PG_URL = process.env.FOT_TEST_PG_URL;
const SCHEMA = 'fired_month_membership_test';

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../config/postgres.js', async () => {
  const { Pool, types } = await import('pg');
  // Как в config/postgres.ts: DATE — строкой 'YYYY-MM-DD'.
  types.setTypeParser(1082, (val: string) => val);
  pg.pool = process.env.FOT_TEST_PG_URL
    ? new Pool({
      connectionString: process.env.FOT_TEST_PG_URL,
      max: 4,
      // Схема — литерал: фабрика vi.mock поднимается выше объявлений модуля.
      options: '-c search_path=fired_month_membership_test',
    })
    : null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool.query(sql, params as unknown[]);
  };
  return {
    query: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows[0] ?? null,
    execute: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rowCount ?? 0,
    withTransaction: vi.fn(),
  };
});

const DEPT = '00000000-0000-0000-0000-0000000000d1';
const ARCHIVE = '00000000-0000-0000-0000-0000000000a1';

vi.mock('./skud-shared.service.js', () => ({
  collectDeptIds: vi.fn(async (id: string) => [id]),
}));

import { listEmployeeMembershipsForDepartmentPeriod } from './timesheet-department-assignments.service.js';

const FIRED = 2005;
const ACTIVE = 100;

const members = async (start: string, end: string, firedInDismissalMonth?: boolean) => {
  const rows = await listEmployeeMembershipsForDepartmentPeriod(
    DEPT, start, end, undefined, firedInDismissalMonth === undefined ? undefined : { firedInDismissalMonth },
  );
  return new Map(rows.map(m => [m.employee_id, m]));
};

describe.skipIf(!PG_URL)('уволенный в месяце увольнения — состав табеля и состав подачи (PostgreSQL)', () => {
  beforeAll(async () => {
    await pg.pool!.query(`
      DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
      CREATE SCHEMA ${SCHEMA};
      CREATE TABLE ${SCHEMA}.employees (
        id integer PRIMARY KEY,
        org_department_id uuid,
        is_archived boolean NOT NULL DEFAULT false,
        employment_status text NOT NULL,
        dismissal_date date,
        excluded_from_timesheet boolean NOT NULL DEFAULT false,
        excluded_from_timesheet_date date
      );
      CREATE TABLE ${SCHEMA}.employee_assignments (
        employee_id integer NOT NULL,
        org_department_id uuid,
        effective_from date NOT NULL,
        effective_to date
      );
      CREATE TABLE ${SCHEMA}.employee_dismissal_events (
        employee_id integer NOT NULL,
        from_department_id uuid,
        dismissal_date date,
        cancelled boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO ${SCHEMA}.employees VALUES
        (${FIRED}, '${ARCHIVE}', false, 'fired', '2026-10-13', true, '2026-10-14'),
        (${ACTIVE}, '${DEPT}', false, 'active', NULL, false, NULL);
      INSERT INTO ${SCHEMA}.employee_assignments VALUES
        (${FIRED}, '${DEPT}', '2026-01-01', '2026-10-13'),
        (${FIRED}, '${ARCHIVE}', '2026-10-14', NULL);
      INSERT INTO ${SCHEMA}.employee_dismissal_events (employee_id, from_department_id, dismissal_date)
        VALUES (${FIRED}, '${DEPT}', '2026-10-13');
    `);
  });

  afterAll(async () => {
    await pg.pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pg.pool?.end();
  });

  it('сентябрь (до месяца увольнения) — виден в обоих составах', async () => {
    for (const option of [undefined, true]) {
      const map = await members('2026-09-01', '2026-09-30', option);
      expect(map.has(ACTIVE)).toBe(true);
      expect(map.get(FIRED)?.transferred_out_date).toBe('2026-10-14');
    }
  });

  it('октябрь — в составе подачи его нет', async () => {
    const map = await members('2026-10-01', '2026-10-31');
    expect(map.has(ACTIVE)).toBe(true);
    expect(map.has(FIRED)).toBe(false);
  });

  it('октябрь — в составе табеля есть, с выходом 14.10', async () => {
    const map = await members('2026-10-01', '2026-10-31', true);
    expect(map.has(ACTIVE)).toBe(true);
    expect(map.get(FIRED)?.transferred_out_date).toBe('2026-10-14');
  });

  it('вторая половина октября (после увольнения) — нет ни в одном составе', async () => {
    for (const option of [undefined, true]) {
      const map = await members('2026-10-16', '2026-10-31', option);
      expect(map.has(FIRED)).toBe(false);
    }
  });

  it('ноябрь — нет ни в одном составе', async () => {
    for (const option of [undefined, true]) {
      const map = await members('2026-11-01', '2026-11-30', option);
      expect(map.has(ACTIVE)).toBe(true);
      expect(map.has(FIRED)).toBe(false);
    }
  });
});
