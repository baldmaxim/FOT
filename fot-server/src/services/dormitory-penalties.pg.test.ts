import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// «История взысканий» (миграция 378) на настоящем PostgreSQL: CHECK-и таблицы, охват «Чёрного списка» (связанная
// запись вне охвата не видна, несвязанная — только «вся организация», несколько целей — одна строка), совпадения для
// окна «Заселить» (та же карточка, другая карточка с ФИО и обеими датами рождения — «Есть», две пустые даты или только
// ФИО — «Проверьте», связь через цели блокировки — «Есть», «Есть» важнее «Проверьте»), запись списка.
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
  };
});

import {
  addPenalty,
  getPenalty,
  listPenalties,
  penaltyMatches,
  removePenalty,
  updatePenalty,
} from './dormitory-penalties.service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../docs/migrations/', import.meta.url));
const migration = (name: string): string => readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf8');
const run = (sql: string, params: unknown[] = []) => pg.pool!.query(sql, params);
const pgCode = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
};

const D1 = '00000000-0000-0000-0000-0000000000d1';

describe.skipIf(!PG_URL)('«История взысканий» (миграция 378) на PostgreSQL', () => {
  beforeAll(async () => {
    await run(`
      DROP TABLE IF EXISTS dormitory_penalties, person_blacklist_targets, person_blacklist, employees, org_departments CASCADE;
      CREATE TABLE org_departments (id uuid PRIMARY KEY, name text);
      CREATE TABLE employees (
        id integer PRIMARY KEY, full_name text, org_department_id uuid REFERENCES org_departments(id),
        employment_status text NOT NULL DEFAULT 'active', dismissal_date date, hire_date date, birth_date date,
        pension_number text, email text
      );
      -- Как миграция 273: канон ФИО и генерируемые ключи записи «Чёрного списка».
      CREATE OR REPLACE FUNCTION public.norm_person_name(txt text)
      RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
        SELECT nullif(lower(regexp_replace(
                 translate(btrim(normalize(coalesce(txt, ''), NFKC)), 'ёЁ', 'ее'),
                 '\\s+', ' ', 'g')), '')
      $$;
      CREATE TABLE person_blacklist (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        full_name text NOT NULL,
        full_name_norm text GENERATED ALWAYS AS (public.norm_person_name(full_name)) STORED,
        birth_date date,
        snils text,
        snils_digits text GENERATED ALWAYS AS (nullif(regexp_replace(coalesce(snils, ''), '\\D', '', 'g'), '')) STORED,
        email text,
        email_lower text GENERATED ALWAYS AS (nullif(lower(btrim(coalesce(email, ''))), '')) STORED,
        passport_series_number text,
        passport_norm text GENERATED ALWAYS AS (
          nullif(lower(regexp_replace(coalesce(passport_series_number, ''), '[^0-9A-Za-zА-Яа-яЁё]', '', 'g')), '')) STORED,
        employee_id bigint,
        user_profile_id uuid,
        reason text NOT NULL DEFAULT 'Нарушение',
        created_by_name text NOT NULL DEFAULT 'Админ',
        created_at timestamptz NOT NULL DEFAULT now(),
        removed_at timestamptz
      );
      CREATE TABLE person_blacklist_targets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        blacklist_id uuid NOT NULL REFERENCES person_blacklist(id),
        employee_id bigint
      );
    `);
    await run(migration('378_dormitory_penalties.sql'));
    await run(migration('378_dormitory_penalties.sql'));
    await run(`INSERT INTO org_departments VALUES ($1, 'бр.Тестовая')`, [D1]);
    await run(`
      INSERT INTO employees (id, full_name, org_department_id, employment_status, dismissal_date, hire_date, birth_date) VALUES
        (1, 'Иванов Иван Иванович', '${D1}', 'fired', '2026-05-01', '2025-01-10', '1990-01-01'),
        (2, 'Иванов  Иван Иванович', '${D1}', 'active', NULL, '2026-06-01', '1990-01-01'),
        (3, 'Петров Пётр', '${D1}', 'active', NULL, '2025-01-10', NULL),
        (4, 'Петров Петр', '${D1}', 'active', NULL, '2026-03-01', NULL),
        (5, 'Сидоров Сидор', '${D1}', 'fired', '2026-02-01', '2024-01-10', '1985-05-05'),
        (6, 'Сидоров Сидор', '${D1}', 'active', NULL, '2026-04-01', '1985-05-05'),
        (7, 'Кузнецов Кузьма', '${D1}', 'active', NULL, '2026-01-10', NULL),
        (8, 'Орлов Олег', '${D1}', 'active', NULL, '2026-01-10', NULL),
        (9, 'Чистый Человек', '${D1}', 'active', NULL, '2026-01-10', NULL),
        (10, 'Иванов Иван Иванович', '${D1}', 'fired', '2025-01-01', '2024-01-10', NULL)
    `);
    await run(`
      INSERT INTO dormitory_penalties (employee_id, penalty_date, note) VALUES
        (1, '2026-03-10', 'Драка'), (3, NULL, 'Курение в комнате'), (10, '2024-06-01', 'Старое')
    `);
    // Сидоров — цели блокировки на обе карточки; Орлов — прямая связь; Кузнецов — только ФИО;
    // «Неизвестный» — без связи; снятая запись — не видна.
    const sidorov = await run(`INSERT INTO person_blacklist (full_name, reason) VALUES ('Сидоров Сидор', 'Хищение') RETURNING id`);
    await run(`INSERT INTO person_blacklist_targets (blacklist_id, employee_id) VALUES ($1, 5), ($1, 6)`, [sidorov.rows[0].id]);
    await run(`
      INSERT INTO person_blacklist (full_name, employee_id, reason) VALUES ('Орлов Олег', 8, 'Пьянство');
      INSERT INTO person_blacklist (full_name, reason) VALUES ('Кузнецов Кузьма', 'Однофамилец?');
      INSERT INTO person_blacklist (full_name, reason) VALUES ('Неизвестный Человек', 'Без карточки');
      INSERT INTO person_blacklist (full_name, employee_id, reason, removed_at) VALUES ('Чистый Человек', 9, 'Снят', now());
    `);
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('CHECK: пустая запись и неизвестный источник не пишутся (и скриптом в обход API)', async () => {
    expect(await pgCode(run(`INSERT INTO dormitory_penalties (employee_id, penalty_date, note) VALUES (9, NULL, '   ')`))).toBe('23514');
    expect(await pgCode(run(`INSERT INTO dormitory_penalties (employee_id, note, source) VALUES (9, 'x', 'excel')`))).toBe('23514');
    expect(await pgCode(run(`INSERT INTO dormitory_penalties (employee_id, note) VALUES (9, repeat('я', 1001))`))).toBe('23514');
  });

  it('вся организация: записи списка и «Чёрного списка», одна строка на запись ЧС, снятая не видна', async () => {
    const rows = await listPenalties(null);
    const blacklist = rows.filter(row => row.source === 'blacklist');
    expect(blacklist.map(row => [row.full_name, row.employee_id]).sort()).toEqual([
      ['Кузнецов Кузьма', null],
      ['Неизвестный Человек', null],
      ['Орлов Олег', 8],
      // Две цели — одна строка, карточка с поздним приёмом.
      ['Сидоров Сидор', 6],
    ]);
    expect(rows.filter(row => row.source === 'list').map(row => row.employee_id).sort()).toEqual([1, 10, 3]);
    const dates = rows.map(row => row.penalty_date).filter((date): date is string => date !== null);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(rows[rows.length - 1].penalty_date).toBeNull();
  });

  it('охват: связанная запись ЧС — только с карточкой в охвате, несвязанная — не видна', async () => {
    const rows = await listPenalties([1, 3, 5]);
    expect(rows.filter(row => row.source === 'blacklist').map(row => [row.full_name, row.employee_id])).toEqual([
      ['Сидоров Сидор', 5],
    ]);
    expect(rows.filter(row => row.source === 'list').map(row => row.employee_id).sort()).toEqual([1, 3]);
    expect(await listPenalties([])).toEqual([]);
  });

  it('совпадения для «Заселить»: человек — по ФИО и обеим датам, две пустые даты — «Проверьте»', async () => {
    const matches = await penaltyMatches([2, 4, 5, 6, 7, 8, 9]);
    // Иванов (2): карточка 1 — тот же человек («Есть»), карточка 10 без даты — «Проверьте»; итог — «Есть».
    expect(matches.get(2)?.level).toBe('yes');
    expect(matches.get(2)?.items.map(item => [item.note, item.level])).toEqual([['Драка', 'yes'], ['Старое', 'check']]);
    // Петров (4): две пустые даты рождения — не один человек.
    expect(matches.get(4)).toEqual({
      level: 'check',
      items: [expect.objectContaining({ source: 'list', level: 'check', note: 'Курение в комнате' })],
    });
    // Цели блокировки — «Есть» (findActive их не смотрит).
    expect(matches.get(5)?.level).toBe('yes');
    expect(matches.get(6)?.items).toEqual([expect.objectContaining({ source: 'blacklist', level: 'yes', note: 'Хищение' })]);
    // Только ФИО в «Чёрном списке» — «Проверьте»; прямая связь — «Есть».
    expect(matches.get(7)?.level).toBe('check');
    expect(matches.get(8)?.level).toBe('yes');
    // Снятая запись не считается.
    expect(matches.has(9)).toBe(false);
  });

  it('запись списка: добавить, поправить, удалить', async () => {
    const added = await addPenalty(9, { penalty_date: '2026-11-20', note: 'Шум' });
    expect(added).toEqual({ id: added.id, employee_id: 9, penalty_date: '2026-11-20', note: 'Шум', source: 'manual' });
    const updated = await updatePenalty(added.id, { penalty_date: null, note: 'Шум ночью' });
    expect(updated?.before.note).toBe('Шум');
    expect(updated?.after).toEqual({ ...added, penalty_date: null, note: 'Шум ночью' });
    expect((await penaltyMatches([9])).get(9)?.level).toBe('yes');
    expect(await removePenalty(added.id)).toEqual(updated?.after);
    expect(await getPenalty(added.id)).toBeNull();
    expect(await updatePenalty(added.id, { penalty_date: null, note: 'x' })).toBeNull();
  });
});
