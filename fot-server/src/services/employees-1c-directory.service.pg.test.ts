import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Справочник сотрудников для 1С на настоящем PostgreSQL: состав (подрядчики по текущему отделу, по отделу увольнения и
// по назначениям; архивные; уволенные до 06.2026; «уволен без даты»), организация по отделу увольнения, поиск по коду
// физлица и ID_FOT, статус, страницы без пропусков. Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД.

const PG_URL = process.env.FOT_TEST_PG_URL;
const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../config/postgres.js', async () => {
  const { Pool } = await import('pg');
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 3 }) : null;
  return { query: async (sql: string, params?: readonly unknown[]) => (await pg.pool!.query(sql, params as unknown[])).rows };
});

import { listDirectoryEmployees, type IDirectoryFilters } from './employees-1c-directory.service.js';

const ROOT = '00000000-0000-4000-8000-000000000001';
const SU10 = '2cd8a403-6454-408b-9c2b-8a2db65c7511';
const SM = '6c4a3726-4ba9-4550-9978-c5ff50e4f77b';
const SU10_PTO = 'd1000000-0000-4000-8000-000000000001';
const SM_GARAGE = 'd2000000-0000-4000-8000-000000000002';
const CONTR = 'c0000000-0000-4000-8000-0000000000c0';
const CONTR_CO = 'c1000000-0000-4000-8000-0000000000c1';
const ARCH = 'a0000000-0000-4000-8000-0000000000ac';
const POS = 'e0000000-0000-4000-8000-0000000000e0';
const ID_ALL = '259802ec-95a4-42fc-ab00-3bc40f22a5cd';

const sql = async (text: string, params: unknown[] = []): Promise<void> => { await pg.pool!.query(text, params); };
const ALL: IDirectoryFilters = { idAll: null, employeeId: null, status: null, afterId: null, limit: 500 };

describe.skipIf(!PG_URL)('employees-1c-directory — PostgreSQL', () => {
  beforeAll(async () => {
    await sql(`DROP TABLE IF EXISTS org_departments, employees, employee_hr_profiles, positions, employee_dismissal_events,
                 employee_assignments CASCADE`);
    await sql('CREATE TABLE org_departments (id uuid PRIMARY KEY, parent_id uuid, name text NOT NULL, kind text)');
    await sql(`CREATE TABLE employees (id int PRIMARY KEY, full_name text, last_name text, first_name text, middle_name text,
                 birth_date date, tab_number text, org_department_id uuid, position_id uuid, hire_date date, dismissal_date date,
                 employment_status text NOT NULL DEFAULT 'active', is_archived boolean NOT NULL DEFAULT false)`);
    await sql('CREATE TABLE employee_hr_profiles (employee_id int PRIMARY KEY, passdesk_id_all uuid)');
    await sql('CREATE TABLE positions (id uuid PRIMARY KEY, name text)');
    await sql(`CREATE TABLE employee_dismissal_events (employee_id int, from_department_id uuid, cancelled boolean DEFAULT false,
                 created_at timestamptz DEFAULT now())`);
    await sql('CREATE TABLE employee_assignments (employee_id int, org_department_id uuid, effective_from date, effective_to date)');

    await sql(`INSERT INTO org_departments VALUES
                 ($1, NULL, 'Объект', 'object'), ($2, $1, '(СУ-10) ООО СУ-10', NULL), ($3, $1, '(СМ) Служба Механизации', NULL),
                 ($4, $2, 'Отдел ПТО', NULL), ($5, $3, 'Гараж', NULL), ($6, $1, 'Подрядные организации', NULL),
                 ($7, $6, 'ООО Подряд', NULL), ($8, $1, 'Уволенные', NULL)`,
    [ROOT, SU10, SM, SU10_PTO, SM_GARAGE, CONTR, CONTR_CO, ARCH]);
    await sql(`INSERT INTO positions VALUES ($1, 'Инженер ПТО')`, [POS]);
    await sql(`INSERT INTO employees (id, full_name, last_name, first_name, middle_name, birth_date, tab_number, org_department_id,
                 position_id, hire_date, dismissal_date, employment_status, is_archived) VALUES
      (1, 'Иванов Иван Иванович', 'Иванов', 'Иван', 'Иванович', '1990-05-01', ' 0001 ', $1, $5, '2024-01-10', NULL, 'active', false),
      (2, 'Петров Пётр', 'Петров', 'Пётр', NULL, NULL, NULL, $2, NULL, '2025-02-01', NULL, 'active', false),
      (3, 'Подрядчик Работающий', NULL, NULL, NULL, NULL, NULL, $3, NULL, NULL, NULL, 'active', false),
      (4, 'Савкин Дмитрий', NULL, NULL, NULL, NULL, NULL, $4, NULL, '2024-03-01', '2026-11-20', 'fired', false),
      (5, 'Подрядчик Уволенный', NULL, NULL, NULL, NULL, NULL, $4, NULL, NULL, '2026-10-10', 'fired', false),
      (6, 'Уволен Давно', NULL, NULL, NULL, NULL, NULL, $4, NULL, NULL, '2026-05-31', 'fired', false),
      (7, 'Уволен Без Даты', NULL, NULL, NULL, NULL, NULL, $4, NULL, NULL, NULL, 'fired', false),
      (8, 'Архивный', NULL, NULL, NULL, NULL, NULL, $1, NULL, NULL, NULL, 'active', true),
      (9, 'Уволен Без События', NULL, NULL, NULL, NULL, NULL, $4, NULL, NULL, '2026-09-15', 'fired', false),
      (10, 'Подрядчик По Назначению', NULL, NULL, NULL, NULL, NULL, $4, NULL, NULL, '2026-09-15', 'fired', false)`,
    [SU10_PTO, SM_GARAGE, CONTR_CO, ARCH, POS]);
    await sql('INSERT INTO employee_hr_profiles VALUES (1, NULL), (4, $1)', [ID_ALL]);
    // 4 — уволен из ПТО СУ-10 (отменённое увольнение из подряда не учитывается); 5 — уволен из подрядчика.
    await sql(`INSERT INTO employee_dismissal_events (employee_id, from_department_id, cancelled, created_at) VALUES
                 (4, $1, false, '2026-11-20T10:00:00Z'), (4, $2, true, '2026-11-21T10:00:00Z'), (5, $2, false, '2026-10-10T10:00:00Z')`,
    [SU10_PTO, CONTR_CO]);
    // 9 и 10 — увольнения без события: отдел — последнее назначение, кроме «Уволенных».
    await sql(`INSERT INTO employee_assignments VALUES (9, $1, '2025-01-01', '2026-03-31'), (9, $2, '2026-04-01', '2026-09-15'),
                 (9, $3, '2026-09-16', NULL), (10, $4, '2026-01-01', '2026-09-15'), (10, $3, '2026-09-16', NULL)`,
    [SU10_PTO, SM_GARAGE, ARCH, CONTR_CO]);
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('состав, поля, организация по отделу увольнения или назначению, поиск, статус, страницы', async () => {
    const all = await listDirectoryEmployees(ALL);
    expect(all.rows.map(row => row.employee_id)).toEqual([1, 2, 4, 9]);
    expect(all.nextAfterId).toBeNull();

    const [ivanov, petrov, savkin, noEvent] = all.rows;
    expect(ivanov).toEqual({
      employee_id: 1, id_all: null, full_name: 'Иванов Иван Иванович', last_name: 'Иванов', first_name: 'Иван',
      middle_name: 'Иванович', birth_date: '1990-05-01', tab_number: '0001',
      organization: { inn: '7736255508', name: 'СУ-10' }, department: { id: SU10_PTO, name: 'Отдел ПТО' },
      position: 'Инженер ПТО', hire_date: '2024-01-10', dismissal_date: null, status: 'active',
    });
    expect(petrov.organization).toEqual({ inn: '7705794997', name: 'Служба механизации' });
    expect(savkin).toMatchObject({
      id_all: ID_ALL, status: 'fired', dismissal_date: '2026-11-20', department: { id: SU10_PTO }, organization: { name: 'СУ-10' },
    });
    expect(noEvent).toMatchObject({ department: { id: SM_GARAGE }, organization: { name: 'Служба механизации' } });

    expect((await listDirectoryEmployees({ ...ALL, idAll: ID_ALL })).rows.map(row => row.employee_id)).toEqual([4]);
    expect((await listDirectoryEmployees({ ...ALL, employeeId: 2 })).rows.map(row => row.employee_id)).toEqual([2]);
    expect((await listDirectoryEmployees({ ...ALL, employeeId: 3 })).rows).toEqual([]);
    expect((await listDirectoryEmployees({ ...ALL, status: 'fired' })).rows.map(row => row.employee_id)).toEqual([4, 9]);
    expect((await listDirectoryEmployees({ ...ALL, status: 'active' })).rows.map(row => row.employee_id)).toEqual([1, 2]);

    // Страницы по 1: все строки один раз, по возрастанию.
    const seen: number[] = [];
    let afterId: number | null = null;
    for (;;) {
      const page = await listDirectoryEmployees({ ...ALL, limit: 1, afterId });
      seen.push(...page.rows.map(row => row.employee_id));
      if (page.nextAfterId === null) break;
      afterId = page.nextAfterId;
    }
    expect(seen).toEqual([1, 2, 4, 9]);
  });
});
