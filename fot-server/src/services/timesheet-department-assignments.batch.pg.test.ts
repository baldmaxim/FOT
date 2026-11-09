import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Состав многих отделов разом (listEmployeeMembershipsForDepartmentsPeriod, «Свод» и «Расчёты») = одиночная
// listEmployeeMembershipsForDepartmentPeriod по каждому отделу — на настоящем PostgreSQL, все ветки правил, родитель
// и его дочерняя бригада в одном запросе; начальники участка по бригадам = одиночный список на бригаду. Запускается
// только при FOT_TEST_PG_URL; таблицы живут в отдельной схеме.

const PG_URL = process.env.FOT_TEST_PG_URL;
const SCHEMA = 'membership_batch_test';

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
      options: '-c search_path=membership_batch_test',
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

const P = '00000000-0000-4000-8000-0000000000a1'; // участок-родитель
const C = '00000000-0000-4000-8000-0000000000a2'; // дочерняя бригада участка
const B1 = '00000000-0000-4000-8000-0000000000b1';
const B2 = '00000000-0000-4000-8000-0000000000b2';
const B3 = '00000000-0000-4000-8000-0000000000b3';
const EMPTY = '00000000-0000-4000-8000-0000000000e1';
const OFFICE = '00000000-0000-4000-8000-0000000000f1';
const ARCHIVE = '00000000-0000-4000-8000-0000000000f2';

vi.mock('./skud-shared.service.js', () => ({
  collectDeptIds: vi.fn(async (id: string) => (id === P ? [P, C] : [id])),
}));

import {
  listEmployeeMembershipsForDepartmentPeriod,
  listEmployeeMembershipsForDepartmentsPeriod,
} from './timesheet-department-assignments.service.js';
import {
  listBrigadeSupervisorEmployeeIdsForDepartments,
  listBrigadeSupervisorsByDepartment,
} from '../controllers/timesheet-assigned-export.controller.js';

const sorted = <T extends { employee_id: number }>(rows: readonly T[]): T[] => (
  [...rows].sort((a, b) => a.employee_id - b.employee_id)
);

describe.skipIf(!PG_URL)('состав многих отделов разом = одиночный по каждому (PostgreSQL)', () => {
  beforeAll(async () => {
    await pg.pool!.query(`
      DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
      CREATE SCHEMA ${SCHEMA};
      CREATE TABLE ${SCHEMA}.employees (
        id integer PRIMARY KEY,
        org_department_id uuid,
        is_archived boolean NOT NULL DEFAULT false,
        employment_status text NOT NULL DEFAULT 'active',
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
      CREATE TABLE ${SCHEMA}.org_departments (id uuid PRIMARY KEY, kind text, is_active boolean NOT NULL DEFAULT true);
      CREATE TABLE ${SCHEMA}.system_roles (id integer PRIMARY KEY, code text);
      CREATE TABLE ${SCHEMA}.user_profiles (id uuid PRIMARY KEY, employee_id integer, system_role_id integer);
      CREATE TABLE ${SCHEMA}.employee_department_access (
        employee_id integer, department_id uuid, is_active boolean NOT NULL DEFAULT true,
        access_level text NOT NULL DEFAULT 'full', source text NOT NULL DEFAULT 'manual'
      );

      -- Сотрудники (id: отдел карточки, архив, статус, увольнение, исключение из табеля).
      INSERT INTO ${SCHEMA}.employees VALUES
        (1,  '${B1}',     false, 'active', NULL,         false, NULL),          -- просто в бригаде
        (2,  '${B2}',     false, 'active', NULL,         false, NULL),          -- переведён B1 → B2 11.09
        (3,  '${B1}',     false, 'active', NULL,         false, NULL),          -- B1, отдел, снова B1: открытое побеждает
        (4,  '${ARCHIVE}', false, 'fired', '2026-09-20', true, '2026-09-21'),   -- уволен из B1 20.09, назначений нет
        (5,  '${B2}',     false, 'active', NULL,         false, NULL),          -- только snapshot
        (6,  '${B2}',     false, 'active', NULL,         false, NULL),          -- пришёл в B2 только 05.10
        (7,  '${B1}',     false, 'active', NULL,         true,  '2026-08-15'),  -- исключён до начала сентября
        (8,  '${B1}',     false, 'active', NULL,         true,  '2026-09-20'),  -- исключён после начала
        (9,  '${B1}',     true,  'active', NULL,         false, NULL),          -- архивный
        (10, '${C}',      false, 'active', NULL,         false, NULL),          -- в дочерней бригаде
        (11, '${C}',      false, 'active', NULL,         false, NULL),          -- из участка в дочернюю 05.10
        (12, '${B3}',     false, 'active', NULL,         false, NULL),          -- два входа переводом в B3
        (13, '${B1}',     false, 'fired', '2026-08-10', false, NULL),           -- уволен в августе, в сентябре нет
        (20, '${B2}',     false, 'active', NULL,         false, NULL),          -- начальник B1, состоит в B2
        (21, '${OFFICE}', false, 'active', NULL,         false, NULL);          -- начальник B1 и B2
      INSERT INTO ${SCHEMA}.employee_assignments VALUES
        (1,  '${B1}', '2026-01-01', NULL),
        (2,  '${B1}', '2026-01-01', '2026-09-10'), (2, '${B2}', '2026-09-11', NULL),
        (3,  '${B1}', '2026-09-01', '2026-09-10'), (3, '${OFFICE}', '2026-09-11', '2026-09-14'),
        (3,  '${B1}', '2026-09-15', NULL),
        (6,  '${OFFICE}', '2026-01-01', '2026-10-04'), (6, '${B2}', '2026-10-05', NULL),
        (7,  '${B1}', '2026-01-01', NULL),
        (8,  '${B1}', '2026-01-01', NULL),
        (9,  '${B1}', '2026-01-01', NULL),
        (10, '${C}',  '2026-01-01', NULL),
        (11, '${P}',  '2026-01-01', '2026-10-04'), (11, '${C}', '2026-10-05', NULL),
        (12, '${OFFICE}', '2026-01-01', '2026-08-31'), (12, '${B3}', '2026-09-01', '2026-09-10'),
        (12, '${OFFICE}', '2026-09-11', '2026-09-14'), (12, '${B3}', '2026-09-15', NULL),
        (13, '${B1}', '2026-01-01', '2026-08-10'),
        (20, '${B2}', '2026-01-01', NULL);
      INSERT INTO ${SCHEMA}.employee_dismissal_events (employee_id, from_department_id, dismissal_date)
        VALUES (4, '${B1}', '2026-09-20'), (13, '${B1}', '2026-08-10');
      INSERT INTO ${SCHEMA}.org_departments (id, kind) VALUES
        ('${P}', 'department'), ('${C}', 'brigade'), ('${B1}', 'brigade'), ('${B2}', 'brigade'), ('${B3}', 'brigade'),
        ('${EMPTY}', 'brigade'), ('${OFFICE}', 'department'), ('${ARCHIVE}', 'department');
      INSERT INTO ${SCHEMA}.system_roles VALUES (1, 'site_supervisor'), (2, 'worker');
      INSERT INTO ${SCHEMA}.user_profiles VALUES
        ('00000000-0000-4000-8000-000000000020', 20, 1),
        ('00000000-0000-4000-8000-000000000021', 21, 1),
        ('00000000-0000-4000-8000-000000000001', 1, 2);
      INSERT INTO ${SCHEMA}.employee_department_access (employee_id, department_id, access_level, source) VALUES
        (20, '${B1}', 'full', 'manual'),
        (21, '${B1}', 'full', 'manual'), (21, '${B2}', 'full', 'manual'),
        (1,  '${B1}', 'full', 'manual'),        -- не начальник участка (роль worker)
        (20, '${B3}', 'view', 'manual');        -- не full — не начальник B3
    `);
  });

  afterAll(async () => {
    await pg.pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pg.pool?.end();
  });

  const ROOTS = [P, C, B1, B2, EMPTY];
  const PERIODS: Array<[string, string]> = [
    ['2026-08-01', '2026-08-31'],
    ['2026-09-01', '2026-09-30'],
    ['2026-09-16', '2026-09-30'],
    ['2026-10-01', '2026-10-31'],
  ];

  it('каждый корень, оба вида состава, четыре периода — как одиночная; запись на каждый запрошенный отдел', async () => {
    for (const [start, end] of PERIODS) {
      for (const firedInDismissalMonth of [false, true]) {
        // Дубли и другой порядок id — тот же результат.
        const batch = await listEmployeeMembershipsForDepartmentsPeriod(
          [B2, ...ROOTS, B1], start, end, { firedInDismissalMonth },
        );
        expect([...batch.keys()].sort()).toEqual([...ROOTS].sort());
        for (const root of ROOTS) {
          const single = await listEmployeeMembershipsForDepartmentPeriod(root, start, end, undefined, { firedInDismissalMonth });
          expect({ root, start, firedInDismissalMonth, rows: batch.get(root) })
            .toEqual({ root, start, firedInDismissalMonth, rows: sorted(single) });
        }
      }
    }
    expect(await listEmployeeMembershipsForDepartmentsPeriod([], '2026-09-01', '2026-09-30')).toEqual(new Map());
  });

  it('сентябрь: ветки правил дают ожидаемый состав', async () => {
    const batch = await listEmployeeMembershipsForDepartmentsPeriod(ROOTS, '2026-09-01', '2026-09-30', { firedInDismissalMonth: true });
    const byId = (root: string) => new Map(batch.get(root)!.map(row => [row.employee_id, row]));
    const b1 = byId(B1);
    const b2 = byId(B2);
    expect([...b1.keys()]).toEqual([1, 2, 3, 4, 8]);
    expect(b1.get(2)).toMatchObject({ transferred_out_date: '2026-09-11' });
    expect(b1.get(3)).toMatchObject({ joined_date: '2026-09-01', transferred_out_date: null, joined_via_transfer: false });
    expect(b1.get(4)).toMatchObject({ transferred_out_date: '2026-09-21', joined_date: null });
    expect([...b2.keys()]).toEqual([2, 5, 20]);
    expect(b2.get(2)).toMatchObject({ joined_date: '2026-09-11', joined_via_transfer: true });
    // Родитель видит и дочернюю; №11 из участка в дочернюю после периода — для участка не «извне», для дочерней —
    // «извне» (в дочерней его в сентябре нет).
    expect([...byId(P).keys()]).toEqual([10, 11]);
    expect(byId(P).get(11)).toMatchObject({ transferred_out_date: null });
    expect([...byId(C).keys()]).toEqual([10]);
    expect(batch.get(EMPTY)).toEqual([]);
    // Состав подачи (без firedInDismissalMonth): уволенный в сентябре в сентябре не виден.
    const submission = await listEmployeeMembershipsForDepartmentsPeriod([B1], '2026-09-01', '2026-09-30');
    expect(submission.get(B1)!.map(row => row.employee_id)).toEqual([1, 2, 3, 8]);
  });

  it('два входа переводом в одно поддерево, один из них = joined — вход переводом', async () => {
    const batch = await listEmployeeMembershipsForDepartmentsPeriod([B3], '2026-09-01', '2026-09-30', { firedInDismissalMonth: true });
    expect(batch.get(B3)).toEqual([
      { employee_id: 12, transferred_out_date: null, joined_date: '2026-09-01', joined_via_transfer: true },
    ]);
  });

  it('начальники участка по бригадам = одиночный список на бригаду; начальник двух бригад — в обеих', async () => {
    const ids = [B1, B2, B3, EMPTY, C, B1];
    const byBrigade = await listBrigadeSupervisorsByDepartment(ids);
    expect([...byBrigade.keys()].sort()).toEqual([B1, B2, B3, EMPTY, C].sort());
    for (const id of [B1, B2, B3, EMPTY, C]) {
      expect(byBrigade.get(id)).toEqual(await listBrigadeSupervisorEmployeeIdsForDepartments([id]));
    }
    expect(byBrigade.get(B1)).toEqual(new Set([20, 21]));
    expect(byBrigade.get(B2)).toEqual(new Set([21]));
    expect(byBrigade.get(B3)).toEqual(new Set());
    // Union-список не изменился: все начальники всех бригад.
    expect(await listBrigadeSupervisorEmployeeIdsForDepartments([B1, B2])).toEqual(new Set([20, 21]));
    // Ключ — переданный id, даже в верхнем регистре.
    expect((await listBrigadeSupervisorsByDepartment([B1.toUpperCase()])).get(B1.toUpperCase())).toEqual(new Set([20, 21]));
    expect(await listBrigadeSupervisorsByDepartment([])).toEqual(new Map());
  });
});
