import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// «Общежитие» (миграция 314) и ставка «Проживание общежития» с кодом (миграция 313) на настоящем
// PostgreSQL: чистая БД и БД с уже заведённой ставкой, повторный запуск, пересечение периодов,
// въезд в день выезда, сервис общежития и запрет удалить/переименовать ставку с кодом.
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

import { addStay, deleteStay, listStays, searchCandidates, updateStay } from './dormitory-stays.service.js';
import { deleteRate, listRates, updateRate } from './payroll/payroll-rates.service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../docs/migrations/', import.meta.url));
const migration = (name: string): string => readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf8');
const run = (sql: string) => pg.pool!.query(sql);

const D1 = '00000000-0000-0000-0000-0000000000d1';
const D2 = '00000000-0000-0000-0000-0000000000d2';

describe.skipIf(!PG_URL)('общежитие и ставка с кодом на PostgreSQL', () => {
  beforeAll(async () => {
    await run(`
      DROP TABLE IF EXISTS employee_dormitory_stays, payroll_rates, role_page_access, access_pages,
        employees, positions, org_departments CASCADE;
      CREATE TABLE org_departments (id uuid PRIMARY KEY, name text);
      CREATE TABLE positions (id uuid PRIMARY KEY, name text);
      CREATE TABLE employees (
        id integer PRIMARY KEY,
        full_name text,
        org_department_id uuid REFERENCES org_departments(id),
        position_id uuid REFERENCES positions(id),
        employment_status text NOT NULL DEFAULT 'active',
        is_archived boolean NOT NULL DEFAULT false
      );
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
      INSERT INTO org_departments (id, name) VALUES ('${D1}', 'бр.Менгбоев Г.И.'), ('${D2}', 'Архив');
      INSERT INTO positions (id, name) VALUES ('00000000-0000-0000-0000-0000000000a1', 'Монтажник');
      INSERT INTO employees (id, full_name, org_department_id, position_id, employment_status, is_archived) VALUES
        (1, 'Каримов Акмал', '${D1}', '00000000-0000-0000-0000-0000000000a1', 'active', false),
        (2, 'Борисов Антон', '${D1}', NULL, 'active', false),
        (3, 'Карпов Уволенный', '${D2}', NULL, 'dismissed', false),
        (4, 'Карасёв Архивный', '${D1}', NULL, 'active', true);
    `);
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('313 на чистой БД — ставка «Проживание общежития» без значения; повтор не задваивает', async () => {
    await run(migration('306_payroll_rates.sql'));
    await run(migration('313_payroll_rate_code.sql'));
    await run(migration('313_payroll_rate_code.sql'));
    expect(await listRates()).toEqual([
      { id: expect.any(Number), name: 'Проживание общежития', amount: null, code: 'dormitory' },
    ]);
  });

  it('313 на БД со ставкой — код проставлен той же строке, название и значение не тронуты', async () => {
    await run(`DROP TABLE payroll_rates`);
    await run(migration('306_payroll_rates.sql'));
    await run(`INSERT INTO payroll_rates (name, amount) VALUES ('Сварщик', 520), (' Проживание ОБЩЕЖИТИЯ ', 630)`);
    const [{ id: dormitoryId }] = (await run(`SELECT id FROM payroll_rates WHERE amount = 630`)).rows;
    await run(migration('313_payroll_rate_code.sql'));
    await run(migration('313_payroll_rate_code.sql'));

    expect(await listRates()).toEqual([
      { id: expect.any(Number), name: 'Сварщик', amount: '520.00', code: null },
      { id: dormitoryId, name: ' Проживание ОБЩЕЖИТИЯ ', amount: '630.00', code: 'dormitory' },
    ]);
  });

  it('ставку с кодом не удалить и не переименовать, значение меняется', async () => {
    const dormitory = (await listRates()).find(rate => rate.code === 'dormitory')!;
    expect(await deleteRate(dormitory.id)).toBe('system');
    expect(await updateRate(dormitory.id, 'Общежитие', 630)).toBe('system_name');
    // Контроллер схлопывает пробелы: « Проживание ОБЩЕЖИТИЯ » приходит без них — это не переименование,
    // и в БД название остаётся как было.
    expect(await updateRate(dormitory.id, 'Проживание ОБЩЕЖИТИЯ', 700)).toMatchObject({
      before: { amount: '630.00' }, after: { name: ' Проживание ОБЩЕЖИТИЯ ', amount: '700.00', code: 'dormitory' },
    });
    expect((await listRates()).find(rate => rate.id === dormitory.id)).toMatchObject({ name: dormitory.name, amount: '700.00' });
    // Обычная ставка — как раньше.
    const welder = (await listRates()).find(rate => rate.code === null)!;
    expect(await deleteRate(welder.id)).toMatchObject({ name: 'Сварщик', code: null });
  });

  it('314: таблица, право admin и hr_admin; повтор безопасен', async () => {
    await run(migration('314_employee_dormitory_stays.sql'));
    await run(migration('314_employee_dormitory_stays.sql'));
    expect((await run(`SELECT key, surface, supports_edit FROM access_pages`)).rows).toEqual([
      { key: '/staff-control/dormitory', surface: 'technical', supports_edit: true },
    ]);
    expect((await run(`SELECT role_code, can_view, can_edit FROM role_page_access ORDER BY role_code`)).rows).toEqual([
      { role_code: 'admin', can_view: true, can_edit: true },
      { role_code: 'hr_admin', can_view: true, can_edit: true },
    ]);
  });

  it('периоды не пересекаются; въезд в день выезда — можно; выезд = въезд — нельзя', async () => {
    const first = await addStay(1, { check_in: '2026-09-01', check_out: '2026-10-10', address: 'Общежитие №2, комн. 14' });
    expect(first).toMatchObject({
      employee_id: 1, full_name: 'Каримов Акмал', department: 'бр.Менгбоев Г.И.', position: 'Монтажник',
      check_in: '2026-09-01', check_out: '2026-10-10',
    });
    // Переселение: выезд 10-го и въезд 10-го.
    const second = await addStay(1, { check_in: '2026-10-10', check_out: null, address: 'Общежитие №3' });
    expect(second).toMatchObject({ check_in: '2026-10-10', check_out: null });
    // Открытое проживание пересекается с любым будущим.
    expect(await addStay(1, { check_in: '2027-01-01', check_out: null, address: 'Общежитие №4' })).toBe('overlap');
    expect(await addStay(1, { check_in: '2026-09-15', check_out: '2026-09-20', address: 'Внутри' })).toBe('overlap');
    // У другого сотрудника те же даты — можно.
    expect(await addStay(2, { check_in: '2026-09-15', check_out: '2026-09-20', address: 'Общежитие №2' })).toMatchObject({ employee_id: 2 });

    await expect(run(`INSERT INTO employee_dormitory_stays (employee_id, check_in, check_out, address)
                      VALUES (2, '2026-12-01', '2026-12-01', 'Пусто')`)).rejects.toThrow(/employee_dormitory_stay_dates/);
    await expect(run(`INSERT INTO employee_dormitory_stays (employee_id, check_in, address)
                      VALUES (2, '2027-01-01', '   ')`)).rejects.toThrow(/employee_dormitory_stay_address/);
  });

  it('правка: дата выезда, пересечение; удаление; список по охвату', async () => {
    const stays = await listStays({});
    expect(stays.map(stay => [stay.full_name, stay.check_in])).toEqual([
      ['Борисов Антон', '2026-09-15'],
      ['Каримов Акмал', '2026-09-01'],
      ['Каримов Акмал', '2026-10-10'],
    ]);
    const open = stays[2];

    const closed = await updateStay(open.id, { check_in: open.check_in, check_out: '2026-11-30', address: open.address });
    expect(closed).toMatchObject({ before: { check_out: null }, after: { check_out: '2026-11-30' } });
    expect(await updateStay(open.id, { check_in: '2026-09-05', check_out: '2026-11-30', address: open.address })).toBe('overlap');
    expect(await updateStay(9999, { check_in: '2026-09-05', check_out: null, address: 'x' })).toBeNull();

    expect((await listStays({ employeeIds: [2] })).map(stay => stay.employee_id)).toEqual([2]);
    expect(await listStays({ employeeIds: [] })).toEqual([]);
    expect((await listStays({ departmentIds: [D2] }))).toEqual([]);
    expect((await listStays({ departmentIds: [D1] }))).toHaveLength(3);

    expect(await deleteStay(open.id)).toMatchObject({ id: open.id, check_out: '2026-11-30' });
    expect(await deleteStay(open.id)).toBeNull();
    expect(await listStays({})).toHaveLength(2);
  });

  it('поиск: только работающие и не в архиве, в охвате', async () => {
    expect((await searchCandidates('Кар', null)).map(row => row.full_name)).toEqual(['Каримов Акмал']);
    expect(await searchCandidates('Кар', [2])).toEqual([]);
    expect(await searchCandidates('Кар', [])).toEqual([]);
    expect((await searchCandidates('_', null))).toEqual([]);
  });
});
