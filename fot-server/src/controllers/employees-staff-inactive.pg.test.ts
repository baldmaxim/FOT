import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Статус «Неактивный» и разбивка ИТР / Рабочие / Остальные на настоящем PostgreSQL (миграция 381):
//  - миграция 381 идемпотентна, staff_inactive_by — ON DELETE SET NULL;
//  - «Активные» (working) без «Декрета»/«Архива» (и вложенных) и ручной метки; сотрудник без отдела — в «Активных»;
//  - разбивка: сумма категорий = total списка для working / all / fired, категории — по правилу (бригада, ИТР, СМ);
//  - признак, фасет и фильтр «Признака»; причина неактивности в строке;
//  - статус входа (account-status) по реальному SQL; перевод и возврат: условный UPDATE, отзыв токенов кроме служебной
//    учётки, отказы 409, гонка двух возвратов.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы пересоздаются). Не параллельно с другими
// PG-тестами кадров: таблицы общие.

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

const h = vi.hoisted(() => ({ audit: vi.fn(), blockUserSockets: vi.fn() }));
vi.mock('../services/audit.service.js', () => ({
  auditService: {
    logFromRequest: vi.fn(async () => undefined),
    logFromRequestWithClient: h.audit,
  },
}));
vi.mock('../socket/io-instance.js', () => ({ blockUserSockets: h.blockUserSockets }));
vi.mock('../services/employee-scope-filter.service.js', () => ({
  resolveEmployeeListReadScope: vi.fn(async () => ({ scope: 'all', globalRead: true })),
  resolveEmployeeListScopeFilter: vi.fn(),
}));
vi.mock('../services/data-scope.service.js', () => ({
  normalizeUuidParam: (value: unknown) => (typeof value === 'string' && value ? value : null),
  resolveManagedDepartmentIds: vi.fn(async () => []),
  resolveScopedDepartmentId: vi.fn(),
  canAccessEmployeeInScope: vi.fn(async () => true),
  canWriteEmployeeInScope: vi.fn(async () => true),
  resolveWritableScopedDepartmentId: vi.fn(),
}));
vi.mock('../services/department-access.service.js', () => ({ listExplicitDepartmentIdsForUser: vi.fn(async () => []) }));
vi.mock('../services/employee-direct-reports.service.js', () => ({ listDirectSubordinates: vi.fn(async () => []) }));
// Дерево отделов — из тестовой БД на каждый вызов (без кэша): правило «Декрет»/«Архив» видит настоящие отделы.
vi.mock('../services/skud-shared.service.js', () => ({
  collectDeptIds: vi.fn(async (id: string) => [id]),
  getAllDepartmentsTree: vi.fn(async () => (await pg.pool!.query(
    'SELECT id, parent_id, name, NULL::int AS sigur_department_id FROM org_departments',
  )).rows),
}));
vi.mock('../services/employee-archive-department.service.js', () => ({
  getKnownArchiveDepartment: vi.fn(async () => null),
  reconcileFiredEmployeesArchiveDepartment: vi.fn(),
}));
vi.mock('../services/employee-main-object-snapshot.service.js', () => ({
  loadActiveSnapshotRun: vi.fn(async () => null),
  loadMainObjects: vi.fn(async () => ({ objects: new Map(), source: 'snapshot' })),
}));
vi.mock('./employees-export.controller.js', () => ({
  resolveExportPeriod: () => ({ start: '2026-11-01', end: '2026-11-26' }),
}));

import { respondEmployeesPage } from './employees-list-paginated.helpers.js';
import { employeesStaffController } from './employees-staff.controller.js';
import { deactivateEmployee, reactivateEmployee } from './employee-inactive.controller.js';
import { getProfileAccessState, resolveEmploymentBlock } from '../services/account-status.service.js';
import type { AuthenticatedRequest } from '../types/index.js';
import type { Response } from 'express';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../docs/migrations/', import.meta.url));
const migration = (file: string): string => readFileSync(`${MIGRATIONS_DIR}${file}`, 'utf8');

const q = async <T extends import('pg').QueryResultRow>(sql: string, params?: unknown[]) =>
  (await pg.pool!.query<T>(sql, params)).rows;

// Корни компаний — как в employees-export.service.ts (раздел и бригады определяются по ним).
const SU10 = '2cd8a403-6454-408b-9c2b-8a2db65c7511';
const SM = '6c4a3726-4ba9-4550-9978-c5ff50e4f77b';
const dep = (n: number) => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`;
const ROOT = dep(1);
const PTO = dep(2);
const DECRET = dep(3);
const DECRET_SUB = dep(4);
const ARCHIVE = dep(5);
const BRIGADES = dep(6);
const BR_ORTIKOV = dep(7);
const SM_OAT = dep(8);
const FIRED_FOLDER = dep(9);

const pos = (n: number) => `00000000-0000-0000-0000-00000000aa${String(n).padStart(2, '0')}`;
const ENGINEER = pos(1);
const PAINTER = pos(2);
const COMMANDANT = pos(3);
const DRIVER = pos(4);

const CHEPIKOV = '00000000-0000-0000-0000-0000000000c1';
const OTHER_ADMIN = '00000000-0000-0000-0000-0000000000c2';
const HOUSING = '00000000-0000-0000-0000-0000000000c3';
const DECRET_USER = '00000000-0000-0000-0000-0000000000c4';
const MANUAL_USER = '00000000-0000-0000-0000-0000000000c5';
const MANUAL_SERVICE = '00000000-0000-0000-0000-0000000000c6';

const makeReq = (query: Record<string, string>, extra: Partial<{ params: object; user: object }> = {}): AuthenticatedRequest => ({
  user: { id: CHEPIKOV, is_admin: true, employee_id: null },
  query,
  params: {},
  body: {},
  ip: '127.0.0.1',
  headers: {},
  socket: {},
  ...extra,
}) as unknown as AuthenticatedRequest;

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; return res; },
    setHeader() { /* noop */ },
  };
  return res;
};

type ListRow = { id: number; sign: string; staff_inactive_at: string | null; inactive_department_name: string | null };

const listAll = async (status: string, extra: Record<string, string> = {}) => {
  const res = makeRes();
  await respondEmployeesPage(makeReq({ page: '1', pageSize: '1000', view: 'staff', status, ...extra }), res as unknown as Response, Date.now());
  expect(res.statusCode).toBe(200);
  return res.body as { data: ListRow[]; meta: { total: number } };
};

const counts = async (status: string, extra: Record<string, string> = {}) => {
  const res = makeRes();
  await employeesStaffController.getCategoryCounts(makeReq({ status, ...extra }), res as unknown as Response);
  expect(res.statusCode).toBe(200);
  return (res.body as { data: { total: number; itr: number; worker: number; other: number } }).data;
};

const ids = (rows: ListRow[]) => rows.map(row => row.id).sort((a, b) => a - b);

describe.skipIf(!PG_URL)('«Неактивный» и разбивка ИТР / Рабочие / Остальные на PostgreSQL', () => {
  beforeAll(async () => {
    await q(`
      DROP TABLE IF EXISTS employee_staff_comments, employees, org_departments, positions, user_profiles,
                           employee_schedule_assignments, work_schedules, system_roles, employee_dismissal_events,
                           employee_department_access, user_employee_access CASCADE;
      DROP SCHEMA IF EXISTS app_auth CASCADE;
      CREATE SCHEMA app_auth;
      CREATE TABLE app_auth.users (id uuid PRIMARY KEY, email text, is_disabled boolean DEFAULT false);
      CREATE TABLE user_profiles (
        id uuid PRIMARY KEY, full_name text, employee_id integer, system_role_id uuid,
        token_version integer NOT NULL DEFAULT 0, updated_at timestamptz DEFAULT now()
      );
      CREATE TABLE org_departments (id uuid PRIMARY KEY, parent_id uuid, name text, kind text, is_active boolean NOT NULL DEFAULT true);
      CREATE TABLE system_roles (id uuid PRIMARY KEY, code text NOT NULL);
      CREATE TABLE employee_department_access (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id integer NOT NULL, department_id uuid NOT NULL,
        is_active boolean NOT NULL DEFAULT true, access_level text NOT NULL DEFAULT 'full',
        source text NOT NULL DEFAULT 'manual'
      );
      CREATE TABLE user_employee_access (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, employee_id integer NOT NULL,
        is_active boolean NOT NULL DEFAULT true
      );
      CREATE TABLE positions (id uuid PRIMARY KEY, name text);
      CREATE TABLE work_schedules (id uuid PRIMARY KEY, name text, is_default boolean);
      CREATE TABLE employees (
        id integer PRIMARY KEY, full_name text, org_department_id uuid, position_id uuid, email text,
        employment_status text NOT NULL DEFAULT 'active', department_locked boolean DEFAULT false,
        is_archived boolean NOT NULL DEFAULT false, archived_at timestamptz, created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(), excluded_from_timesheet boolean DEFAULT false,
        excluded_from_timesheet_at timestamptz, hire_date date, birth_date date, dismissal_date date,
        sigur_employee_id integer
      );
      CREATE TABLE employee_dismissal_events (
        id serial PRIMARY KEY, employee_id integer NOT NULL, from_department_id uuid, cancelled boolean,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE employee_schedule_assignments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id integer, schedule_id uuid,
        effective_from date, effective_to date
      );
    `);
    await q(migration('281_employee_staff_comments.sql'));

    await q(`INSERT INTO org_departments (id, parent_id, name, kind) VALUES
      ($1, NULL, 'Объект', 'object'),
      ($2, $1, '(СУ-10) ООО СУ-10', NULL),
      ($3, $2, 'ПТО', NULL),
      ($4, $2, ' Декрет ', NULL),
      ($5, $4, 'Группа', NULL),
      ($6, $2, 'Архив', NULL),
      ($7, $2, 'Бригады', NULL),
      ($8, $7, 'бр.Ортиков Шавкат А.', 'brigade'),
      ($9, $1, '(СМ) Служба Механизации', NULL),
      ($10, $9, 'ОАТ', NULL),
      ($11, $1, 'Уволенные', NULL)`,
    [ROOT, SU10, PTO, DECRET, DECRET_SUB, ARCHIVE, BRIGADES, BR_ORTIKOV, SM, SM_OAT, FIRED_FOLDER]);
    await q(`INSERT INTO positions VALUES ($1, 'инженер'), ($2, 'Маляр'), ($3, 'Комендант объекта'), ($4, 'Водитель')`,
      [ENGINEER, PAINTER, COMMANDANT, DRIVER]);

    // id → (ФИО, отдел, должность, статус)
    const employees: Array<[number, string, string | null, string | null, string]> = [
      [1, 'ИТР ПТО', PTO, ENGINEER, 'active'],
      [2, 'Комендант ПТО', PTO, COMMANDANT, 'active'],
      [3, 'Без должности', PTO, null, 'active'],
      [4, 'Маляр бригады', BR_ORTIKOV, PAINTER, 'active'],
      [5, 'Инженер в бригаде', BR_ORTIKOV, ENGINEER, 'active'],
      [6, 'Водитель СМ', SM_OAT, DRIVER, 'active'],
      [7, 'Инженер СМ', SM_OAT, ENGINEER, 'active'],
      [8, 'Декретная', DECRET, ENGINEER, 'active'],
      [9, 'Декретная вложенная', DECRET_SUB, PAINTER, 'active'],
      [10, 'Учет проживания сотрудников', ARCHIVE, COMMANDANT, 'active'],
      [11, 'Переводимый вручную', PTO, ENGINEER, 'active'],
      [12, 'Уволенный из бригады', FIRED_FOLDER, PAINTER, 'fired'],
      [13, 'Без отдела', null, ENGINEER, 'active'],
    ];
    for (const [id, name, dept, position, status] of employees) {
      await q('INSERT INTO employees (id, full_name, org_department_id, position_id, employment_status) VALUES ($1, $2, $3, $4, $5)',
        [id, name, dept, position, status]);
    }
    await q(`INSERT INTO employees (id, full_name, org_department_id, position_id, is_archived) VALUES (14, 'Архивная карточка', $1, $2, true)`, [PTO, ENGINEER]);
    await q('INSERT INTO employee_dismissal_events (employee_id, from_department_id, cancelled) VALUES (12, $1, false)', [BR_ORTIKOV]);

    await q(`INSERT INTO user_profiles (id, full_name, employee_id, token_version) VALUES
      ($1, 'Чепиков П. В.', NULL, 0), ($2, 'Другой админ', NULL, 0), ($3, 'Учет проживания сотрудников', 10, 0),
      ($4, 'Декретная', 8, 0), ($5, 'Переводимый вручную', 11, 0), ($6, 'Служебная учётка переводимого', 11, 0)`,
    [CHEPIKOV, OTHER_ADMIN, HOUSING, DECRET_USER, MANUAL_USER, MANUAL_SERVICE]);
    await q('INSERT INTO app_auth.users (id, email) SELECT id, id::text || \'@test\' FROM user_profiles');
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('миграция 381 применяется повторно; флаги учёток — только SQL', async () => {
    await q(migration('381_employee_staff_inactive.sql'));
    await q(migration('381_employee_staff_inactive.sql'));
    const columns = await q<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns
        WHERE column_name IN ('staff_inactive_at', 'staff_inactive_by', 'can_manage_staff_inactive', 'login_when_staff_inactive')
        ORDER BY table_name, column_name`,
    );
    expect(columns.map(c => `${c.table_name}.${c.column_name}:${c.is_nullable}:${c.column_default ?? ''}`)).toEqual([
      'employees.staff_inactive_at:YES:',
      'employees.staff_inactive_by:YES:',
      'user_profiles.can_manage_staff_inactive:NO:false',
      'user_profiles.login_when_staff_inactive:NO:false',
    ]);
    await q('UPDATE user_profiles SET can_manage_staff_inactive = true WHERE id = $1', [CHEPIKOV]);
    await q('UPDATE user_profiles SET login_when_staff_inactive = true WHERE id = ANY($1::uuid[])', [[HOUSING, MANUAL_SERVICE]]);
  });

  it('staff_inactive_by: удаление учётки автора — SET NULL, метка остаётся', async () => {
    const temp = '00000000-0000-0000-0000-0000000000c9';
    await q('INSERT INTO user_profiles (id, full_name) VALUES ($1, \'Временный\')', [temp]);
    await q('INSERT INTO employees (id, full_name, staff_inactive_at, staff_inactive_by) VALUES (90, \'Временный сотрудник\', now(), $1)', [temp]);
    await q('DELETE FROM user_profiles WHERE id = $1', [temp]);
    const [row] = await q<{ at: Date | null; by: string | null }>('SELECT staff_inactive_at AS at, staff_inactive_by AS by FROM employees WHERE id = 90');
    expect(row.at).not.toBeNull();
    expect(row.by).toBeNull();
    await q('DELETE FROM employees WHERE id = 90');
  });

  it('статус входа по реальному SQL: «Декрет» закрыт, служебная учётка в «Архиве» — открыта, без карточки — открыт', async () => {
    const decret = await getProfileAccessState(DECRET_USER);
    expect(decret).toMatchObject({ employmentStatus: 'active', staffInactive: true, loginWhenStaffInactive: false });
    expect(resolveEmploymentBlock(decret!)?.code).toBe('EMPLOYEE_INACTIVE');

    const housing = await getProfileAccessState(HOUSING);
    expect(housing).toMatchObject({ staffInactive: true, loginWhenStaffInactive: true });
    expect(resolveEmploymentBlock(housing!)).toBeNull();

    const noCard = await getProfileAccessState(CHEPIKOV);
    expect(noCard).toMatchObject({ employmentStatus: null, staffInactive: false });
    expect(resolveEmploymentBlock(noCard!)).toBeNull();

    const manual = await getProfileAccessState(MANUAL_USER);
    expect(resolveEmploymentBlock(manual!)).toBeNull();
  });

  it('перевод: без флага учётки — 403; отказы 409 по состоянию; успешный — отзыв токенов, кроме служебной учётки', async () => {
    h.audit.mockReset().mockResolvedValue(undefined);
    h.blockUserSockets.mockReset();

    let res = makeRes();
    await deactivateEmployee(makeReq({}, { params: { id: '11' }, user: { id: OTHER_ADMIN, is_admin: true, employee_id: null } }), res as unknown as Response);
    expect(res.statusCode).toBe(403);

    for (const [id, code] of [['8', 'INACTIVE_BY_DEPARTMENT'], ['9', 'INACTIVE_BY_DEPARTMENT'], ['12', 'EMPLOYEE_FIRED']] as const) {
      res = makeRes();
      await deactivateEmployee(makeReq({}, { params: { id } }), res as unknown as Response);
      expect(res.statusCode, `сотрудник ${id}`).toBe(409);
      expect(res.body).toMatchObject({ code });
    }
    expect((res.body as { error: string }).error).toBe('Сотрудник уволен');

    res = makeRes();
    await deactivateEmployee(makeReq({}, { params: { id: '11' } }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const [row] = await q<{ at: Date | null; by: string | null }>('SELECT staff_inactive_at AS at, staff_inactive_by AS by FROM employees WHERE id = 11');
    expect(row.at).not.toBeNull();
    expect(row.by).toBe(CHEPIKOV);
    const versions = await q<{ id: string; token_version: number }>('SELECT id, token_version FROM user_profiles WHERE employee_id = 11 ORDER BY id');
    expect(Object.fromEntries(versions.map(v => [v.id, v.token_version]))).toEqual({ [MANUAL_USER]: 1, [MANUAL_SERVICE]: 0 });
    expect(h.blockUserSockets).toHaveBeenCalledWith([MANUAL_USER], expect.objectContaining({ code: 'EMPLOYEE_INACTIVE' }));
    expect(h.audit).toHaveBeenCalledTimes(1);

    const manual = await getProfileAccessState(MANUAL_USER);
    expect(resolveEmploymentBlock(manual!)?.code).toBe('EMPLOYEE_INACTIVE');
    expect(resolveEmploymentBlock((await getProfileAccessState(MANUAL_SERVICE))!)).toBeNull();

    res = makeRes();
    await deactivateEmployee(makeReq({}, { params: { id: '11' } }), res as unknown as Response);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'ALREADY_INACTIVE' });
  });

  it('«Активные»: без «Декрета», «Архива», вложенных и ручной метки; без отдела — остаётся', async () => {
    const working = await listAll('working');
    expect(ids(working.data)).toEqual([1, 2, 3, 4, 5, 6, 7, 13]);
    expect(working.meta.total).toBe(8);
    // Прежний active (окна выбора сотрудника) — по-прежнему все неуволенные.
    expect(ids((await listAll('active')).data)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13]);
    expect(ids((await listAll('fired')).data)).toEqual([12]);
    expect(ids((await listAll('all')).data)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });

  it('признак и причина неактивности в строке', async () => {
    const rows = new Map((await listAll('all')).data.map(row => [row.id, row]));
    expect(rows.get(8)).toMatchObject({ sign: 'Неактивен', inactive_department_name: 'Декрет', staff_inactive_at: null });
    expect(rows.get(9)).toMatchObject({ sign: 'Неактивен', inactive_department_name: 'Декрет' });
    expect(rows.get(10)).toMatchObject({ sign: 'Неактивен', inactive_department_name: 'Архив' });
    expect(rows.get(11)).toMatchObject({ sign: 'Неактивен', inactive_department_name: null });
    expect(rows.get(11)!.staff_inactive_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(rows.get(12)).toMatchObject({ sign: 'Уволен', inactive_department_name: null });
    expect(rows.get(13)).toMatchObject({ sign: 'Работает' });
  });

  it('разбивка: сумма = total списка; категории по правилу (бригада → Рабочие, ИТР-должность, СМ → Рабочие)', async () => {
    expect(await counts('working')).toEqual({ total: 8, itr: 3, worker: 3, other: 2 });
    // «Все»: + Декретная-инженер (ИТР), вложенная-маляр и комендант «Архива» (Остальные), переведённый (ИТР),
    // уволенный из бригады — по отделу до увольнения (Рабочие).
    expect(await counts('all')).toEqual({ total: 13, itr: 5, worker: 4, other: 4 });
    expect(await counts('fired')).toEqual({ total: 1, itr: 0, worker: 1, other: 0 });
    for (const status of ['working', 'all', 'fired']) {
      const c = await counts(status);
      expect(c.itr + c.worker + c.other, status).toBe(c.total);
      expect(c.total, status).toBe((await listAll(status)).meta.total);
    }
  });

  it('фасет и фильтр «Признака»: «Неактивен» — одно значение для «Декрета», «Архива» и ручной метки', async () => {
    const res = makeRes();
    await employeesStaffController.getColumnValues(makeReq({ column: 'sign', status: 'all' }), res as unknown as Response);
    expect((res.body as { data: { values: Array<{ value: string; count: number }> } }).data.values).toEqual([
      { value: 'Неактивен', count: 4 },
      { value: 'Работает', count: 8 },
      { value: 'Уволен', count: 1 },
    ]);
    const cf = JSON.stringify({ values: { sign: ['Неактивен'] } });
    expect(ids((await listAll('all', { cf })).data)).toEqual([8, 9, 10, 11]);
    expect(await counts('all', { cf })).toEqual({ total: 4, itr: 2, worker: 0, other: 2 });
  });

  it('возврат: два одновременных — один 200, второй 409; токены после возврата не откатываются', async () => {
    h.audit.mockReset().mockResolvedValue(undefined);
    const [a, b] = [makeRes(), makeRes()];
    await Promise.all([
      reactivateEmployee(makeReq({}, { params: { id: '11' } }), a as unknown as Response),
      reactivateEmployee(makeReq({}, { params: { id: '11' } }), b as unknown as Response),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(h.audit).toHaveBeenCalledTimes(1);
    const [row] = await q<{ at: Date | null; by: string | null }>('SELECT staff_inactive_at AS at, staff_inactive_by AS by FROM employees WHERE id = 11');
    expect(row).toEqual({ at: null, by: null });
    const [profile] = await q<{ token_version: number }>('SELECT token_version FROM user_profiles WHERE id = $1', [MANUAL_USER]);
    expect(profile.token_version).toBe(1);
    expect(ids((await listAll('working')).data)).toEqual([1, 2, 3, 4, 5, 6, 7, 11, 13]);
  });

  it('метка + «Декрет»: возврат снимает метку и называет ветку; сотрудник остаётся неактивным', async () => {
    await q('UPDATE employees SET staff_inactive_at = now(), staff_inactive_by = $1 WHERE id = 9', [CHEPIKOV]);
    const res = makeRes();
    await reactivateEmployee(makeReq({}, { params: { id: '9' } }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: { id: 9, inactive_department_name: 'Декрет' } });
    expect(ids((await listAll('working')).data)).not.toContain(9);
  });
});
