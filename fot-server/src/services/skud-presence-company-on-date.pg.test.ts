import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Загрузчик истории для «компании на дату» на настоящем PostgreSQL: типы колонок
// (date/uuid → строки), отмена увольнений, увольнение «в архив», порядок и выбор отдела.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы-заглушки пересоздаются).

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../config/postgres.js', async () => {
  const { Pool } = await import('pg');
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 4 }) : null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool.query(sql, params as unknown[]);
  };
  return {
    getPool: () => pg.pool,
    query: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows[0] ?? null,
    execute: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rowCount ?? 0,
    withTransaction: vi.fn(),
  };
});

const DEPT_SU10 = '00000000-0000-0000-0000-0000000000a1';
const DEPT_LINIYA = '00000000-0000-0000-0000-0000000000b1';
const ARCHIVE = '00000000-0000-0000-0000-0000000000ff';

vi.mock('./skud-shared.service.js', () => ({
  collectDeptIds: vi.fn(),
  getCompanyResolveIndex: vi.fn(async () => ({
    rootId: 'root',
    companyByDeptId: new Map([[DEPT_SU10, 'c-su10'], [DEPT_LINIYA, 'c-liniya'], [ARCHIVE, 'c-archive']]),
    companyMeta: new Map([
      ['c-su10', { id: 'c-su10', name: 'СУ-10', sigur_department_id: 10 }],
      ['c-liniya', { id: 'c-liniya', name: 'ЛИНИЯ', sigur_department_id: 20 }],
      ['c-archive', { id: 'c-archive', name: 'Уволенные', sigur_department_id: 99 }],
    ]),
    companyBySigurId: new Map(),
    companyByNormalizedName: new Map(),
  })),
}));

const { loadCompanyOnDateSource, resolveCompanyOnDate } = await import('./skud-presence-company-on-date.service.js');

const q = (sql: string, params?: unknown[]) => pg.pool!.query(sql, params);

const resetSchema = async (): Promise<void> => {
  await q(`
    DROP TABLE IF EXISTS employee_assignments, employee_dismissal_events, employees;
    CREATE TABLE employees (id integer PRIMARY KEY, org_department_id uuid);
    CREATE TABLE employee_assignments (
      id uuid PRIMARY KEY,
      employee_id integer NOT NULL,
      org_department_id uuid,
      effective_from date NOT NULL,
      effective_to date,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE employee_dismissal_events (
      id serial PRIMARY KEY,
      employee_id integer NOT NULL,
      dismissal_date date,
      cancelled boolean NOT NULL DEFAULT false,
      from_department_id uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
};

describe.skipIf(!PG_URL)('компания на дату: загрузчик на PostgreSQL', () => {
  beforeEach(async () => {
    await resetSchema();
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('уволенный после периода: сентябрь — СУ-10, назначение «Уволенные» не берётся', async () => {
    await q('INSERT INTO employees VALUES (1, $1)', [ARCHIVE]);
    await q(
      `INSERT INTO employee_assignments (id, employee_id, org_department_id, effective_from, effective_to) VALUES
         ('00000000-0000-0000-0000-000000000001', 1, $1, '2025-03-01', '2026-10-15'),
         ('00000000-0000-0000-0000-000000000002', 1, $2, '2026-10-16', NULL)`,
      [DEPT_SU10, ARCHIVE],
    );

    const source = await loadCompanyOnDateSource([1], ARCHIVE);
    const [row] = source.assignmentsByEmployee.get(1)!;
    expect(typeof row.effective_from).toBe('string');
    expect(row.effective_from).toBe('2025-03-01');
    expect(resolveCompanyOnDate(source, 1, '2026-09-10')).toEqual({ key: 'local:c-su10', name: 'СУ-10' });
  });

  it('только «Уволенные»: отменённое увольнение и увольнение «в архив» не учитываются', async () => {
    await q('INSERT INTO employees VALUES (2, $1)', [ARCHIVE]);
    await q(
      `INSERT INTO employee_assignments (id, employee_id, org_department_id, effective_from, effective_to)
       VALUES ('00000000-0000-0000-0000-000000000003', 2, $1, '2026-11-01', NULL)`,
      [ARCHIVE],
    );
    await q(
      `INSERT INTO employee_dismissal_events (employee_id, dismissal_date, cancelled, from_department_id) VALUES
         (2, '2026-09-20', true,  $1),
         (2, '2026-09-25', false, $2),
         (2, '2026-10-31', false, $3)`,
      [DEPT_SU10, ARCHIVE, DEPT_LINIYA],
    );

    const source = await loadCompanyOnDateSource([2], ARCHIVE);
    expect(source.dismissalsByEmployee.get(2)).toEqual([
      { employee_id: 2, from_department_id: DEPT_LINIYA, dismissal_date: '2026-10-31' },
    ]);
    expect(resolveCompanyOnDate(source, 2, '2026-09-10')).toEqual({ key: 'local:c-liniya', name: 'ЛИНИЯ' });
  });

  it('без истории назначений — текущий отдел; неизвестный сотрудник — «Без компании»', async () => {
    await q('INSERT INTO employees VALUES (3, $1)', [DEPT_LINIYA]);
    const source = await loadCompanyOnDateSource([3, 4], ARCHIVE);
    expect(resolveCompanyOnDate(source, 3, '2026-09-10').name).toBe('ЛИНИЯ');
    expect(resolveCompanyOnDate(source, 4, '2026-09-10').name).toBe('Без компании');
  });
});
