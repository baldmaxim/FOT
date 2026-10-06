import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../types/index.js';

// Плановая доплата на настоящем PostgreSQL: журнал версий (миграция 293), действие и прежние
// значения в истории, два параллельных сохранения, общий журнал с окладом, SQL списка.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы пересоздаются).
// В обычном прогоне пропускается.

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../../config/postgres.js', async () => {
  const { Pool, types } = await import('pg');
  // Как в config/postgres.ts: DATE — строкой YYYY-MM-DD, INT8 — числом.
  types.setTypeParser(1082, (val: string) => val);
  types.setTypeParser(20, (val: string) => Number.parseInt(val, 10));
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 5 }) : null;
  const pool = () => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool;
  };
  return {
    query: async (sql: string, params?: readonly unknown[]) => (await pool().query(sql, params as unknown[])).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) =>
      (await pool().query(sql, params as unknown[])).rows[0] ?? null,
    execute: async (sql: string, params?: readonly unknown[]) =>
      (await pool().query(sql, params as unknown[])).rowCount ?? 0,
    withTransaction: async <T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> => {
      const client = await pool().connect();
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

vi.mock('./payroll-scope.service.js', () => ({
  resolvePayrollReadableDepartmentIds: async () => 'all',
  canReadPayrollEmployee: async () => true,
  canEditPayrollEmployee: async () => true,
  resolvePayrollEditPredicate: async () => () => true,
}));

vi.mock('../../config/contractor.js', () => ({ getContractorRootId: async () => null }));

vi.mock('../audit.service.js', () => ({ auditService: { logFromRequest: async () => undefined } }));

import { withTransaction } from '../../config/postgres.js';
import {
  getPlannedSupplementChanges,
  getTermsChanges,
  lockPayrollEmployee,
  setPlannedSupplement,
  type IPlannedSupplementValue,
} from './payroll-terms.service.js';
import { payrollTermsController } from '../../controllers/payroll-terms.controller.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../docs/migrations/', import.meta.url));
const migration = (name: string): string => readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf8');

const AUTHOR = '00000000-0000-0000-0000-00000000000b';
const NOV_DEC: IPlannedSupplementValue = { amount: 10000, dateFrom: '2026-11-01', dateTo: '2026-12-31' };

/** Сохранение доплаты так же, как в контроллере: транзакция под блокировкой сотрудника. */
const save = (employeeId: number, value: IPlannedSupplementValue | null): Promise<boolean> =>
  withTransaction(async client => {
    await lockPayrollEmployee(client, employeeId);
    return setPlannedSupplement(client, { employeeId, value, createdBy: AUTHOR });
  });

const versions = async (employeeId: number) => (await pg.pool!.query(
  `SELECT amount::text AS amount, date_from, date_to
     FROM payroll_planned_supplements WHERE employee_id = $1 ORDER BY id`,
  [employeeId],
)).rows;

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: any };
};

describe.skipIf(!PG_URL)('плановая доплата на PostgreSQL', () => {
  beforeAll(async () => {
    await pg.pool!.query(`
      DROP TABLE IF EXISTS payroll_paid_amounts, payroll_planned_supplements, payroll_settings, payroll_item_types,
        payroll_compensation_terms, payroll_deduction_kinds, employee_schedule_assignments, work_schedules, positions,
        user_profiles, employees, org_departments CASCADE;
      DROP FUNCTION IF EXISTS public.get_descendant_department_ids(uuid[]);
      CREATE TABLE org_departments (id uuid PRIMARY KEY, name text);
      CREATE TABLE positions (id uuid PRIMARY KEY, name text);
      CREATE TABLE employees (
        id integer PRIMARY KEY,
        full_name text,
        tab_number text,
        org_department_id uuid REFERENCES org_departments(id),
        position_id uuid REFERENCES positions(id),
        employment_status text NOT NULL DEFAULT 'active',
        is_archived boolean NOT NULL DEFAULT false
      );
      CREATE TABLE user_profiles (id uuid PRIMARY KEY, full_name text);
      CREATE TABLE work_schedules (id serial PRIMARY KEY, name text, is_default boolean NOT NULL DEFAULT false);
      CREATE TABLE employee_schedule_assignments (
        id serial PRIMARY KEY,
        employee_id integer NOT NULL REFERENCES employees(id),
        schedule_id integer REFERENCES work_schedules(id),
        effective_from date NOT NULL,
        effective_to date
      );
      -- Список зовёт функцию только при фильтре подразделения или корне подрядчиков — здесь их нет.
      CREATE FUNCTION public.get_descendant_department_ids(uuid[]) RETURNS TABLE(id uuid)
        LANGUAGE sql AS $$ SELECT unnest($1) $$;
      INSERT INTO employees (id, full_name) VALUES
        (1, 'Акимов С.Ю.'), (2, 'Борисов А.А.'), (3, 'Васильев В.В.'), (4, 'Григорьев Г.Г.');
      INSERT INTO user_profiles (id, full_name) VALUES ('${AUTHOR}', 'Петрова А.А.');
    `);
    await pg.pool!.query(migration('271_payroll_terms.sql'));
    await pg.pool!.query(migration('282_payroll_terms_bonus_housing.sql'));
    await pg.pool!.query(migration('286_payroll_terms_compensations.sql'));
    await pg.pool!.query(migration('293_payroll_planned_supplements.sql'));
    // Повторный запуск безопасен.
    await pg.pool!.query(migration('293_payroll_planned_supplements.sql'));
    // Список берёт «Начисления» из «Оплачено».
    await pg.pool!.query(migration('295_payroll_paid_amounts.sql'));
    await pg.pool!.query(migration('297_payroll_paid_groups.sql'));
    await pg.pool!.query(migration('298_payroll_paid_drop_payouts.sql'));
    // Список читает вид удержания.
    await pg.pool!.query(migration('299_payroll_deduction_kinds.sql'));
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('журнал версий: повтор без правки и снятие без доплаты ничего не пишут', async () => {
    expect(await save(1, null)).toBe(false);
    expect(await versions(1)).toEqual([]);

    expect(await save(1, NOV_DEC)).toBe(true);
    // Повторное сохранение карточки без правки — та же сумма (числом) и те же даты.
    expect(await save(1, { ...NOV_DEC })).toBe(false);
    expect(await save(1, { ...NOV_DEC, amount: 12000 })).toBe(true);
    expect(await save(1, { ...NOV_DEC, amount: 12000, dateTo: '2027-01-31' })).toBe(true);
    expect(await save(1, null)).toBe(true);
    expect(await save(1, null)).toBe(false);
    expect(await save(1, NOV_DEC)).toBe(true);

    expect(await versions(1)).toEqual([
      { amount: '10000.00', date_from: '2026-11-01', date_to: '2026-12-31' },
      { amount: '12000.00', date_from: '2026-11-01', date_to: '2026-12-31' },
      { amount: '12000.00', date_from: '2026-11-01', date_to: '2027-01-31' },
      { amount: null, date_from: null, date_to: null },
      { amount: '10000.00', date_from: '2026-11-01', date_to: '2026-12-31' },
    ]);
  });

  it('история: действие и прежние значения, новые сверху, автор по ФИО', async () => {
    const changes = await getPlannedSupplementChanges(1);

    expect(changes.map(c => ({
      action: c.action, amount: c.amount, from: c.date_from, to: c.date_to,
      prev: c.prev_amount, prevFrom: c.prev_date_from, prevTo: c.prev_date_to, by: c.changed_by_name,
    }))).toEqual([
      { action: 'assigned', amount: '10000.00', from: '2026-11-01', to: '2026-12-31', prev: null, prevFrom: null, prevTo: null, by: 'Петрова А.А.' },
      { action: 'removed', amount: null, from: null, to: null, prev: '12000.00', prevFrom: '2026-11-01', prevTo: '2027-01-31', by: 'Петрова А.А.' },
      { action: 'changed', amount: '12000.00', from: '2026-11-01', to: '2027-01-31', prev: '12000.00', prevFrom: '2026-11-01', prevTo: '2026-12-31', by: 'Петрова А.А.' },
      { action: 'changed', amount: '12000.00', from: '2026-11-01', to: '2026-12-31', prev: '10000.00', prevFrom: '2026-11-01', prevTo: '2026-12-31', by: 'Петрова А.А.' },
      { action: 'assigned', amount: '10000.00', from: '2026-11-01', to: '2026-12-31', prev: null, prevFrom: null, prevTo: null, by: 'Петрова А.А.' },
    ]);
  });

  it('два параллельных сохранения одной доплаты дают одну версию', async () => {
    const results = await Promise.all([save(2, NOV_DEC), save(2, NOV_DEC), save(2, NOV_DEC)]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await versions(2)).toHaveLength(1);
  });

  it('недопустимое состояние отвергает сама БД', async () => {
    await expect(pg.pool!.query(
      `INSERT INTO payroll_planned_supplements (employee_id, amount, date_from, date_to)
       VALUES (3, 1000, '2026-12-01', '2026-11-01')`,
    )).rejects.toThrow(/payroll_supplement_state/);
    await expect(pg.pool!.query(
      `INSERT INTO payroll_planned_supplements (employee_id, amount, date_from, date_to)
       VALUES (3, 1000, '2026-12-01', NULL)`,
    )).rejects.toThrow(/payroll_supplement_state/);
  });

  it('общий журнал: оклад и доплата по времени изменения, новые сверху', async () => {
    await pg.pool!.query(
      `INSERT INTO payroll_compensation_terms
         (employee_id, staff_category, calc_type, monthly_salary, effective_from, effective_to, created_by, created_at)
       VALUES (3, 'itr', 'salary', 100000, '2026-01-01', '2026-09-30', '${AUTHOR}', '2026-01-10T09:00:00Z'),
              (3, 'itr', 'salary', 120000, '2026-10-01', NULL, '${AUTHOR}', '2026-09-20T09:00:00Z')`,
    );
    await save(3, NOV_DEC);
    await pg.pool!.query(
      `UPDATE payroll_planned_supplements SET created_at = '2026-05-01T09:00:00Z' WHERE employee_id = 3`,
    );

    const changes = await getTermsChanges(3);

    expect(changes.map(c => (c.kind === 'salary' ? `salary ${c.amount}` : `supplement ${c.amount}`))).toEqual([
      'salary 120000.00',
      'supplement 10000.00',
      'salary 100000.00',
    ]);
  });

  it('список: последняя сохранённая доплата у своих строк — будущая, прошедшая и снятая', async () => {
    // 1 — снята и назначена заново (Nov–Dec), 2 — Nov–Dec, 3 — Nov–Dec; 4 — кончилась в прошлом году.
    await save(4, { amount: 5000, dateFrom: '2025-01-01', dateTo: '2025-03-31' });
    const res = makeRes();

    await payrollTermsController.list({
      user: { id: AUTHOR }, params: {}, body: {}, query: { date: '2026-10-01' },
    } as unknown as AuthenticatedRequest, res);

    expect(res.statusCode).toBe(200);
    const byId = Object.fromEntries((res.body.data as Array<Record<string, unknown>>).map(row => [
      row.employee_id,
      [row.planned_supplement_amount, row.planned_supplement_from, row.planned_supplement_to],
    ]));
    expect(byId).toEqual({
      1: [10000, '2026-11-01', '2026-12-31'],
      2: [10000, '2026-11-01', '2026-12-31'],
      3: [10000, '2026-11-01', '2026-12-31'],
      4: [5000, '2025-01-01', '2025-03-31'],
    });
  });

  it('список: доплата снята — поля пустые', async () => {
    await save(2, null);
    const res = makeRes();

    await payrollTermsController.list({
      user: { id: AUTHOR }, params: {}, body: {}, query: { date: '2026-10-01' },
    } as unknown as AuthenticatedRequest, res);

    const row = (res.body.data as Array<Record<string, unknown>>).find(r => r.employee_id === 2);
    expect(row).toMatchObject({
      planned_supplement_amount: null, planned_supplement_from: null, planned_supplement_to: null,
    });
  });

  it('список: «Начисления» — итог «Начислено» из «Оплачено» за 6 закрытых месяцев перед датой', async () => {
    await pg.pool!.query(`
      INSERT INTO payroll_paid_amounts (employee_id, month, item_code, amount) VALUES
        (1, '2026-08-01', 'contract',      68095),
        (1, '2026-08-01', 'vacation',      59245),
        (1, '2026-08-01', 'travel',         1430),
        (1, '2026-08-01', 'meals',          5248),     -- удержание — не начисление
        (1, '2026-07-01', 'recalc_prev',   -1500),     -- сторно — минусом
        (1, '2026-03-01', 'contract',     100000),     -- до окна апр – сен
        (1, '2026-10-01', 'contract',     100000),     -- текущий месяц — не закрыт
        (3, '2026-09-01', 'workwear',      50000);     -- только удержание
    `);
    const res = makeRes();

    await payrollTermsController.list({
      user: { id: AUTHOR }, params: {}, body: {}, query: { date: '2026-10-01' },
    } as unknown as AuthenticatedRequest, res);

    const byId = Object.fromEntries((res.body.data as Array<Record<string, unknown>>).map(row => [row.employee_id, row.accruals]));
    expect(byId[1]).toEqual([{ month: '2026-07', amount: -1500 }, { month: '2026-08', amount: 128770 }]);
    expect(byId[2]).toBeNull();
    expect(byId[3]).toBeNull();
  });
});
