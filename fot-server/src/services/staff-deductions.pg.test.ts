import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// «Удержания» кадров и переименование «Общежития» в «Проживание» (миграция 318) на настоящем PostgreSQL:
// повторный запуск, права, CHECK месяца и суммы, сумма по умолчанию у вида, вид не удалить, пока он
// назначен в кадрах или отмечен в «Зарплате», сервис удержаний.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы пересоздаются).

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../config/postgres.js', async () => {
  const { Pool, types } = await import('pg');
  types.setTypeParser(1082, (val: string) => val);
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

import { addDeduction, deleteDeduction, getDeduction, listDeductions, updateDeduction } from './staff-deductions.service.js';
import {
  addDeductionKindWithDefault,
  deleteDeductionKind,
  listDeductionKinds,
  listDeductionKindsWithDefaults,
  updateDeductionKind,
} from './payroll/payroll-deduction-kinds.service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../docs/migrations/', import.meta.url));
const migration = (name: string): string => readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf8');
const run = (sql: string) => pg.pool!.query(sql);

const D1 = '00000000-0000-0000-0000-0000000000d1';

describe.skipIf(!PG_URL)('«Удержания» кадров на PostgreSQL', () => {
  const kindId = async (name: string): Promise<number> =>
    (await listDeductionKinds()).find(kind => kind.name === name)!.id;

  beforeAll(async () => {
    await run(`
      DROP TABLE IF EXISTS staff_deductions, payroll_employee_deductions, payroll_deduction_kinds,
        payroll_compensation_terms, employee_dormitory_stays, role_page_access, access_pages,
        employees, positions, org_departments CASCADE;
      CREATE TABLE org_departments (id uuid PRIMARY KEY, name text, parent_id uuid);
      CREATE TABLE positions (id uuid PRIMARY KEY, name text);
      CREATE TABLE employees (
        id integer PRIMARY KEY,
        full_name text,
        org_department_id uuid REFERENCES org_departments(id),
        position_id uuid REFERENCES positions(id),
        employment_status text NOT NULL DEFAULT 'active',
        is_archived boolean NOT NULL DEFAULT false
      );
      -- 299/300 трогают условия оплаты: здесь достаточно столбца суммы удержания.
      CREATE TABLE payroll_compensation_terms (id serial PRIMARY KEY, deduction_amount numeric(12,2));
      -- Права: столбцы и ключи — как на проде.
      CREATE TABLE access_pages (
        key text PRIMARY KEY, label text NOT NULL, group_code text NOT NULL, group_label text NOT NULL,
        surface text NOT NULL, supports_edit boolean NOT NULL DEFAULT true,
        requires_data_scope boolean NOT NULL DEFAULT false, requires_employee_variant boolean NOT NULL DEFAULT false,
        sort_order integer NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true, is_system boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        area text NOT NULL DEFAULT 'admin'
      );
      CREATE TABLE role_page_access (
        id serial PRIMARY KEY, role_code text, page_path text NOT NULL, can_view boolean, can_edit boolean,
        UNIQUE (role_code, page_path)
      );
      INSERT INTO org_departments (id, name) VALUES ('${D1}', 'бр.Менгбоев Г.И.');
      INSERT INTO positions (id, name) VALUES ('00000000-0000-0000-0000-0000000000a1', 'Монтажник');
      INSERT INTO employees (id, full_name, org_department_id, position_id) VALUES
        (1, 'Каримов Акмал', '${D1}', '00000000-0000-0000-0000-0000000000a1'),
        (2, 'Борисов Антон', '${D1}', NULL),
        (3, 'Васильев Виктор', NULL, NULL);
    `);
    await run(migration('299_payroll_deduction_kinds.sql'));
    await run(migration('300_payroll_employee_deductions.sql'));
    await run(migration('314_employee_dormitory_stays.sql'));
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('318: «Общежитие» → «Проживание», право «Удержания» у admin и hr_admin; повтор безопасен', async () => {
    await run(migration('318_staff_deductions.sql'));
    await run(migration('318_staff_deductions.sql'));
    expect((await run(`SELECT key, label, surface, supports_edit FROM access_pages ORDER BY key`)).rows).toEqual([
      { key: '/staff-control/deductions', label: 'Управление кадрами — Удержания', surface: 'technical', supports_edit: true },
      { key: '/staff-control/dormitory', label: 'Управление кадрами — Проживание', surface: 'technical', supports_edit: true },
    ]);
    expect((await run(`SELECT role_code, can_view, can_edit FROM role_page_access
                        WHERE page_path = '/staff-control/deductions' ORDER BY role_code`)).rows).toEqual([
      { role_code: 'admin', can_view: true, can_edit: true },
      { role_code: 'hr_admin', can_view: true, can_edit: true },
    ]);
  });

  it('виды: сумма по умолчанию — у новых и прежних, правка, 0 не принимается', async () => {
    expect((await listDeductionKindsWithDefaults()).slice(0, 2)).toEqual([
      { id: expect.any(Number), name: 'Корректировка удержаний', default_amount: null },
      { id: expect.any(Number), name: 'ТМЦ', default_amount: null },
    ]);
    const added = await addDeductionKindWithDefault('Штраф за опоздание', 1500.5);
    expect(added).toEqual({ id: expect.any(Number), name: 'Штраф за опоздание', default_amount: '1500.50' });
    expect(await addDeductionKindWithDefault(' штраф за ОПОЗДАНИЕ', null)).toBeNull();
    expect((await listDeductionKindsWithDefaults()).at(-1)).toEqual(added);

    const garbage = await kindId('Штраф за мусор');
    expect(await updateDeductionKind(garbage, 'Штраф за мусор', 5000)).toEqual({
      before: { id: garbage, name: 'Штраф за мусор', default_amount: null },
      after: { id: garbage, name: 'Штраф за мусор', default_amount: '5000.00' },
    });
    expect(await updateDeductionKind(garbage, 'ТМЦ', 5000)).toBe('duplicate');
    expect(await updateDeductionKind(9999, 'Нет такого', null)).toBeNull();
    // «Зарплата» видит тот же справочник — без суммы, как раньше.
    expect((await listDeductionKinds()).find(kind => kind.id === garbage)).toEqual({ id: garbage, name: 'Штраф за мусор' });

    await expect(run(`UPDATE payroll_deduction_kinds SET default_amount = 0 WHERE id = ${garbage}`))
      .rejects.toThrow(/payroll_deduction_kind_default_amount/);
  });

  it('удержания: повтор в том же месяце — новой строкой, правка, удаление, список по охвату', async () => {
    const garbage = await kindId('Штраф за мусор');
    const meals = await kindId('Питание');
    const first = await addDeduction(1, { kind_id: garbage, month: '2026-10', amount: 5000 });
    expect(first).toEqual({
      id: expect.any(Number), employee_id: 1, full_name: 'Каримов Акмал', department: 'бр.Менгбоев Г.И.',
      position: 'Монтажник', kind_id: garbage, kind_name: 'Штраф за мусор', month: '2026-10', amount: '5000.00',
    });
    const again = await addDeduction(1, { kind_id: garbage, month: '2026-10', amount: 2500 });
    expect(again).toMatchObject({ month: '2026-10', amount: '2500.00' });
    const other = await addDeduction(2, { kind_id: meals, month: '2026-09', amount: 1200 });
    expect(await addDeduction(2, { kind_id: 9999, month: '2026-09', amount: 1 })).toBe('kind_missing');

    expect((await listDeductions({ employeeIds: null })).map(row => [row.full_name, row.month, row.amount])).toEqual([
      ['Борисов Антон', '2026-09', '1200.00'],
      ['Каримов Акмал', '2026-10', '5000.00'],
      ['Каримов Акмал', '2026-10', '2500.00'],
    ]);
    expect((await listDeductions({ employeeIds: [2] })).map(row => row.employee_id)).toEqual([2]);
    expect(await listDeductions({ employeeIds: [] })).toEqual([]);

    if (typeof again === 'string' || typeof other === 'string') throw new Error('не добавлено');
    expect(await updateDeduction(again.id, { kind_id: meals, month: '2026-11', amount: 300 })).toMatchObject({
      before: { kind_name: 'Штраф за мусор', month: '2026-10', amount: '2500.00' },
      after: { kind_name: 'Питание', month: '2026-11', amount: '300.00' },
    });
    expect(await updateDeduction(again.id, { kind_id: 9999, month: '2026-11', amount: 300 })).toBe('kind_missing');
    expect(await getDeduction(again.id)).toMatchObject({ kind_id: meals });
    expect(await updateDeduction(9999, { kind_id: meals, month: '2026-11', amount: 300 })).toBeNull();

    expect(await deleteDeduction(other.id)).toMatchObject({ id: other.id, employee_id: 2 });
    expect(await deleteDeduction(other.id)).toBeNull();

    await expect(run(`INSERT INTO staff_deductions (employee_id, kind_id, month, amount) VALUES (1, ${meals}, '2026-10-15', 10)`))
      .rejects.toThrow(/staff_deduction_month/);
    await expect(run(`INSERT INTO staff_deductions (employee_id, kind_id, month, amount) VALUES (1, ${meals}, '2026-10-01', 0)`))
      .rejects.toThrow(/staff_deduction_amount/);
  });

  it('вид не удалить, пока он назначен в кадрах или отмечен в «Зарплате»: число — разных сотрудников', async () => {
    const meals = await kindId('Питание');
    const garbage = await kindId('Штраф за мусор');
    // «Питание»: у Каримова в кадрах (после правки выше) и у Каримова и Васильева в «Зарплате».
    await run(`INSERT INTO payroll_employee_deductions (employee_id, kind_id) VALUES (1, ${meals}), (3, ${meals})`);
    expect(await deleteDeductionKind(meals)).toEqual({ inUse: 2 });
    // «Штраф за мусор» — только в кадрах, у Каримова.
    expect(await deleteDeductionKind(garbage)).toEqual({ inUse: 1 });

    await run(`DELETE FROM staff_deductions WHERE kind_id = ${garbage}`);
    expect(await deleteDeductionKind(garbage)).toEqual({ id: garbage, name: 'Штраф за мусор' });
  });
});
