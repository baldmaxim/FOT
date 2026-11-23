import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Служебные квартиры «Проживания» (миграция 371) на настоящем PostgreSQL: перенос «Кв. …» из общежитий в квартиры,
// повтор миграции, CHECK-и (псевдоквартира, «Платно», вид), квартира как источник адреса (переименование переписывает
// копии — «Справочник → Общежитие» «Зарплаты» видит новый адрес, компенсацию не видит), «Платно» и комментарий,
// «Переселить» (повтор, то же место, дата, пересечение), удаление квартиры с историей.
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

import { addApartment, deleteApartment, listApartments, updateApartment } from './company-apartments.service.js';
import { moveStay } from './dormitory-stay-move.service.js';
import {
  addStay, CompanyApartmentNotFoundError, getStay, listPayrollDormitoryStays, listStaysOfClass, updateStay, updateStayMeta,
} from './dormitory-stays.service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../docs/migrations/', import.meta.url));
const migration = (name: string): string => readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf8');
const run = (sql: string) => pg.pool!.query(sql);

const D1 = '00000000-0000-0000-0000-0000000000d1';
const PAYROLL_SCOPE = { contractorRootId: CONTRACTORS, departmentIds: null };

describe.skipIf(!PG_URL)('служебные квартиры «Проживания» (миграция 371) на PostgreSQL', () => {
  beforeAll(async () => {
    await run(`
      DROP TABLE IF EXISTS dormitory_addresses, employee_dormitory_stays, company_apartments,
        role_page_access, access_pages, payroll_compensation_terms, payroll_dormitory_allowances,
        employees, positions, org_departments CASCADE;
      DROP FUNCTION IF EXISTS public.get_descendant_department_ids(uuid[]);
      CREATE EXTENSION IF NOT EXISTS btree_gist;
      CREATE TABLE org_departments (id uuid PRIMARY KEY, name text, parent_id uuid);
      CREATE TABLE positions (id uuid PRIMARY KEY, name text);
      CREATE TABLE payroll_compensation_terms (
        id serial PRIMARY KEY, employee_id integer, housing_compensation numeric(12,2), travel_compensation numeric(12,2)
      );
      CREATE TABLE payroll_dormitory_allowances (
        id serial PRIMARY KEY, employee_id integer NOT NULL, date_from date NOT NULL, date_to date
      );
      CREATE TABLE employees (
        id integer PRIMARY KEY, full_name text, org_department_id uuid REFERENCES org_departments(id),
        position_id uuid REFERENCES positions(id), employment_status text NOT NULL DEFAULT 'active',
        is_archived boolean NOT NULL DEFAULT false, dismissal_date date, country text
      );
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
        LANGUAGE sql AS $$ SELECT d.id FROM org_departments d WHERE d.id = ANY($1) OR d.parent_id = ANY($1) $$;
      INSERT INTO org_departments (id, name) VALUES ('${D1}', 'ЛИНИЯ'), ('${CONTRACTORS}', 'Подрядные организации');
      INSERT INTO employees (id, full_name, org_department_id, country) VALUES
        (1, 'Гладкая Алина Романовна', '${D1}', 'РОССИЯ'),
        (2, 'Гладкая Наталья Васильевна', '${D1}', 'РОССИЯ'),
        (3, 'Желдубов Владимир Александрович', '${D1}', 'РОССИЯ'),
        (4, 'Баратов Илёс Шералиевич', '${D1}', 'УЗБЕКИСТАН'),
        (5, 'Абдурахманов Санжар Файзуллаевич', '${D1}', 'УЗБЕКИСТАН'),
        (6, 'Луис Дженс Жоаким Матиас', '${D1}', NULL);
    `);
    await run(migration('314_employee_dormitory_stays.sql'));
    await run(migration('319_dormitory_addresses.sql'));
    await run(migration('320_dormitory_stays_apartment.sql'));
    // Как на проде до 371: служебные квартиры — общежития с адресом «Кв. …».
    await run(`
      INSERT INTO employee_dormitory_stays (employee_id, kind, check_in, address, amount) VALUES
        (1, 'dormitory', '2024-08-01', 'Кв. Ляпидевского 12-58', NULL),
        (2, 'dormitory', '2026-03-01', 'Кв. Ляпидевского 12-58', NULL),
        (3, 'dormitory', '2026-05-01', 'Кв. 3-й Митинский пер. 5-201', NULL),
        (4, 'dormitory', '2026-09-01', 'Общ. Верхнелихоборская 6', NULL),
        (5, 'apartment', '2026-09-01', NULL, 630);
      INSERT INTO dormitory_addresses (address) VALUES ('Кв. Ляпидевского 12-58'), ('Общ. Верхнелихоборская 6')
        ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('371: «Кв. …» → 2 квартиры и 3 жильца, атрибуты 1С, повтор безопасен; общежитие и компенсация — без квартиры', async () => {
    await run(migration('371_company_apartments.sql'));
    await run(`UPDATE company_apartments SET rooms = 4 WHERE address = 'Ляпидевского 12-58'`);
    await run(migration('371_company_apartments.sql'));
    // Пауза компенсации (374): правка дат пишет её столбец.
    await run(migration('374_dormitory_stay_pause.sql'));

    expect(await listApartments()).toEqual([
      { id: expect.any(Number), address: '3-й Митинский пер. 5-201', note: 'РФ \\ ВНЖ', rooms: 2, places: 3,
        price: '65000.00', paid_until: '2026-11-01' },
      // Повтор не затёр правку кадров (rooms = 4).
      { id: expect.any(Number), address: 'Ляпидевского 12-58', note: 'семейная РФ', rooms: 4, places: 3,
        price: '70000.00', paid_until: '2026-12-25' },
    ]);
    expect((await listStaysOfClass('flat', null)).map(stay => [stay.employee_id, stay.address]))
      .toEqual([[1, 'Кв. Ляпидевского 12-58'], [2, 'Кв. Ляпидевского 12-58'], [3, 'Кв. 3-й Митинский пер. 5-201']]);
    expect((await listStaysOfClass('dormitory', null)).map(stay => stay.employee_id)).toEqual([4]);
    expect((await listStaysOfClass('compensation', null)).map(stay => stay.employee_id)).toEqual([5]);
    // «Кв. …» больше не подсказывается как адрес общежития.
    expect((await run(`SELECT address FROM dormitory_addresses`)).rows).toEqual([{ address: 'Общ. Верхнелихоборская 6' }]);
  });

  it('CHECK: псевдоквартира у общежития, «Платно» без квартиры, квартира у компенсации — отказ', async () => {
    await expect(run(`INSERT INTO employee_dormitory_stays (employee_id, check_in, address) VALUES (4, '2030-01-01', 'кв Тест 1')`))
      .rejects.toThrow(/employee_dormitory_stay_no_pseudo_apartment/);
    await expect(run(`UPDATE employee_dormitory_stays SET paid = true WHERE employee_id = 4`))
      .rejects.toThrow(/employee_dormitory_stay_paid/);
    const [{ id: apartmentId }] = (await run(`SELECT id FROM company_apartments ORDER BY id LIMIT 1`)).rows;
    await expect(run(`UPDATE employee_dormitory_stays SET apartment_id = ${apartmentId} WHERE employee_id = 5`))
      .rejects.toThrow(/employee_dormitory_stay_apartment_kind/);
  });

  it('квартира — источник адреса: переименование переписывает копии, «Зарплата» видит новый адрес, компенсацию — нет', async () => {
    const apartment = (await listApartments()).find(item => item.address === 'Ляпидевского 12-58')!;
    const updated = await updateApartment(apartment.id, {
      address: 'Ляпидевского 12-58А', note: 'семейная РФ', rooms: 2, places: 3, price: 70000, paid_until: '2026-12-25',
    });
    expect(updated).toMatchObject({ relinked: 2, after: { address: 'Ляпидевского 12-58А', rooms: 2 } });

    const payroll = await listPayrollDormitoryStays(PAYROLL_SCOPE);
    expect(payroll.map(stay => [stay.employee_id, stay.address])).toEqual([
      [4, 'Общ. Верхнелихоборская 6'],
      [1, 'Кв. Ляпидевского 12-58А'],
      [2, 'Кв. Ляпидевского 12-58А'],
      [3, 'Кв. 3-й Митинский пер. 5-201'],
    ]);
    expect(payroll.some(stay => stay.employee_id === 5)).toBe(false);

    // Правка дат жильца не меняет адрес, даже если прислан другой (адрес — только у квартиры).
    const stay = (await listStaysOfClass('flat', [1]))[0];
    await updateStay(stay.id, { check_in: stay.check_in, check_out: null, address: 'Кв. Чужая 1', amount: null });
    expect((await getStay(stay.id))?.address).toBe('Кв. Ляпидевского 12-58А');

    // Адрес, занятый другой квартирой (регистр не важен), — 'duplicate'.
    expect(await updateApartment(apartment.id, {
      address: '3-Й МИТИНСКИЙ ПЕР. 5-201', note: null, rooms: null, places: null, price: null, paid_until: null,
    })).toBe('duplicate');
    expect(await addApartment({
      address: 'ляпидевского 12-58а', note: null, rooms: null, places: null, price: null, paid_until: null,
    })).toBe('duplicate');
  });

  it('заселение в квартиру: адрес — из квартиры; квартиры нет — ошибка; удалить квартиру с историей нельзя', async () => {
    const added = await addApartment({
      address: 'Складочная 6-2-27', note: null, rooms: 1, places: 1, price: 75000, paid_until: '2026-11-24',
    });
    if (added === 'duplicate') throw new Error('duplicate');
    const stay = await addStay(6, {
      kind: 'dormitory', apartment_id: added.id, check_in: '2026-08-26', check_out: null, address: 'Кв. Не та', amount: null,
    });
    expect(stay).toMatchObject({ apartment_id: added.id, address: 'Кв. Складочная 6-2-27', paid: false });
    await expect(addStay(6, {
      kind: 'dormitory', apartment_id: 999999, check_in: '2031-01-01', check_out: null, address: '-', amount: null,
    })).rejects.toBeInstanceOf(CompanyApartmentNotFoundError);

    expect(await deleteApartment(added.id)).toBe('has_stays');
    await run(`DELETE FROM employee_dormitory_stays WHERE apartment_id = ${added.id}`);
    expect(await deleteApartment(added.id)).toMatchObject({ address: 'Складочная 6-2-27' });
  });

  it('«Платно» и комментарий: только у жильца квартиры, без изменений — та же строка', async () => {
    const flat = (await listStaysOfClass('flat', [1]))[0];
    const dormitory = (await listStaysOfClass('dormitory', [4]))[0];
    const paid = await updateStayMeta(flat.id, { paid: true });
    expect(paid).toMatchObject({ before: { paid: false }, after: { paid: true, comment: null, check_in: flat.check_in } });
    const same = await updateStayMeta(flat.id, { paid: true });
    expect(same).not.toBe(null);
    if (same && same !== 'not_flat') expect(same.after).toBe(same.before);
    expect(await updateStayMeta(dormitory.id, { paid: true })).toBe('not_flat');
    expect(await updateStayMeta(dormitory.id, { comment: 'с мужем' })).toMatchObject({ after: { comment: 'с мужем', paid: false } });
  });

  it('переселение: общежитие → квартира с даты, повтор — то же, то же место, дата не позже въезда, выехал раньше', async () => {
    const apartment = (await listApartments()).find(item => item.address === '3-й Митинский пер. 5-201')!;
    const dormitory = (await listStaysOfClass('dormitory', [4]))[0];
    // Справочник общежитий (377): переселяют только в общежитие из него.
    await run(`INSERT INTO dormitory_addresses (address) VALUES ('Общ. Свободы 35')`);

    expect(await moveStay(dormitory.id, '2026-09-01', { apartmentId: apartment.id })).toBe('before_check_in');
    expect(await moveStay(dormitory.id, '2026-11-19', { address: 'общ. верхнелихоборская 6' })).toBe('same_place');

    const moved = await moveStay(dormitory.id, '2026-11-19', { apartmentId: apartment.id });
    expect(moved).toMatchObject({
      repeated: false,
      closed: { id: dormitory.id, check_in: '2026-09-01', check_out: '2026-11-19', address: 'Общ. Верхнелихоборская 6' },
      opened: { check_in: '2026-11-19', check_out: null, apartment_id: apartment.id, address: 'Кв. 3-й Митинский пер. 5-201',
        paid: false, comment: 'с мужем' },
    });
    // Двойной клик: та же пара, новых записей нет.
    const again = await moveStay(dormitory.id, '2026-11-19', { apartmentId: apartment.id });
    expect(again).toMatchObject({ repeated: true, opened: { id: (moved as { opened: { id: number } }).opened.id } });
    expect((await run(`SELECT count(*)::int AS n FROM employee_dormitory_stays WHERE employee_id = 4`)).rows).toEqual([{ n: 2 }]);
    // Повтор в другое место — запись уже закрыта этой датой.
    expect(await moveStay(dormitory.id, '2026-11-19', { address: 'Общ. Свободы 35' })).toBe('not_open');
    // Компенсацию не переселяют.
    const compensation = (await listStaysOfClass('compensation', [5]))[0];
    expect(await moveStay(compensation.id, '2026-11-19', { address: 'Общ. Свободы 35' })).toBe('not_movable');
    // Обратно в общежитие — только из справочника, его написанием; справочник сервис не пополняет.
    const openedId = (moved as { opened: { id: number } }).opened.id;
    expect(await moveStay(openedId, '2026-11-20', { address: 'Общ. Новое' })).toBe('not_in_directory');
    const back = await moveStay(openedId, '2026-11-20', { address: 'общ. свободы 35' });
    expect(back).toMatchObject({ opened: { apartment_id: null, address: 'Общ. Свободы 35' } });
    expect((await run(`SELECT address FROM dormitory_addresses ORDER BY id`)).rows.map(row => row.address))
      .not.toContain('Общ. Новое');
  });

  it('переселение сохраняет запланированный выезд: новая запись — с даты переселения до прежнего выезда', async () => {
    const flat = (await listStaysOfClass('flat', [2]))[0];
    await run(`UPDATE employee_dormitory_stays SET check_out = '2027-01-01' WHERE id = ${flat.id}`);
    const moved = await moveStay(flat.id, '2026-11-19', { address: 'Общ. Свободы 35' });
    expect(moved).toMatchObject({
      closed: { id: flat.id, check_out: '2026-11-19' },
      opened: { check_in: '2026-11-19', check_out: '2027-01-01', apartment_id: null },
    });
    // Новая запись — внутри прежнего периода: с другими проживаниями сотрудника она не пересекается (EXCLUDE цел).
    await expect(run(`INSERT INTO employee_dormitory_stays (employee_id, check_in, address) VALUES (2, '2026-12-15', 'Общ. Свободы 35')`))
      .rejects.toThrow(/employee_dormitory_stay_no_overlap/);
  });
});
