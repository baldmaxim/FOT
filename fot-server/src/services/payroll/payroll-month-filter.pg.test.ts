import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../types/index.js';

// Фильтры «Категория» и «Объект» «Расчётов» на настоящем PostgreSQL: пары «сотрудник + месяц» — только месяцы, где
// строка видна (без фантомных месяцев принятого и уволенного), оба условия — в одной паре, total и порции по курсору,
// список объектов (уникальные сотрудники, свой объект не сужает), варианты столбцов и переход поиска ФИО в fuzzy.
// Профиль пары подставляется: его расчёт сверяется со «Сводом» в payroll-summary.pg.test.ts.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы пересоздаются). Гонять отдельно от других
// *.pg.test.ts: они дропают те же таблицы.

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../../config/postgres.js', async () => {
  const { Pool, types } = await import('pg');
  types.setTypeParser(1082, (val: string) => val);
  types.setTypeParser(20, (val: string) => Number.parseInt(val, 10));
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 5 }) : null;
  const pool = () => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool;
  };
  return {
    pool,
    query: async (sql: string, params?: readonly unknown[]) => (await pool().query(sql, params as unknown[])).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) =>
      (await pool().query(sql, params as unknown[])).rows[0] ?? null,
    execute: async (sql: string, params?: readonly unknown[]) =>
      (await pool().query(sql, params as unknown[])).rowCount ?? 0,
  };
});

const KHIMKI = '00000000-0000-0000-0000-00000000000a';
const MYTISHCHI = '00000000-0000-0000-0000-00000000000b';

// Профиль пары: ключ «сотрудник|YYYY-MM». Пары, которых не должно быть (фантомные месяцы), тоже заданы — и как
// «рабочий» — чтобы ошибка в составе пар была видна в результате, а не только в вызовах.
const profiles = vi.hoisted(() => ({
  byPair: new Map<string, { category: string; object: { key: string; name: string } }>(),
  calls: [] as Array<Array<{ employeeId: number; month: string }>>,
}));
vi.mock('./payroll-month-profile.service.js', () => ({
  loadMonthProfiles: async (pairs: Array<{ employeeId: number; month: string }>) => {
    profiles.calls.push(pairs.map(pair => ({ ...pair })));
    return new Map(pairs
      .map(pair => `${pair.employeeId}|${pair.month}`)
      .filter(key => profiles.byPair.has(key))
      .map(key => [key, profiles.byPair.get(key)]));
  },
}));

vi.mock('./payroll-staff-category.js', () => ({
  resolveCurrentStaffCategories: async (ids: number[]) => new Map(ids.map(id => [id, 'office'])),
}));
vi.mock('./payroll-scope.service.js', () => ({
  resolvePayrollReadableDepartmentIds: async () => 'all',
  canReadPayrollEmployee: async () => true,
  canEditPayrollEmployee: async () => true,
  resolvePayrollEditPredicate: async () => () => true,
}));
vi.mock('../../config/contractor.js', () => ({ getContractorRootId: async () => null }));
vi.mock('../audit.service.js', () => ({ auditService: { logFromRequest: async () => undefined } }));
const ARCHIVE = '00000000-0000-0000-0000-0000000000a0';
vi.mock('../employee-archive-department.service.js', () => ({
  getKnownArchiveDepartment: async () => ({ id: '00000000-0000-0000-0000-0000000000a0', name: 'Уволенные' }),
}));
vi.mock('./payroll-calc.service.js', () => ({
  getPayoutForEmployees: async () => new Map(),
  getPreliminaryPayoutForEmployees: async () => new Map(),
}));

import { payrollTermsController } from '../../controllers/payroll-terms.controller.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../docs/migrations/', import.meta.url));
const migration = (name: string): string => readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf8');

const SITE = '00000000-0000-0000-0000-0000000000d1';
const USER = '00000000-0000-0000-0000-0000000000e1';
const SEP_OCT = '2026-09,2026-10';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: any };
};

const call = async (
  handler: (req: AuthenticatedRequest, res: Response) => Promise<void>,
  query: Record<string, string>,
) => {
  const res = makeRes();
  await handler({ user: { id: USER }, params: {}, body: {}, query: { date: '2026-10-15', ...query } } as unknown as AuthenticatedRequest, res);
  return res;
};

const listIds = async (query: Record<string, string>) => {
  const res = await call(payrollTermsController.list, { defer_calc: '1', ...query });
  expect(res.statusCode).toBe(200);
  return {
    ids: (res.body.data as Array<{ employee_id: number }>).map(row => row.employee_id),
    total: Number(res.body.meta.total),
    next: res.body.meta.next_cursor as { key: string | null; isNull: boolean; id: number } | null,
  };
};

const setProfile = (employeeId: number, month: string, category: string, objectKey: string) => {
  const names: Record<string, string> = { [KHIMKI]: 'ЖК Химки', [MYTISHCHI]: 'ЖК Мытищи', office: 'Офис', unknown: 'Не определён' };
  profiles.byPair.set(`${employeeId}|${month}`, { category, object: { key: objectKey, name: names[objectKey] } });
};

describe.skipIf(!PG_URL)('«Расчёты»: фильтры «Категория» и «Объект» на PostgreSQL', () => {
  beforeAll(async () => {
    await pg.pool!.query(`
      DROP TABLE IF EXISTS payroll_1c_payout_imports, payroll_1c_payout_lines, payroll_1c_payout_documents,
        employee_hr_profiles, employee_assignments, employee_dismissal_events, skud_daily_summary, attendance_adjustments,
        employee_dormitory_stays, payroll_compensation_stops, payroll_rate_values, payroll_rates,
        payroll_paid_amounts, payroll_planned_supplements, payroll_settings, payroll_item_types,
        payroll_compensation_terms, payroll_employee_deductions, payroll_deduction_kinds, employee_schedule_assignments, work_schedules, positions,
        user_profiles, employees, org_departments CASCADE;
      DROP FUNCTION IF EXISTS public.get_descendant_department_ids(uuid[]);
      CREATE TABLE org_departments (id uuid PRIMARY KEY, name text, parent_id uuid, kind text);
      CREATE TABLE positions (id uuid PRIMARY KEY, name text);
      CREATE TABLE employees (
        id integer PRIMARY KEY, full_name text, tab_number text,
        org_department_id uuid REFERENCES org_departments(id), position_id uuid REFERENCES positions(id),
        employment_status text NOT NULL DEFAULT 'active', is_archived boolean NOT NULL DEFAULT false,
        hire_date date, dismissal_date date
      );
      CREATE TABLE employee_assignments (
        id serial PRIMARY KEY, employee_id integer NOT NULL, org_department_id uuid,
        effective_from date NOT NULL, effective_to date
      );
      CREATE TABLE employee_dismissal_events (
        id serial PRIMARY KEY, employee_id integer NOT NULL, from_department_id uuid, dismissal_date date,
        cancelled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE skud_daily_summary (employee_id integer NOT NULL, date date NOT NULL, total_minutes integer);
      CREATE TABLE attendance_adjustments (employee_id integer NOT NULL, work_date date NOT NULL);
      CREATE TABLE user_profiles (id uuid PRIMARY KEY, full_name text);
      CREATE TABLE work_schedules (id serial PRIMARY KEY, name text, is_default boolean NOT NULL DEFAULT false);
      CREATE TABLE employee_schedule_assignments (
        id serial PRIMARY KEY, employee_id integer NOT NULL REFERENCES employees(id),
        schedule_id integer REFERENCES work_schedules(id), effective_from date NOT NULL, effective_to date
      );
      CREATE FUNCTION public.get_descendant_department_ids(uuid[]) RETURNS TABLE(id uuid)
        LANGUAGE sql AS $$ SELECT unnest($1) $$;
      INSERT INTO org_departments (id, name) VALUES ('${SITE}', 'Участок'), ('${ARCHIVE}', 'Уволенные');
      INSERT INTO employees (id, full_name, org_department_id, employment_status, hire_date, dismissal_date) VALUES
        (1, 'Акимов А.А.', '${SITE}', 'active', '2025-01-01', NULL),
        -- Принят в октябре: сентября у него нет.
        (2, 'Борисов Б.Б.', '${SITE}', 'active', '2026-10-05', NULL),
        -- Уволен 20.09 с проходом в сентябре: октября у него нет.
        (3, 'Васильев В.В.', '${ARCHIVE}', 'fired', '2025-01-01', '2026-09-20'),
        (4, 'Григорьев Г.Г.', '${SITE}', 'active', '2025-01-01', NULL),
        (5, 'Сидоров С.С.', '${SITE}', 'active', '2025-01-01', NULL),
        (6, 'Сидаров А.А.', '${SITE}', 'active', '2025-01-01', NULL);
      INSERT INTO employee_dismissal_events (employee_id, from_department_id, dismissal_date) VALUES (3, '${SITE}', '2026-09-20');
      INSERT INTO skud_daily_summary (employee_id, date, total_minutes) VALUES (3, '2026-09-10', 480);
    `);
    for (const name of [
      '271_payroll_terms.sql', '282_payroll_terms_bonus_housing.sql', '286_payroll_terms_compensations.sql',
      '293_payroll_planned_supplements.sql', '322_payroll_planned_supplement_open_end.sql',
      '337_payroll_planned_supplement_rewrite.sql', '295_payroll_paid_amounts.sql', '297_payroll_paid_groups.sql',
      '298_payroll_paid_drop_payouts.sql', '299_payroll_deduction_kinds.sql', '300_payroll_employee_deductions.sql',
      '301_payroll_paid_order_kinds.sql',
    ]) {
      await pg.pool!.query(migration(name));
    }
    await pg.pool!.query(`CREATE TABLE employee_dormitory_stays (
      employee_id integer NOT NULL, kind text NOT NULL, check_in date NOT NULL, check_out date, amount numeric(12,2))`);
    await pg.pool!.query(`CREATE TABLE payroll_compensation_stops (
      employee_id integer NOT NULL, date_from date NOT NULL, date_to date)`);
    for (const name of ['306_payroll_rates.sql', '313_payroll_rate_code.sql', '324_payroll_rate_values.sql']) {
      await pg.pool!.query(migration(name));
    }
    await pg.pool!.query(`ALTER TABLE payroll_compensation_terms
      ADD COLUMN IF NOT EXISTS proration_rounding TEXT NOT NULL DEFAULT 'ruble'`);
    await pg.pool!.query(migration('352_payroll_terms_contract_type.sql'));
    await pg.pool!.query('CREATE TABLE employee_hr_profiles (employee_id integer, passdesk_id_all uuid)');
    await pg.pool!.query(migration('328_payroll_1c_payouts.sql'));

    // Акимов: ИТР на Химках в сентябре, рабочий в Мытищах в октябре.
    setProfile(1, '2026-09', 'itr', KHIMKI);
    setProfile(1, '2026-10', 'worker', MYTISHCHI);
    // Фантомные пары (их быть не должно): Борисов — сентябрь, Васильев — октябрь.
    setProfile(2, '2026-09', 'worker', KHIMKI);
    setProfile(2, '2026-10', 'office', 'office');
    setProfile(3, '2026-09', 'worker', KHIMKI);
    setProfile(3, '2026-10', 'itr', MYTISHCHI);
    for (const month of ['2026-09', '2026-10']) {
      setProfile(4, month, 'itr', MYTISHCHI);
      setProfile(5, month, 'office', 'office');
      setProfile(6, month, 'worker', MYTISHCHI);
    }
  });

  beforeEach(() => {
    profiles.calls.length = 0;
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('пары — только месяцы, где строка видна: принятый в октябре и уволенный в сентябре без фантомных месяцев', async () => {
    const res = await call(payrollTermsController.monthObjects, { paid_months: SEP_OCT });
    expect(res.statusCode).toBe(200);
    expect(profiles.calls).toHaveLength(1);
    expect(profiles.calls[0].map(pair => `${pair.employeeId}|${pair.month}`).sort()).toEqual([
      '1|2026-09', '1|2026-10', '2|2026-10', '3|2026-09',
      '4|2026-09', '4|2026-10', '5|2026-09', '5|2026-10', '6|2026-09', '6|2026-10',
    ]);
    // count — уникальные сотрудники: Акимов в Химках (сентябрь) и в Мытищах (октябрь) — в обоих, по разу.
    expect(res.body.data).toEqual([
      { key: MYTISHCHI, name: 'ЖК Мытищи', count: 3 },
      { key: KHIMKI, name: 'ЖК Химки', count: 2 },
      { key: 'office', name: 'Офис', count: 2 },
    ]);
  });

  it('список объектов: категория сужает по паре месяца, свой объект — нет', async () => {
    const workers = await call(payrollTermsController.monthObjects, { paid_months: SEP_OCT, category: 'worker' });
    expect(workers.body.data).toEqual([
      { key: MYTISHCHI, name: 'ЖК Мытищи', count: 2 },
      { key: KHIMKI, name: 'ЖК Химки', count: 1 },
    ]);
    const withObject = await call(payrollTermsController.monthObjects, { paid_months: SEP_OCT, category: 'worker', object: KHIMKI });
    expect(withObject.body.data).toEqual(workers.body.data);
  });

  it('список: категория и объект — в одной паре месяца; total — только отобранные', async () => {
    expect(await listIds({ paid_months: SEP_OCT, category: 'itr', object: KHIMKI })).toMatchObject({ ids: [1], total: 1 });
    // Акимов — ИТР (сентябрь, Химки) и рабочий в Мытищах (октябрь): «ИТР + Мытищи» он не проходит.
    expect(await listIds({ paid_months: SEP_OCT, category: 'itr', object: MYTISHCHI })).toMatchObject({ ids: [4], total: 1 });
    expect(await listIds({ paid_months: SEP_OCT, category: 'worker', object: KHIMKI })).toMatchObject({ ids: [3], total: 1 });
    // Фантомный «рабочий» сентябрь Борисова не учитывается.
    expect(await listIds({ paid_months: SEP_OCT, category: 'worker' })).toMatchObject({ ids: [1, 3, 6], total: 3 });
    expect(await listIds({ paid_months: SEP_OCT, object: 'office' })).toMatchObject({ ids: [2, 5], total: 2 });
    // Один октябрь: уволенного в сентябре нет и с фантомным профилем октября.
    expect(await listIds({ paid_months: '2026-10', category: 'itr' })).toMatchObject({ ids: [4], total: 1 });
    // Без фильтров — все.
    expect((await listIds({ paid_months: SEP_OCT })).total).toBe(6);
  });

  it('фильтр держится на порциях по курсору', async () => {
    const base = { paid_months: SEP_OCT, category: 'worker', sort: 'name', dir: 'asc', page_size: '1' };
    const first = await listIds(base);
    expect(first).toMatchObject({ ids: [1], total: 3 });
    const cursorOf = (next: typeof first.next) => ({ after_key: String(next!.key), after_null: '0', after_id: String(next!.id) });
    const second = await listIds({ ...base, ...cursorOf(first.next) });
    expect(second).toMatchObject({ ids: [3], total: 3 });
    const third = await listIds({ ...base, ...cursorOf(second.next) });
    expect(third).toMatchObject({ ids: [6], total: 3 });
  });

  it('точный ФИО, скрытый категорией, переводит поиск в fuzzy', async () => {
    expect((await listIds({ paid_months: SEP_OCT, q: 'Сидоров' })).ids).toEqual([5]);
    // Сидоров — офис: среди рабочих точного совпадения нет, находится Сидаров с одной ошибкой.
    expect((await listIds({ paid_months: SEP_OCT, q: 'Сидоров', category: 'worker' })).ids).toEqual([6]);
  });

  it('варианты фильтра столбца — только по отобранным', async () => {
    const res = await call(payrollTermsController.columnValues, { paid_months: SEP_OCT, column: 'department', category: 'worker' });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.values).toEqual([{ value: 'Участок', count: 3 }]);
  });

  it('матрица параметров: без месяцев и «весь период» — 400; объект — office, unknown или UUID', async () => {
    const list = (query: Record<string, string>) => call(payrollTermsController.list, query);
    expect((await list({ category: 'itr' })).body.code).toBe('MONTH_FILTER_NEEDS_MONTHS');
    expect((await list({ paid_months: 'all', object: 'office' })).body.code).toBe('MONTH_FILTER_NEEDS_MONTHS');
    expect((await list({ paid_months: SEP_OCT, object: 'Химки' })).body.code).toBe('INVALID_MONTH_FILTER');
    expect((await list({ paid_months: SEP_OCT, category: 'boss' })).statusCode).toBe(400);
    const objects = await call(payrollTermsController.monthObjects, { paid_months: 'all' });
    expect(objects.statusCode).toBe(400);
    // Без фильтров — профиль не считается.
    await listIds({ paid_months: SEP_OCT });
    expect(profiles.calls).toEqual([]);
  });
});
