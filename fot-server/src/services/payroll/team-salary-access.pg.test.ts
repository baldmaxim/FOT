import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// «Зарплата своих» в табеле (миграция 382) на настоящем PostgreSQL: миграция и повтор, fail-closed до миграции,
// запись и снятие, FK (сотрудник — CASCADE, автор — SET NULL), охват руководителя (только ручные full-привязки, с
// подотделами), состав месяца по истории назначений. Чтение бригад без записи (fixBrigades:false → peekBrigadeShares)
// проверяет brigade-salary.pg.test.ts. Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы-заглушки
// пересоздаются).

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
  hasTeamSalaryGrant,
  listTeamSalaryRootDepartmentNames,
  loadTeamSalaryGrant,
  resolveTeamSalaryDepartmentIds,
  setTeamSalaryGrant,
} = await import('./team-salary-access.service.js');
const { filterSalaryMonthMembers } = await import('./team-salary.service.js');

const MIGRATION_382 = readFileSync(
  fileURLToPath(new URL('../../../../docs/migrations/382_employee_team_salary_access.sql', import.meta.url)),
  'utf8',
);

const HEAD = 815;
const OTHER = 769;
const WORKER = 1001;
const GRANTOR = '11111111-1111-4111-8111-111111111111';
const DEPT_ROOT = 'aaaaaaaa-0000-4000-8000-000000000001';
const DEPT_CHILD = 'aaaaaaaa-0000-4000-8000-000000000002';
const DEPT_GRANDCHILD = 'aaaaaaaa-0000-4000-8000-000000000003';
const DEPT_VIEW = 'aaaaaaaa-0000-4000-8000-000000000004';
const DEPT_DEPUTY = 'aaaaaaaa-0000-4000-8000-000000000005';
const DEPT_SIGUR = 'aaaaaaaa-0000-4000-8000-000000000006';
const DEPT_OTHER = 'aaaaaaaa-0000-4000-8000-000000000007';

const q = async (sql: string, params?: unknown[]) => (await pg.pool!.query(sql, params)).rows;

describe.skipIf(!PG_URL)('employee_team_salary_access (382) и охват руководителя', () => {
  beforeAll(async () => {
    await q(`
      DROP TABLE IF EXISTS public.employee_team_salary_access, public.employee_department_access,
        public.employee_assignments, public.employee_dismissal_events CASCADE;
      DROP TABLE IF EXISTS public.org_departments CASCADE;
      DROP TABLE IF EXISTS public.employees CASCADE;
      DROP TABLE IF EXISTS public.user_profiles CASCADE;
      CREATE TABLE public.employees (id bigint PRIMARY KEY);
      CREATE TABLE public.user_profiles (id uuid PRIMARY KEY);
      CREATE TABLE public.org_departments (id uuid PRIMARY KEY, parent_id uuid, name text);
      CREATE TABLE public.employee_department_access (
        employee_id bigint, department_id uuid, source text, is_active boolean, access_level text);
      CREATE TABLE public.employee_assignments (
        employee_id bigint, org_department_id uuid, effective_from date, effective_to date);
      CREATE TABLE public.employee_dismissal_events (
        employee_id bigint, from_department_id uuid, dismissal_date date, cancelled boolean DEFAULT false,
        created_at timestamptz DEFAULT now());
      CREATE OR REPLACE FUNCTION public.get_descendant_department_ids(p_root_ids uuid[])
      RETURNS TABLE(id uuid) LANGUAGE sql STABLE AS $$
        WITH RECURSIVE tree AS (
          SELECT d.id, d.parent_id FROM org_departments d WHERE d.id = ANY(p_root_ids)
          UNION ALL
          SELECT d.id, d.parent_id FROM org_departments d JOIN tree t ON d.parent_id = t.id
        )
        SELECT t.id FROM tree t;
      $$;
      INSERT INTO public.employees (id) VALUES (${HEAD}), (${OTHER}), (${WORKER}), (1002), (1003), (1004), (1005);
      INSERT INTO public.user_profiles (id) VALUES ('${GRANTOR}');
      INSERT INTO public.org_departments (id, parent_id, name) VALUES
        ('${DEPT_ROOT}', NULL, 'Гарантийный отдел'),
        ('${DEPT_CHILD}', '${DEPT_ROOT}', 'Гарантийный — участок 1'),
        ('${DEPT_GRANDCHILD}', '${DEPT_CHILD}', 'Гарантийный — бригада'),
        ('${DEPT_VIEW}', NULL, 'Просмотр'),
        ('${DEPT_DEPUTY}', NULL, 'Заместитель'),
        ('${DEPT_SIGUR}', NULL, 'Членство Sigur'),
        ('${DEPT_OTHER}', NULL, 'Чужой отдел');
      INSERT INTO public.employee_department_access (employee_id, department_id, source, is_active, access_level) VALUES
        (${HEAD}, '${DEPT_ROOT}', 'manual_admin_ui', true, 'full'),
        (${HEAD}, '${DEPT_VIEW}', 'manual_admin_ui', true, 'view'),
        (${HEAD}, '${DEPT_DEPUTY}', 'manual_admin_ui', true, 'deputy'),
        (${HEAD}, '${DEPT_SIGUR}', 'sigur_sync', true, 'full'),
        (${HEAD}, '${DEPT_OTHER}', 'manual_admin_ui', false, 'full');
    `);
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('до миграции: проверка права и охват — нет доступа, а не ошибка', async () => {
    await expect(hasTeamSalaryGrant(HEAD)).resolves.toBe(false);
    await expect(resolveTeamSalaryDepartmentIds(HEAD)).resolves.toEqual([]);
  });

  it('миграция применяется и повторяется; таблица пустая — доступа нет ни у кого', async () => {
    await q(MIGRATION_382);
    await q(MIGRATION_382);
    expect(await q('SELECT count(*)::int AS n FROM public.employee_team_salary_access')).toEqual([{ n: 0 }]);
    await expect(resolveTeamSalaryDepartmentIds(HEAD)).resolves.toEqual([]);
  });

  it('поставить, повторить без изменений, снять, снять ещё раз', async () => {
    const client = await pg.pool!.connect();
    try {
      await expect(setTeamSalaryGrant(client, HEAD, true, GRANTOR)).resolves.toBe(true);
      await expect(loadTeamSalaryGrant(HEAD)).resolves.toBe(true);
      await expect(hasTeamSalaryGrant(OTHER)).resolves.toBe(false);
      await expect(setTeamSalaryGrant(client, HEAD, true, GRANTOR)).resolves.toBe(false);
      await expect(setTeamSalaryGrant(client, HEAD, false, GRANTOR)).resolves.toBe(true);
      await expect(setTeamSalaryGrant(client, HEAD, false, GRANTOR)).resolves.toBe(false);
      await expect(hasTeamSalaryGrant(HEAD)).resolves.toBe(false);
    } finally {
      client.release();
    }
  });

  it('охват: только ручные full-привязки с подотделами; view, deputy, sigur_sync и неактивная — нет', async () => {
    await q(`INSERT INTO public.employee_team_salary_access (employee_id, created_by) VALUES (${HEAD}, '${GRANTOR}')`);
    expect((await resolveTeamSalaryDepartmentIds(HEAD)).sort()).toEqual([DEPT_ROOT, DEPT_CHILD, DEPT_GRANDCHILD].sort());
    expect(await listTeamSalaryRootDepartmentNames(HEAD)).toEqual(['Гарантийный отдел']);
    // Отделы есть, галочки нет — охват пуст.
    await expect(resolveTeamSalaryDepartmentIds(OTHER)).resolves.toEqual([]);
  });

  it('удаление учётки автора — created_by NULL, строка остаётся; удаление сотрудника — строка уходит', async () => {
    await q(`DELETE FROM public.user_profiles WHERE id = '${GRANTOR}'`);
    expect(await q(`SELECT created_by FROM public.employee_team_salary_access WHERE employee_id = ${HEAD}`))
      .toEqual([{ created_by: null }]);
    await q(`INSERT INTO public.employee_team_salary_access (employee_id) VALUES (${OTHER})`);
    await q(`DELETE FROM public.employees WHERE id = ${OTHER}`);
    expect(await q(`SELECT employee_id FROM public.employee_team_salary_access ORDER BY employee_id`))
      .toEqual([{ employee_id: HEAD }]);
  });

  it('состав месяца: перевод внутри месяца, после месяца, с разрывом, без истории, уволенный из отдела', async () => {
    const subtree = [DEPT_ROOT, DEPT_CHILD, DEPT_GRANDCHILD];
    await q(`
      INSERT INTO public.employee_assignments (employee_id, org_department_id, effective_from, effective_to) VALUES
        -- 1001: перевод внутри октября из чужого в подотдел — свой.
        (1001, '${DEPT_OTHER}', '2026-01-01', '2026-10-14'),
        (1001, '${DEPT_CHILD}', '2026-10-15', NULL),
        -- 1002: перевод после октября (встык) — октябрь чужой.
        (1002, '${DEPT_OTHER}', '2026-01-01', '2026-10-31'),
        (1002, '${DEPT_ROOT}', '2026-11-01', NULL),
        -- 1003: перевод с разрывом в истории — октябрь чужой, ноябрьское назначение позже.
        (1003, '${DEPT_OTHER}', '2026-01-01', '2026-10-31'),
        (1003, '${DEPT_ROOT}', '2026-11-20', NULL),
        -- 1005: в октябре по истории чужой отдел, уволен из подотдела 20.10.
        (1005, '${DEPT_OTHER}', '2026-01-01', NULL);
      INSERT INTO public.employee_dismissal_events (employee_id, from_department_id, dismissal_date) VALUES
        (1005, '${DEPT_GRANDCHILD}', '2026-10-20'),
        -- 1003: отменённое увольнение из отдела не считается.
        (1003, '${DEPT_ROOT}', '2026-10-10');
      UPDATE public.employee_dismissal_events SET cancelled = true WHERE employee_id = 1003;
    `);
    // 1004 — без назначений за октябрь: остаётся по текущему отделу, как в сетке.
    expect(await filterSalaryMonthMembers([1001, 1002, 1003, 1004, 1005], subtree, '2026-10')).toEqual([1001, 1004, 1005]);
    // Ноябрь: 1002 и 1003 уже свои, 1005 — по истории в чужом отделе, увольнение не в ноябре.
    expect(await filterSalaryMonthMembers([1001, 1002, 1003, 1005], subtree, '2026-11')).toEqual([1001, 1002, 1003]);
  });
});
