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

const {
  hasBrigadeOutputGrant,
  loadBrigadeOutputGrant,
  loadSupervisorKtuGrant,
  resolveSupervisorKtuBrigadeIds,
  setBrigadeOutputGrant,
  setSupervisorKtuGrant,
} = await import('./brigade-output-access.service.js');

const MIGRATION = readFileSync(
  fileURLToPath(new URL('../../../../docs/migrations/342_employee_brigade_output_access.sql', import.meta.url)),
  'utf8',
);

const MIGRATION_370 = readFileSync(
  fileURLToPath(new URL('../../../../docs/migrations/370_employee_supervisor_ktu_access.sql', import.meta.url)),
  'utf8',
);

const EMPLOYEE = 1429;
const OTHER_EMPLOYEE = 769;
const GRANTOR = '11111111-1111-4111-8111-111111111111';

describe.skipIf(!PG_URL)('employee_brigade_output_access (342)', () => {
  beforeAll(async () => {
    await pg.pool!.query(`
      DROP TABLE IF EXISTS public.employee_brigade_output_access, public.employee_supervisor_ktu_access;
      DROP TABLE IF EXISTS public.employees CASCADE;
      DROP TABLE IF EXISTS public.user_profiles CASCADE;
      CREATE TABLE public.employees (id bigint PRIMARY KEY);
      CREATE TABLE public.user_profiles (id uuid PRIMARY KEY);
      INSERT INTO public.employees (id) VALUES (${EMPLOYEE}), (${OTHER_EMPLOYEE});
      INSERT INTO public.user_profiles (id) VALUES ('${GRANTOR}');
    `);
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

// Галочка «Ставить КТУ своим бригадам» (370): миграция, запись, FK и эффективные бригады — то же правило, что «начальник
// участка вне дележа» (full, не sigur_sync, бригада, роль site_supervisor, активные сотрудник и отдел).
describe.skipIf(!PG_URL)('employee_supervisor_ktu_access (370)', () => {
  const SUPERVISOR = 815;
  const ROLE_SUP = '22222222-2222-4222-8222-222222222222';
  const ROLE_OFFICE = '33333333-3333-4333-8333-333333333333';
  const SUP_PROFILE = '44444444-4444-4444-8444-444444444444';
  const BR_1 = '5049c2c9-1334-49e6-8d55-7a04bebcaa8c';
  const BR_2 = '7d3c1e2f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
  const BR_VIEW = 'aaaaaaaa-0000-4000-8000-000000000001';
  const BR_SIGUR = 'aaaaaaaa-0000-4000-8000-000000000002';
  const BR_INACTIVE = 'aaaaaaaa-0000-4000-8000-000000000003';
  const DEPT = 'aaaaaaaa-0000-4000-8000-000000000004';

  beforeAll(async () => {
    await pg.pool!.query(`
      DROP TABLE IF EXISTS public.employee_supervisor_ktu_access, public.employee_brigade_output_access,
        public.employee_department_access, public.org_departments, public.system_roles, public.employees,
        public.user_profiles CASCADE;
      CREATE TABLE public.employees (
        id bigint PRIMARY KEY, employment_status text NOT NULL DEFAULT 'active', is_archived boolean NOT NULL DEFAULT false);
      CREATE TABLE public.system_roles (id uuid PRIMARY KEY, code text);
      CREATE TABLE public.user_profiles (id uuid PRIMARY KEY, employee_id bigint, system_role_id uuid);
      CREATE TABLE public.org_departments (id uuid PRIMARY KEY, kind text, is_active boolean NOT NULL DEFAULT true);
      CREATE TABLE public.employee_department_access (
        employee_id bigint, department_id uuid, source text, is_active boolean, access_level text);
      INSERT INTO public.employees (id) VALUES (${SUPERVISOR}), (${EMPLOYEE});
      INSERT INTO public.system_roles (id, code) VALUES ('${ROLE_SUP}', 'site_supervisor'), ('${ROLE_OFFICE}', 'office');
      INSERT INTO public.user_profiles (id, employee_id, system_role_id) VALUES
        ('${GRANTOR}', NULL, NULL), ('${SUP_PROFILE}', ${SUPERVISOR}, '${ROLE_SUP}'),
        ('55555555-5555-4555-8555-555555555555', ${EMPLOYEE}, '${ROLE_OFFICE}');
      INSERT INTO public.org_departments (id, kind, is_active) VALUES
        ('${BR_1}', 'brigade', true), ('${BR_2}', 'brigade', true), ('${BR_VIEW}', 'brigade', true),
        ('${BR_SIGUR}', 'brigade', true), ('${BR_INACTIVE}', 'brigade', false), ('${DEPT}', 'department', true);
      INSERT INTO public.employee_department_access (employee_id, department_id, source, is_active, access_level) VALUES
        (${SUPERVISOR}, '${BR_1}', 'manual_admin_ui', true, 'full'),
        (${SUPERVISOR}, '${BR_2}', 'excel_admin_ui', true, 'full'),
        (${SUPERVISOR}, '${BR_VIEW}', 'manual_admin_ui', true, 'view'),
        (${SUPERVISOR}, '${BR_SIGUR}', 'sigur_sync', true, 'full'),
        (${SUPERVISOR}, '${BR_INACTIVE}', 'manual_admin_ui', true, 'full'),
        (${SUPERVISOR}, '${DEPT}', 'manual_admin_ui', true, 'full'),
        (${EMPLOYEE}, '${BR_1}', 'manual_admin_ui', true, 'full');
    `);
  });

  it('до миграции: авторизация — [] (fail-closed); панель — ошибка (500), а не «нет»', async () => {
    await expect(resolveSupervisorKtuBrigadeIds(SUPERVISOR)).resolves.toEqual([]);
    await expect(loadSupervisorKtuGrant(SUPERVISOR)).rejects.toThrow();
  });

  it('миграция применяется и повторяется', async () => {
    await pg.pool!.query(MIGRATION_370);
    await pg.pool!.query(MIGRATION_370);
    await expect(loadSupervisorKtuGrant(SUPERVISOR)).resolves.toBe(false);
  });

  it('без галочки — []; с галочкой — только свои бригады (full, не Sigur, активные); не начальник — []', async () => {
    await expect(resolveSupervisorKtuBrigadeIds(SUPERVISOR)).resolves.toEqual([]);
    const client = await pg.pool!.connect();
    try {
      await expect(setSupervisorKtuGrant(client, SUPERVISOR, true, GRANTOR)).resolves.toBe(true);
      await expect(setSupervisorKtuGrant(client, SUPERVISOR, true, GRANTOR)).resolves.toBe(false);
      await expect(setSupervisorKtuGrant(client, EMPLOYEE, true, GRANTOR)).resolves.toBe(true);
    } finally {
      client.release();
    }
    await expect(resolveSupervisorKtuBrigadeIds(SUPERVISOR)).resolves.toEqual([BR_1, BR_2].sort());
    // Роль office с full-связью на бригаду — не начальник участка: галочка «спит».
    await expect(resolveSupervisorKtuBrigadeIds(EMPLOYEE)).resolves.toEqual([]);
  });

  it('удаление учётки автора — автор NULL; снять, снять ещё раз; удаление сотрудника — галочка уходит', async () => {
    const client = await pg.pool!.connect();
    try {
      await client.query('DELETE FROM public.user_profiles WHERE id = $1', [GRANTOR]);
      const { rows } = await client.query(
        'SELECT created_by FROM public.employee_supervisor_ktu_access WHERE employee_id = $1', [SUPERVISOR],
      );
      expect(rows).toEqual([{ created_by: null }]);
      await expect(setSupervisorKtuGrant(client, EMPLOYEE, false, null)).resolves.toBe(true);
      await expect(setSupervisorKtuGrant(client, EMPLOYEE, false, null)).resolves.toBe(false);
      await client.query('DELETE FROM public.user_profiles WHERE employee_id = $1', [SUPERVISOR]);
      await client.query('DELETE FROM public.employees WHERE id = $1', [SUPERVISOR]);
      await expect(loadSupervisorKtuGrant(SUPERVISOR)).resolves.toBe(false);
    } finally {
      client.release();
    }
  });
});

// Пул общий для обоих блоков: закрывается после всех тестов файла.
afterAll(async () => {
  await pg.pool?.end();
});
