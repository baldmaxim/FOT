import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Галочка «Выработка» (миграция 342) на настоящем PostgreSQL: миграция и её повтор, запись и снятие, повторы без
// изменений, FK (удаление сотрудника и учётки), fail-closed до миграции.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы-заглушки пересоздаются).

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../../config/postgres.js', async () => {
  const { Pool, types } = await import('pg');
  types.setTypeParser(20, (value: string) => Number(value));
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 3 }) : null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool.query(sql, params as unknown[]);
  };
  return {
    query: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows[0] ?? null,
  };
});

const { hasBrigadeOutputGrant, loadBrigadeOutputGrant, setBrigadeOutputGrant } = await import('./brigade-output-access.service.js');

const MIGRATION = readFileSync(
  fileURLToPath(new URL('../../../../docs/migrations/342_employee_brigade_output_access.sql', import.meta.url)),
  'utf8',
);

const EMPLOYEE = 1429;
const OTHER_EMPLOYEE = 769;
const GRANTOR = '11111111-1111-4111-8111-111111111111';

describe.skipIf(!PG_URL)('employee_brigade_output_access (342)', () => {
  beforeAll(async () => {
    await pg.pool!.query(`
      DROP TABLE IF EXISTS public.employee_brigade_output_access;
      DROP TABLE IF EXISTS public.employees;
      DROP TABLE IF EXISTS public.user_profiles;
      CREATE TABLE public.employees (id bigint PRIMARY KEY);
      CREATE TABLE public.user_profiles (id uuid PRIMARY KEY);
      INSERT INTO public.employees (id) VALUES (${EMPLOYEE}), (${OTHER_EMPLOYEE});
      INSERT INTO public.user_profiles (id) VALUES ('${GRANTOR}');
    `);
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('до миграции: проверка права — нет доступа, а не ошибка', async () => {
    await expect(hasBrigadeOutputGrant(EMPLOYEE)).resolves.toBe(false);
  });

  it('миграция применяется и повторяется', async () => {
    await pg.pool!.query(MIGRATION);
    await pg.pool!.query(MIGRATION);
    await expect(loadBrigadeOutputGrant(EMPLOYEE)).resolves.toBe(false);
  });

  it('поставить, повторить без изменений, снять, снять ещё раз', async () => {
    const client = await pg.pool!.connect();
    try {
      await expect(setBrigadeOutputGrant(client, EMPLOYEE, true, GRANTOR)).resolves.toBe(true);
      await expect(hasBrigadeOutputGrant(EMPLOYEE)).resolves.toBe(true);
      await expect(hasBrigadeOutputGrant(OTHER_EMPLOYEE)).resolves.toBe(false);
      await expect(setBrigadeOutputGrant(client, EMPLOYEE, true, GRANTOR)).resolves.toBe(false);
      await expect(setBrigadeOutputGrant(client, EMPLOYEE, false, GRANTOR)).resolves.toBe(true);
      await expect(loadBrigadeOutputGrant(EMPLOYEE)).resolves.toBe(false);
      await expect(setBrigadeOutputGrant(client, EMPLOYEE, false, GRANTOR)).resolves.toBe(false);
    } finally {
      client.release();
    }
  });

  it('удаление учётки: галочка остаётся, автор — NULL; удаление сотрудника: галочка уходит', async () => {
    const client = await pg.pool!.connect();
    try {
      await setBrigadeOutputGrant(client, EMPLOYEE, true, GRANTOR);
      await client.query('DELETE FROM public.user_profiles WHERE id = $1', [GRANTOR]);
      const { rows } = await client.query(
        'SELECT created_by FROM public.employee_brigade_output_access WHERE employee_id = $1',
        [EMPLOYEE],
      );
      expect(rows).toEqual([{ created_by: null }]);

      await client.query('DELETE FROM public.employees WHERE id = $1', [EMPLOYEE]);
      await expect(loadBrigadeOutputGrant(EMPLOYEE)).resolves.toBe(false);
    } finally {
      client.release();
    }
  });
});
