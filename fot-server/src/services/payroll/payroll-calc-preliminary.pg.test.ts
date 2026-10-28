import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Кандидаты в бригады предварительного расчёта «Расчётов» на настоящем PostgreSQL: те же три источника, что у
// членства отдела — назначения за [1-е, asOf], текущий отдел (снимок) и отдел увольнения в месяце.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы-заглушки пересоздаются).

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../../config/postgres.js', async () => {
  const { Pool } = await import('pg');
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 2 }) : null;
  return {
    getPool: () => pg.pool,
    query: async (sql: string, params?: readonly unknown[]) => {
      if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
      return (await pg.pool.query(sql, params as unknown[])).rows;
    },
    queryOne: vi.fn(),
    execute: vi.fn(),
    withTransaction: vi.fn(),
  };
});

import { loadBrigadeCandidates } from './payroll-calc-preliminary.service.js';

const q = async (sql: string, params?: unknown[]) => (await pg.pool!.query(sql, params)).rows;

const B = (n: number) => `00000000-0000-0000-0000-00000000000${n}`;
const DEPT = '00000000-0000-0000-0000-000000000099';

describe.skipIf(!PG_URL)('кандидаты в бригады на PostgreSQL', () => {
  beforeAll(async () => {
    await q('DROP TABLE IF EXISTS employee_dismissal_events, employee_assignments, employees, org_departments CASCADE');
    await q('CREATE TABLE org_departments (id uuid PRIMARY KEY, kind text)');
    await q('CREATE TABLE employees (id int PRIMARY KEY, org_department_id uuid)');
    await q(`CREATE TABLE employee_assignments (
               id bigserial PRIMARY KEY, employee_id int NOT NULL, org_department_id uuid,
               effective_from date NOT NULL, effective_to date)`);
    await q(`CREATE TABLE employee_dismissal_events (
               id bigserial PRIMARY KEY, employee_id int NOT NULL, from_department_id uuid, dismissal_date date,
               cancelled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now())`);
    await q(`INSERT INTO org_departments (id, kind) VALUES
               ($1, 'brigade'), ($2, 'brigade'), ($3, 'brigade'), ($4, 'brigade'), ($5, 'brigade'), ($6, 'brigade'),
               ($7, 'department')`,
    [B(1), B(2), B(3), B(4), B(5), B(6), DEPT]);
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('рабочий только в employees.org_department_id (без назначений) — его бригада', async () => {
    await q('INSERT INTO employees (id, org_department_id) VALUES (1, $1)', [B(1)]);
    expect(await loadBrigadeCandidates([1], '2026-09-01', '2026-09-30')).toEqual([B(1)]);
  });

  it('уволенный без назначения — бригада из employee_dismissal_events; отменённое и до месяца — нет', async () => {
    await q('INSERT INTO employees (id, org_department_id) VALUES (2, NULL)');
    await q(`INSERT INTO employee_dismissal_events (employee_id, from_department_id, dismissal_date, cancelled) VALUES
               (2, $1, '2026-09-10', false), (2, $2, '2026-09-12', true), (2, $3, '2026-08-20', false)`,
    [B(2), B(3), B(4)]);
    expect(await loadBrigadeCandidates([2], '2026-09-01', '2026-09-30')).toEqual([B(2)]);
  });

  it('перевод бригада → отдел 16-го: бригада по назначению, отдел не бригада; назначения вне [1-е, asOf] — нет', async () => {
    await q('INSERT INTO employees (id, org_department_id) VALUES (3, $1)', [DEPT]);
    await q(`INSERT INTO employee_assignments (employee_id, org_department_id, effective_from, effective_to) VALUES
               (3, $1, '2026-01-01', '2026-09-15'), (3, $2, '2026-09-16', NULL),
               (3, $3, '2025-01-01', '2026-08-31'), (3, $4, '2026-10-28', NULL)`,
    [B(5), DEPT, B(3), B(6)]);
    expect(await loadBrigadeCandidates([3], '2026-09-01', '2026-09-30')).toEqual([B(5)]);
    // Текущий месяц по 27.10: назначение с 28.10 ещё не действует.
    expect(await loadBrigadeCandidates([3], '2026-10-01', '2026-10-27')).toEqual([]);
  });
});
