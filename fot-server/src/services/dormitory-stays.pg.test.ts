import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// «Общежитие» (миграция 314) и ставка «Проживание общежития» с кодом (миграция 313) на настоящем
// PostgreSQL: чистая БД и БД с уже заведённой ставкой, повторный запуск, пересечение периодов,
// въезд в день выезда, сервис общежития и запрет удалить/переименовать ставку с кодом.
// Сохранённые адреса (миграция 319): перенос из проживаний, запоминание при записи, удаление их не трогает.
// Квартира (миграция 320): вид, сумма, адрес по желанию; в один день — одно место.
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

const CONTRACTORS = '00000000-0000-0000-0000-0000000000c0';
vi.mock('../config/contractor.js', () => ({
  CONTRACTOR_ROOT_NAME: 'подрядные организации',
  getContractorRootId: async () => CONTRACTORS,
}));

import {
  addStay, deleteStay, getEmployeeState, listAddresses, listStays, searchCandidates, updateStay,
} from './dormitory-stays.service.js';
import { currentRateMonth, deleteRate, listRates, updateRate } from './payroll/payroll-rates.service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../docs/migrations/', import.meta.url));
const migration = (name: string): string => readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf8');
const run = (sql: string) => pg.pool!.query(sql);

const D1 = '00000000-0000-0000-0000-0000000000d1';
const D2 = '00000000-0000-0000-0000-0000000000d2';

describe.skipIf(!PG_URL)('общежитие и ставка с кодом на PostgreSQL', () => {
  beforeAll(async () => {
    await run(`
      DROP TABLE IF EXISTS dormitory_addresses, employee_dormitory_stays, payroll_rate_values, payroll_rates,
        role_page_access, access_pages,
        payroll_compensation_terms, payroll_dormitory_allowances, employees, positions, org_departments CASCADE;
      DROP FUNCTION IF EXISTS public.get_descendant_department_ids(uuid[]);
      CREATE TABLE org_departments (id uuid PRIMARY KEY, name text, parent_id uuid);
      CREATE TABLE positions (id uuid PRIMARY KEY, name text);
      -- Для миграции 320 и проверки квартиры: доплата в условиях оплаты и «Доплата за общежитие» (317).
      -- travel_compensation — для комментария миграции 324.
      CREATE TABLE payroll_compensation_terms (
        id serial PRIMARY KEY, employee_id integer, housing_compensation numeric(12,2), travel_compensation numeric(12,2)
      );
      CREATE TABLE payroll_dormitory_allowances (
        id serial PRIMARY KEY, employee_id integer NOT NULL, date_from date NOT NULL, date_to date
      );
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
      CREATE FUNCTION public.get_descendant_department_ids(uuid[]) RETURNS TABLE(id uuid)
        LANGUAGE sql AS $$
          SELECT d.id FROM org_departments d WHERE d.id = ANY($1) OR d.parent_id = ANY($1)
        $$;
      INSERT INTO org_departments (id, name, parent_id) VALUES
        ('${D1}', 'бр.Менгбоев Г.И.', NULL), ('${D2}', 'Архив', NULL),
        ('${CONTRACTORS}', 'Подрядные организации', NULL),
        ('00000000-0000-0000-0000-0000000000c1', 'Смарт ПСК ООО', '${CONTRACTORS}');
      INSERT INTO positions (id, name) VALUES ('00000000-0000-0000-0000-0000000000a1', 'Монтажник');
      INSERT INTO employees (id, full_name, org_department_id, position_id, employment_status, is_archived) VALUES
        (1, 'Каримов Акмал', '${D1}', '00000000-0000-0000-0000-0000000000a1', 'active', false),
        (2, 'Борисов Антон', '${D1}', NULL, 'active', false),
        (3, 'Карпов Уволенный', '${D2}', NULL, 'dismissed', false),
        (4, 'Карасёв Архивный', '${D1}', NULL, 'active', true),
        (5, 'Карпенко Подрядчик', '00000000-0000-0000-0000-0000000000c1', NULL, 'active', false),
        (6, 'Карелин Безотдельный', NULL, NULL, 'active', false);
    `);
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  // Ставки читаются с историей значений (миграция 324) — она идёт следом за 313; «Проезд» (travel) — её ставка.
  const TRAVEL = { id: expect.any(Number), name: 'Проезд', amount: null, code: 'travel', values: [] };

  it('313 на чистой БД — ставка «Проживание общежития» без значения; повтор не задваивает', async () => {
    await run(migration('306_payroll_rates.sql'));
    await run(migration('313_payroll_rate_code.sql'));
    await run(migration('313_payroll_rate_code.sql'));
    await run(migration('324_payroll_rate_values.sql'));
    expect(await listRates()).toEqual([
      TRAVEL,
      { id: expect.any(Number), name: 'Проживание общежития', amount: null, code: 'dormitory', values: [] },
    ]);
  });

  it('313 на БД со ставкой — код проставлен той же строке, название и значение не тронуты', async () => {
    await run(`DROP TABLE payroll_rate_values, payroll_rates`);
    await run(migration('306_payroll_rates.sql'));
    await run(`INSERT INTO payroll_rates (name, amount) VALUES ('Сварщик', 520), (' Проживание ОБЩЕЖИТИЯ ', 630)`);
    const [{ id: dormitoryId }] = (await run(`SELECT id FROM payroll_rates WHERE amount = 630`)).rows;
    await run(migration('313_payroll_rate_code.sql'));
    await run(migration('313_payroll_rate_code.sql'));
    await run(migration('324_payroll_rate_values.sql'));

    expect(await listRates()).toEqual([
      TRAVEL,
      { id: expect.any(Number), name: 'Сварщик', amount: '520.00', code: null,
        values: [{ effective_from: '2000-01', amount: '520.00' }] },
      { id: dormitoryId, name: ' Проживание ОБЩЕЖИТИЯ ', amount: '630.00', code: 'dormitory',
        values: [{ effective_from: '2000-01', amount: '630.00' }] },
    ]);
  });

  it('ставку с кодом не удалить и не переименовать, значение меняется', async () => {
    const dormitory = (await listRates()).find(rate => rate.code === 'dormitory')!;
    const month = currentRateMonth();
    expect(await deleteRate(dormitory.id)).toBe('system');
    expect(await updateRate(dormitory.id, 'Общежитие', 630, month)).toBe('system_name');
    // Контроллер схлопывает пробелы: « Проживание ОБЩЕЖИТИЯ » приходит без них — это не переименование,
    // и в БД название остаётся как было.
    expect(await updateRate(dormitory.id, 'Проживание ОБЩЕЖИТИЯ', 700, month)).toMatchObject({
      before: { amount: '630.00' }, after: { name: ' Проживание ОБЩЕЖИТИЯ ', amount: '700.00', code: 'dormitory' },
      nameChanged: false, value: { effective_month: month, from: '630.00', to: '700.00' },
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

  it('319: адреса прежних проживаний переносятся (регистр — один адрес, первое написание); повтор безопасен', async () => {
    await run(`INSERT INTO employee_dormitory_stays (employee_id, check_in, check_out, address) VALUES
      (6, '2025-01-01', '2025-02-01', 'Общ1'), (6, '2025-03-01', '2025-04-01', 'общ1'), (6, '2025-05-01', '2025-06-01', 'Общ. Свободы 35')`);
    await run(migration('319_dormitory_addresses.sql'));
    await run(migration('319_dormitory_addresses.sql'));
    expect((await listAddresses()).sort()).toEqual(['Общ. Свободы 35', 'Общ1']);
    // Записи удалили — адреса остаются.
    await run(`DELETE FROM employee_dormitory_stays`);
    expect(await listAddresses()).toHaveLength(2);
    await expect(run(`INSERT INTO dormitory_addresses (address) VALUES ('  ')`)).rejects.toThrow(/dormitory_address_text/);
    await run(`DELETE FROM dormitory_addresses`);
  });

  it('320: повтор безопасен; CHECK вида, суммы и адреса; доплата в условиях оплаты — миграция останавливается', async () => {
    await run(`INSERT INTO payroll_compensation_terms (employee_id, housing_compensation) VALUES (1, 630)`);
    // Отдельное соединение: ошибка внутри BEGIN миграции оставляет его в прерванной транзакции — откатываем сами.
    const client = await pg.pool!.connect();
    try {
      await expect(client.query(migration('320_dormitory_stays_apartment.sql'))).rejects.toThrow(/housing_compensation/);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect((await run(`SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'employee_dormitory_stays' AND column_name = 'kind'`)).rowCount).toBe(0);
    await run(`DELETE FROM payroll_compensation_terms`);
    await run(migration('320_dormitory_stays_apartment.sql'));
    await run(migration('320_dormitory_stays_apartment.sql'));

    const insert = (values: string) => run(
      `INSERT INTO employee_dormitory_stays (employee_id, kind, check_in, address, amount) VALUES ${values}`,
    );
    await expect(insert(`(1, 'apartment', '2030-01-01', NULL, NULL)`)).rejects.toThrow(/employee_dormitory_stay_amount/);
    await expect(insert(`(1, 'apartment', '2030-01-01', NULL, 0)`)).rejects.toThrow(/employee_dormitory_stay_amount/);
    await expect(insert(`(1, 'dormitory', '2030-01-01', 'Общ1', 630)`)).rejects.toThrow(/employee_dormitory_stay_amount/);
    await expect(insert(`(1, 'dormitory', '2030-01-01', NULL, NULL)`)).rejects.toThrow(/employee_dormitory_stay_address/);
    await expect(insert(`(1, 'apartment', '2030-01-01', '  ', 630)`)).rejects.toThrow(/employee_dormitory_stay_address/);
    await expect(insert(`(1, 'flat', '2030-01-01', 'Общ1', NULL)`)).rejects.toThrow(/employee_dormitory_stay_(kind|amount)/);
    // Прежний бэкенд пишет без вида — общежитие.
    await run(`INSERT INTO employee_dormitory_stays (employee_id, check_in, address) VALUES (1, '2030-01-01', 'Общ1')`);
    expect((await run(`SELECT kind, amount FROM employee_dormitory_stays`)).rows).toEqual([{ kind: 'dormitory', amount: null }]);
    await run(`DELETE FROM employee_dormitory_stays`);
  });

  it('периоды не пересекаются; въезд в день выезда — можно; выезд = въезд — нельзя', async () => {
    const first = await addStay(1, { kind: 'dormitory', amount: null, check_in: '2026-09-01', check_out: '2026-10-10', address: 'Общежитие №2, комн. 14' });
    expect(first).toMatchObject({
      employee_id: 1, full_name: 'Каримов Акмал', department: 'бр.Менгбоев Г.И.', position: 'Монтажник',
      check_in: '2026-09-01', check_out: '2026-10-10',
    });
    // Переселение: выезд 10-го и въезд 10-го.
    const second = await addStay(1, { kind: 'dormitory', amount: null, check_in: '2026-10-10', check_out: null, address: 'Общежитие №3' });
    expect(second).toMatchObject({ check_in: '2026-10-10', check_out: null });
    // Открытое проживание пересекается с любым будущим.
    expect(await addStay(1, { kind: 'dormitory', amount: null, check_in: '2027-01-01', check_out: null, address: 'Общежитие №4' })).toBe('overlap');
    expect(await addStay(1, { kind: 'dormitory', amount: null, check_in: '2026-09-15', check_out: '2026-09-20', address: 'Внутри' })).toBe('overlap');
    // У другого сотрудника те же даты — можно.
    expect(await addStay(2, { kind: 'dormitory', amount: null, check_in: '2026-09-15', check_out: '2026-09-20', address: 'Общежитие №2' })).toMatchObject({ employee_id: 2 });

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

    const closed = await updateStay(open.id, { amount: null, check_in: open.check_in, check_out: '2026-11-30', address: open.address });
    expect(closed).toMatchObject({ before: { check_out: null }, after: { check_out: '2026-11-30' } });
    expect(await updateStay(open.id, { amount: null, check_in: '2026-09-05', check_out: '2026-11-30', address: open.address })).toBe('overlap');
    expect(await updateStay(9999, { amount: null, check_in: '2026-09-05', check_out: null, address: 'x' })).toBeNull();

    expect((await listStays({ employeeIds: [2] })).map(stay => stay.employee_id)).toEqual([2]);
    expect(await listStays({ employeeIds: [] })).toEqual([]);
    expect((await listStays({ departmentIds: [D2] }))).toEqual([]);
    expect((await listStays({ departmentIds: [D1] }))).toHaveLength(3);

    expect(await deleteStay(open.id)).toMatchObject({ id: open.id, check_out: '2026-11-30' });
    expect(await deleteStay(open.id)).toBeNull();
    expect(await listStays({})).toHaveLength(2);
  });

  it('адреса: запоминаются при добавлении и правке, без повторов; пересечение адрес не пишет; удаление не стирает', async () => {
    // Из прошлых тестов: «Общежитие №2, комн. 14» (добавление), «Общежитие №3» (добавление, удалено выше),
    // «Общежитие №2» (добавление); «Общежитие №4» и «Внутри» — отказ по пересечению.
    expect(await listAddresses()).toEqual(['Общежитие №2, комн. 14', 'Общежитие №3', 'Общежитие №2']);

    const [stay] = await listStays({ employeeIds: [2] });
    await updateStay(stay.id, { amount: null, check_in: stay.check_in, check_out: stay.check_out, address: 'Общ. Нагатинская 34' });
    await updateStay(stay.id, { amount: null, check_in: stay.check_in, check_out: stay.check_out, address: 'ОБЩ. НАГАТИНСКАЯ 34' });
    expect(await listAddresses()).toEqual(['Общежитие №2, комн. 14', 'Общежитие №3', 'Общежитие №2', 'Общ. Нагатинская 34']);
    expect(await addStay(2, { kind: 'dormitory', amount: null, check_in: '2026-09-16', check_out: '2026-09-18', address: 'Пересечение' })).toBe('overlap');
    expect(await listAddresses()).not.toContain('Пересечение');

    await deleteStay(stay.id);
    expect(await listAddresses()).toContain('Общ. Нагатинская 34');
  });

  it('поиск: только работающие, не в архиве, не подрядчики, в охвате', async () => {
    expect((await searchCandidates('Кар', null)).map(row => row.full_name))
      .toEqual(['Карелин Безотдельный', 'Каримов Акмал']);
    expect(await getEmployeeState(5)).toMatchObject({ is_contractor: true });
    expect(await getEmployeeState(6)).toMatchObject({ is_contractor: false });
    expect(await getEmployeeState(1)).toMatchObject({ is_contractor: false, is_archived: false });
    expect(await searchCandidates('Кар', [2])).toEqual([]);
    expect(await searchCandidates('Кар', [])).toEqual([]);
    expect((await searchCandidates('_', null))).toEqual([]);
  });
  it('квартира: сумма и адрес по желанию; в один день — одно место; «Общежитие» «Зарплаты» её не видит', async () => {
    const flat = await addStay(6, { kind: 'apartment', check_in: '2026-10-01', check_out: null, address: null, amount: 630.5 });
    expect(flat).toMatchObject({ kind: 'apartment', address: null, amount: '630.50' });
    expect(await addStay(6, { kind: 'dormitory', check_in: '2026-12-01', check_out: null, address: 'Общ. Свободы 35', amount: null }))
      .toBe('overlap');
    if (flat === 'overlap') throw new Error('квартира не добавлена');
    expect(await updateStay(flat.id, { check_in: '2026-10-01', check_out: '2026-12-01', address: 'ул. Рабочая, 5', amount: 700 }))
      .toMatchObject({ before: { amount: '630.50' }, after: { check_out: '2026-12-01', address: 'ул. Рабочая, 5', amount: '700.00' } });
    // Правка кадров — без суммы (null): у квартиры остаётся та, что задала «Зарплата».
    expect(await updateStay(flat.id, { check_in: '2026-10-01', check_out: '2026-12-01', address: null, amount: null }))
      .toMatchObject({ after: { address: null, amount: '700.00' } });
    // Со дня выезда из квартиры — в общежитие можно.
    expect(await addStay(6, { kind: 'dormitory', check_in: '2026-12-01', check_out: null, address: 'Общ. Свободы 35', amount: null }))
      .toMatchObject({ kind: 'dormitory' });

    expect((await listStays({ employeeIds: [6] })).map(stay => stay.kind)).toEqual(['apartment', 'dormitory']);
    expect((await listStays({ employeeIds: [6], kind: 'dormitory' })).map(stay => stay.kind)).toEqual(['dormitory']);
    // Адрес квартиры в подсказки общежитий не попадает.
    expect(await listAddresses()).not.toContain('ул. Рабочая, 5');
  });
});
