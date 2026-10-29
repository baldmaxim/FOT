import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// «Расчёты» за месяцы — только работавшие в них (payrollWorkedInMonthsSql) на настоящем PostgreSQL: те же источники
// состава, что у табеля отдела, отдел «Уволенные» не считается, принятый позже месяца в нём не работал.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы-заглушки пересоздаются).

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../../config/postgres.js', async () => {
  const { Pool } = await import('pg');
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 2 }) : null;
  return { getPool: () => pg.pool, query: vi.fn(), queryOne: vi.fn(), execute: vi.fn(), withTransaction: vi.fn() };
});

import { payrollWorkedInMonthsSql } from './payroll-registry-scope.service.js';

const q = async (sql: string, params?: unknown[]) => (await pg.pool!.query(sql, params)).rows;

const ARCHIVE = '00000000-0000-0000-0000-0000000000a0';
const BUH = '00000000-0000-0000-0000-0000000000b1';
const BRIGADE = '00000000-0000-0000-0000-0000000000b2';
const DEPT_A = '00000000-0000-0000-0000-0000000000c1';
const DEPT_B = '00000000-0000-0000-0000-0000000000c2';

/** Кто «работал» хотя бы в одном из месяцев. */
const worked = async (months: string[], archiveId: string | null = ARCHIVE): Promise<number[]> => (
  (await q(
    `SELECT e.id FROM employees e WHERE ${payrollWorkedInMonthsSql('e.id', '$1', '$2')} ORDER BY e.id`,
    [months, archiveId],
  )).map(row => Number(row.id))
);

describe.skipIf(!PG_URL)('работал в месяце — на PostgreSQL', () => {
  beforeAll(async () => {
    await q('DROP TABLE IF EXISTS employee_dismissal_events, employee_assignments, employees, org_departments CASCADE');
    await q('CREATE TABLE org_departments (id uuid PRIMARY KEY, name text)');
    await q('CREATE TABLE employees (id int PRIMARY KEY, org_department_id uuid, hire_date date)');
    await q(`CREATE TABLE employee_assignments (
               id bigserial PRIMARY KEY, employee_id int NOT NULL, org_department_id uuid,
               effective_from date NOT NULL, effective_to date)`);
    await q(`CREATE TABLE employee_dismissal_events (
               id bigserial PRIMARY KEY, employee_id int NOT NULL, from_department_id uuid, dismissal_date date,
               cancelled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now())`);
    await q(`INSERT INTO org_departments (id, name) VALUES
               ($1, 'Уволенные'), ($2, 'Бухгалтерия'), ($3, 'бр.Сайфзода'), ($4, 'Отдел А'), ($5, 'Отдел Б')`,
    [ARCHIVE, BUH, BRIGADE, DEPT_A, DEPT_B]);
    await q(`INSERT INTO employees (id, org_department_id, hire_date) VALUES
               (1, $1, '2025-04-21'),  -- Муравьева: уволена 31.07, «Уволенные» 01.08–14.10, восстановлена 15.10
               (2, $2, '2024-11-01'),  -- Ботирова: «Уволенные» с 07.07 не закрыто, по карточке — бригада
               (3, $1, '2026-10-01'),  -- принят первым числом следующего месяца
               (4, $1, '2026-09-30'),  -- принят последним числом месяца
               (5, $3, '2026-03-25'),  -- карточка в отделе «Уволенные»
               (6, $3, '2024-01-01'),  -- уволен 10.09 из Бухгалтерии
               (7, $3, '2024-01-01'),  -- увольнение 10.09 без отдела
               (8, $4, '2024-01-01'),  -- перевод А → Б 05.10, по карточке уже Б
               (9, NULL, NULL)         -- без отдела и назначений — признака «не работал» нет`,
    [BUH, BRIGADE, ARCHIVE, DEPT_B]);
    await q(`INSERT INTO employee_assignments (employee_id, org_department_id, effective_from, effective_to) VALUES
               (1, $1, '2026-06-01', '2026-07-31'), (1, $2, '2026-08-01', '2026-10-14'), (1, $1, '2026-10-15', NULL),
               (2, $3, '2026-07-06', '2026-07-06'), (2, $2, '2026-07-07', NULL),
               (6, $2, '2026-09-11', NULL),
               (8, $4, '2026-01-01', '2026-10-04'), (8, $5, '2026-10-05', NULL)`,
    [BUH, ARCHIVE, BRIGADE, DEPT_A, DEPT_B]);
    await q(`INSERT INTO employee_dismissal_events (employee_id, from_department_id, dismissal_date, cancelled) VALUES
               (1, $1, '2026-07-31', false), (1, NULL, '2026-07-31', false),
               (6, $1, '2026-09-10', false),
               (7, NULL, '2026-09-10', false)`,
    [BUH]);
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('сентябрь: без уволенной на весь месяц, принятого 01.10, карточки «Уволенные» и увольнения без отдела', async () => {
    // 2 — незакрытое «Уволенные», но отдел карточки рабочий; 4 — принят 30.09; 6 — уволен 10.09 из Бухгалтерии;
    // 8 — переведён после месяца, сентябрь — по назначению в отдел А.
    expect(await worked(['2026-09-01'])).toEqual([2, 4, 6, 8, 9]);
  });

  it('октябрь: Муравьева — восстановлена 15.10, принятый 01.10 есть; уволенный 10.09 — нет', async () => {
    expect(await worked(['2026-10-01'])).toEqual([1, 2, 3, 4, 8, 9]);
  });

  it('сентябрь + октябрь — работавшие хоть в одном', async () => {
    expect(await worked(['2026-09-01', '2026-10-01'])).toEqual([1, 2, 3, 4, 6, 8, 9]);
  });

  it('отдел «Уволенные» не найден — только дата приёма', async () => {
    expect(await worked(['2026-09-01'], null)).toEqual([1, 2, 4, 5, 6, 7, 8, 9]);
  });
});
