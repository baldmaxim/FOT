import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../types/index.js';

// Справочник видов удержаний (миграция 299) и виды сотрудника (миграция 300) на настоящем
// PostgreSQL: засев и повторный запуск, уникальность названия, несколько видов у сотрудника,
// удаление вида из условий оплаты, выборка «Расчётов».
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы пересоздаются).

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
  addDeductionKind,
  getEmployeeDeductionKindIds,
  listDeductionKinds,
  setEmployeeDeductionKinds,
} from './payroll-deduction-kinds.service.js';
import { payrollTermsController } from '../../controllers/payroll-terms.controller.js';
import { payrollDeductionsController } from '../../controllers/payroll-deductions.controller.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../docs/migrations/', import.meta.url));
const migration = (name: string): string => readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf8');

const AUTHOR = '00000000-0000-0000-0000-00000000000c';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: any };
};

const assign = async (employeeId: number, extra: Record<string, unknown>) => {
  const res = makeRes();
  await payrollTermsController.assign({
    user: { id: AUTHOR },
    params: { empId: String(employeeId) },
    query: {},
    body: { staff_category: 'worker', calc_type: 'hourly', hourly_rate: 450, effective_from: '2026-10-01', ...extra },
  } as unknown as AuthenticatedRequest, res);
  return res;
};

describe.skipIf(!PG_URL)('виды удержаний на PostgreSQL', () => {
  beforeAll(async () => {
    await pg.pool!.query(`
      DROP TABLE IF EXISTS payroll_paid_amounts, payroll_planned_supplements, payroll_settings, payroll_item_types,
        payroll_compensation_terms, payroll_employee_deductions, payroll_deduction_kinds, employee_schedule_assignments, work_schedules, positions,
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
      CREATE FUNCTION public.get_descendant_department_ids(uuid[]) RETURNS TABLE(id uuid)
        LANGUAGE sql AS $$ SELECT unnest($1) $$;
      INSERT INTO employees (id, full_name) VALUES (1, 'Акимов С.Ю.'), (2, 'Борисов А.А.'), (3, 'Васильев В.В.');
      INSERT INTO user_profiles (id, full_name) VALUES ('${AUTHOR}', 'Петрова А.А.');
    `);
    await pg.pool!.query(migration('271_payroll_terms.sql'));
    await pg.pool!.query(migration('282_payroll_terms_bonus_housing.sql'));
    await pg.pool!.query(migration('286_payroll_terms_compensations.sql'));
    await pg.pool!.query(migration('293_payroll_planned_supplements.sql'));
    await pg.pool!.query(migration('295_payroll_paid_amounts.sql'));
    await pg.pool!.query(migration('299_payroll_deduction_kinds.sql'));
    await pg.pool!.query(migration('300_payroll_employee_deductions.sql'));
    await pg.pool!.query(migration('301_payroll_paid_order_kinds.sql'));
    // Повторный запуск безопасен: виды не задваиваются.
    await pg.pool!.query(migration('299_payroll_deduction_kinds.sql'));
    await pg.pool!.query(migration('300_payroll_employee_deductions.sql'));
    await pg.pool!.query(migration('301_payroll_paid_order_kinds.sql'));
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('засев — 6 видов (299) и удержания «Оплачено» (301) по порядку, повтор миграций их не задваивает', async () => {
    expect((await listDeductionKinds()).map(kind => kind.name)).toEqual([
      'Корректировка удержаний', 'ТМЦ', 'Штраф за мусор', 'Спецодежда', 'Питание', 'Штрафы',
      'Нарушение техники безопасности', 'Удержание по исп. листу',
    ]);
  });

  it('новый вид — в конец; то же название без учёта регистра и пробелов — дубль', async () => {
    const added = await addDeductionKind('Штраф за опоздание');
    expect(added?.name).toBe('Штраф за опоздание');
    expect(await addDeductionKind('штраф за ОПОЗДАНИЕ')).toBeNull();
    expect(await addDeductionKind(' Штрафы ')).toBeNull();
    const kinds = await listDeductionKinds();
    expect(kinds).toHaveLength(9);
    expect(kinds[8]).toEqual(added);
  });

  it('300: CHECK «вид и сумма вместе» снят — сумма удержания сохраняется без вида', async () => {
    expect((await assign(3, { deduction_amount: 100 })).statusCode).toBe(200);
    const saved = await pg.pool!.query(
      `SELECT deduction_amount::text AS amount FROM payroll_compensation_terms WHERE employee_id = 3`,
    );
    expect(saved.rows).toEqual([{ amount: '100.00' }]);
  });

  it('несколько видов у сотрудника: замена набора, порядок справочника, неизвестный вид — FK', async () => {
    const byName = Object.fromEntries((await listDeductionKinds()).map(kind => [kind.name, kind.id]));
    const save = (employeeId: number, ids: number[]) =>
      withTransaction(client => setEmployeeDeductionKinds(client, employeeId, ids));

    expect(await save(1, [byName['Штрафы'], byName['Питание'], byName['Питание']]))
      .toEqual({ added: expect.arrayContaining([byName['Штрафы'], byName['Питание']]), removed: [] });
    expect(await getEmployeeDeductionKindIds(1)).toEqual([byName['Питание'], byName['Штрафы']]);

    expect(await save(1, [byName['Питание'], byName['ТМЦ']])).toEqual({ added: [byName['ТМЦ']], removed: [byName['Штрафы']] });
    expect(await save(1, [byName['Питание'], byName['ТМЦ']])).toEqual({ added: [], removed: [] });
    expect(await getEmployeeDeductionKindIds(1)).toEqual([byName['ТМЦ'], byName['Питание']]);

    await expect(save(2, [9999])).rejects.toThrow(/foreign key/);
    // Отмеченный вид не удалить из справочника.
    await expect(pg.pool!.query(`DELETE FROM payroll_deduction_kinds WHERE id = $1`, [byName['ТМЦ']]))
      .rejects.toThrow(/foreign key/);
  });

  it('«Расчёты» — сотрудники хотя бы с одним из выбранных видов', async () => {
    expect((await assign(1, {})).statusCode).toBe(200);
    const byName = Object.fromEntries((await listDeductionKinds()).map(kind => [kind.name, kind.id]));
    await withTransaction(client => setEmployeeDeductionKinds(client, 3, [byName['Штрафы']]));

    const list = async (kindIds: number[]) => {
      const res = makeRes();
      await payrollDeductionsController.list({
        user: { id: AUTHOR }, params: {}, body: {}, query: { date: '2026-10-06', kind_ids: kindIds.join(',') },
      } as unknown as AuthenticatedRequest, res);
      expect(res.statusCode).toBe(200);
      return res.body.data as Array<{ employee_id: number }>;
    };

    // У Акимова (1) — ТМЦ и Питание, у Васильева (3) — Штрафы, у Борисова (2) — ничего.
    expect((await list([byName['Питание']])).map(row => row.employee_id)).toEqual([1]);
    expect((await list([byName['Питание'], byName['Штрафы']])).map(row => row.employee_id)).toEqual([1, 3]);
    expect(await list([byName['Спецодежда']])).toEqual([]);
    expect((await list([byName['ТМЦ']]))[0]).toMatchObject({ full_name: 'Акимов С.Ю.', calc_type: 'hourly', can_edit: true });
  });
});
