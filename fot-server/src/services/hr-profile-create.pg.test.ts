import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// «Завести реквизиты» на настоящем PostgreSQL: из двух одновременных запросов профиль
// вставляет один, и только он пишет событие истории «created». Проверка на моках этого не
// доказывает — атомарность даёт сам INSERT … ON CONFLICT DO NOTHING RETURNING.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы пересоздаются).

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../config/postgres.js', async () => {
  const { Pool } = await import('pg');
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 10 }) : null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool.query(sql, params as unknown[]);
  };
  return {
    query: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows[0] ?? null,
    execute: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rowCount ?? 0,
    withTransaction: async <T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> => {
      if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
      const client = await pg.pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
});

import { createProfile } from './hr-profile.service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../docs/migrations/', import.meta.url));
const migration = (file: string): string => readFileSync(`${MIGRATIONS_DIR}${file}`, 'utf8');

const q = async <T extends import('pg').QueryResultRow>(sql: string, params?: unknown[]) =>
  (await pg.pool!.query<T>(sql, params)).rows;

const USER_A = '00000000-0000-0000-0000-0000000000a1';
const USER_B = '00000000-0000-0000-0000-0000000000b1';
const EMPLOYEE_ID = 4468;

const counts = async (): Promise<{ profiles: number; created: number }> => {
  const [row] = await q<{ profiles: number; created: number }>(
    `SELECT (SELECT count(*)::int FROM employee_hr_profiles WHERE employee_id = $1) AS profiles,
            (SELECT count(*)::int FROM employee_hr_profile_history WHERE employee_id = $1 AND event_type = 'created') AS created`,
    [EMPLOYEE_ID],
  );
  return row;
};

const d = PG_URL ? describe : describe.skip;

d('createProfile на PostgreSQL: одновременное создание', () => {
  beforeAll(async () => {
    await q(`DROP TABLE IF EXISTS employee_hr_ocr_conflicts, employee_hr_profile_history, employee_hr_profiles,
                                  hr_citizenship_synonyms, hr_citizenships, documents, document_categories,
                                  access_pages, user_profiles, employees CASCADE`);
    // Минимум таблиц, на которые ссылаются миграции 258–259.
    await q(`CREATE TABLE employees (
               id integer PRIMARY KEY, full_name text, last_name text, first_name text, middle_name text,
               birth_date date, email text, pension_number text, patent_issue_date date, patent_expiry_date date,
               employment_status text, hire_date date, org_department_id uuid, tab_number text, country text,
               updated_at timestamptz NOT NULL DEFAULT now())`);
    await q(`CREATE TABLE user_profiles (id uuid PRIMARY KEY, full_name text)`);
    await q(`CREATE TABLE documents (id bigserial PRIMARY KEY, employee_id integer, category text)`);
    await q(`CREATE TABLE document_categories (code text PRIMARY KEY, label text NOT NULL, sort_order integer)`);
    await q(`CREATE TABLE access_pages (
               key text PRIMARY KEY, label text, group_code text, group_label text, area text, surface text,
               supports_edit boolean, sort_order integer, is_active boolean,
               created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`);
    await pg.pool!.query(migration('258_hr_citizenships.sql'));
    await pg.pool!.query(migration('259_employee_hr_profiles.sql'));

    await q(`INSERT INTO user_profiles (id, full_name) VALUES ($1, 'Табельщица А'), ($2, 'Табельщица Б')`, [USER_A, USER_B]);
    await q(`INSERT INTO employees (id, full_name, employment_status) VALUES ($1, 'Тестов Тест Тестович', 'active')`, [EMPLOYEE_ID]);
  });

  beforeEach(async () => {
    await q(`TRUNCATE employee_hr_profile_history, employee_hr_profiles`);
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('первый вызов создаёт профиль и одно событие «created»', async () => {
    const result = await createProfile(EMPLOYEE_ID, {}, { userId: USER_A }, 'admin');
    expect(result.created).toBe(true);
    expect(await counts()).toEqual({ profiles: 1, created: 1 });
  });

  it('повторный вызов ничего не создаёт: created=false, второго события нет', async () => {
    await createProfile(EMPLOYEE_ID, {}, { userId: USER_A }, 'admin');
    const again = await createProfile(EMPLOYEE_ID, {}, { userId: USER_B }, 'admin');
    expect(again.created).toBe(false);
    expect(await counts()).toEqual({ profiles: 1, created: 1 });
  });

  it('два параллельных вызова: один профиль, одно событие, created=true только у одного', async () => {
    // Несколько прогонов: гонка не обязана проявиться с первой попытки.
    for (let round = 0; round < 20; round += 1) {
      await q(`TRUNCATE employee_hr_profile_history, employee_hr_profiles`);
      const results = await Promise.all([
        createProfile(EMPLOYEE_ID, {}, { userId: USER_A }, 'admin'),
        createProfile(EMPLOYEE_ID, {}, { userId: USER_B }, 'admin'),
      ]);
      expect(results.filter(r => r.created)).toHaveLength(1);
      expect(await counts()).toEqual({ profiles: 1, created: 1 });
    }
  });

  it('пять параллельных вызовов — то же правило', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => createProfile(EMPLOYEE_ID, {}, { userId: i % 2 ? USER_A : USER_B }, 'admin')),
    );
    expect(results.filter(r => r.created)).toHaveLength(1);
    expect(await counts()).toEqual({ profiles: 1, created: 1 });
  });
});
