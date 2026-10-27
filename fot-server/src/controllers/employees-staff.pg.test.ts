import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// «Управление кадрами» на настоящем PostgreSQL: миграция 281 идемпотентна; обход всех порций
// по курсору с сортировкой не теряет и не повторяет строк (одинаковые ключи, NULL, обе стороны);
// конкурентные первые комментарии не перезаписывают друг друга. Запускается только при
// FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы пересоздаются).

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

const audit = vi.hoisted(() => ({ withClient: vi.fn() }));
vi.mock('../services/audit.service.js', () => ({
  auditService: {
    logFromRequest: vi.fn(async () => undefined),
    logFromRequestWithClient: audit.withClient,
  },
}));
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
vi.mock('../services/skud-shared.service.js', () => ({
  collectDeptIds: vi.fn(async (id: string) => [id]),
  getAllDepartmentsTree: vi.fn(async () => []),
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
  resolveExportPeriod: () => ({ start: '2026-08-17', end: '2026-09-15' }),
}));

import ExcelJS from 'exceljs';
import { respondEmployeesPage } from './employees-list-paginated.helpers.js';
import { employeesStaffController } from './employees-staff.controller.js';
import { saveStaffComment } from '../services/employee-staff-comment.service.js';
import { buildFioSearch, fioExactConditionSql, fioFuzzyConditionSql } from '../utils/fio-search.utils.js';
import type { AuthenticatedRequest } from '../types/index.js';
import type { Request, Response } from 'express';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../docs/migrations/', import.meta.url));
const migration281 = (): string => readFileSync(`${MIGRATIONS_DIR}281_employee_staff_comments.sql`, 'utf8');

const q = async <T extends import('pg').QueryResultRow>(sql: string, params?: unknown[]) =>
  (await pg.pool!.query<T>(sql, params)).rows;

const D1 = '00000000-0000-0000-0000-0000000000d1';
const D2 = '00000000-0000-0000-0000-0000000000d2';
const U1 = '00000000-0000-0000-0000-0000000000f1';
const U2 = '00000000-0000-0000-0000-0000000000f2';
const EMPLOYEES = 23;

const makeReq = (query: Record<string, string>): AuthenticatedRequest => ({
  user: { id: U1, is_admin: true, employee_id: null },
  query,
  params: {},
  body: {},
  ip: '127.0.0.1',
  headers: {},
  socket: {},
}) as unknown as AuthenticatedRequest;

const callPage = async (query: Record<string, string>) => {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; return res; },
  };
  await respondEmployeesPage(makeReq(query), res as unknown as Response, Date.now());
  return res as { statusCode: number; body: { data: Array<{ id: number }>; meta: { total: number; next_cursor: null | { key: string | null; isNull: boolean; id: number } } } };
};

/** Все порции по курсору с сортировкой → id в порядке выдачи. */
const traverse = async (
  sort: string,
  dir: 'asc' | 'desc',
  pageSize: number,
  extra: Record<string, string> = {},
  total = EMPLOYEES,
): Promise<number[]> => {
  const ids: number[] = [];
  let cursor: { key: string | null; isNull: boolean; id: number } | null = null;
  for (let guard = 0; guard < 100; guard += 1) {
    const query: Record<string, string> = { page: '1', keyset: '1', view: 'staff', pageSize: String(pageSize), sort, dir, ...extra };
    if (cursor) {
      query.after_id = String(cursor.id);
      query.after_null = cursor.isNull ? '1' : '0';
      if (!cursor.isNull && cursor.key !== null) query.after_key = cursor.key;
    }
    const res = await callPage(query);
    expect(res.statusCode).toBe(200);
    expect(res.body.meta.total).toBe(total);
    ids.push(...res.body.data.map(row => row.id));
    cursor = res.body.meta.next_cursor;
    if (!cursor) return ids;
  }
  throw new Error('курсор не завершился');
};

describe.skipIf(!PG_URL)('«Управление кадрами» на PostgreSQL', () => {
  beforeAll(async () => {
    await q(`
      DROP TABLE IF EXISTS employee_staff_comments, employees, org_departments, positions, user_profiles,
                           employee_schedule_assignments, work_schedules, system_roles,
                           employee_department_access, user_employee_access CASCADE;
      CREATE TABLE user_profiles (id uuid PRIMARY KEY, full_name text, employee_id integer, system_role_id uuid);
      CREATE TABLE org_departments (id uuid PRIMARY KEY, name text, is_active boolean NOT NULL DEFAULT true);
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
      CREATE TABLE employee_schedule_assignments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id integer, schedule_id uuid,
        effective_from date, effective_to date
      );
    `);
    await q(`INSERT INTO user_profiles VALUES ($1, 'Иванова И.'), ($2, 'Петров П.')`, [U1, U2]);
    await q(`INSERT INTO org_departments VALUES ($1, 'Бухгалтерия'), ($2, 'Склад')`, [D1, D2]);
    // Одинаковые ключи (много сотрудников в одном отделе), NULL-ключи (без отдела), одинаковые ФИО.
    for (let id = 1; id <= EMPLOYEES; id += 1) {
      const dept = id % 3 === 0 ? null : (id % 3 === 1 ? D1 : D2);
      const name = id % 5 === 0 ? 'Однофамилец А.' : `Сотрудник ${String(100 - id)}`;
      const hire = id % 4 === 0 ? null : `2026-0${1 + (id % 3)}-1${id % 2}`;
      await q('INSERT INTO employees (id, full_name, org_department_id, hire_date) VALUES ($1, $2, $3, $4)', [id, name, dept, hire]);
    }
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('миграция 281 применяется повторно без ошибок', async () => {
    await q(migration281());
    await q(migration281());
    const [row] = await q<{ n: string }>(`SELECT count(*)::text AS n FROM information_schema.tables WHERE table_name = 'employee_staff_comments'`);
    expect(row.n).toBe('1');
  });

  it('обход по курсору: каждая сортировка и направление — все строки ровно один раз, порядок = ORDER BY', async () => {
    // Комментарии у части сотрудников, включая одинаковые тексты.
    await q(`INSERT INTO employee_staff_comments (employee_id, comment, updated_by)
             SELECT id, CASE WHEN id % 2 = 0 THEN 'Общий' ELSE 'Личный ' || id END, $1::uuid
               FROM employees WHERE id % 4 <> 1
             ON CONFLICT (employee_id) DO NOTHING`, [U1]);
    for (const sort of ['name', 'department', 'hire_date', 'comment', 'sign', 'schedule']) {
      for (const dir of ['asc', 'desc'] as const) {
        const expected = (await q<{ id: number }>(
          `SELECT id FROM (
             SELECT e.id,
                    CASE $1 WHEN 'name' THEN NULLIF(btrim(e.full_name), '')
                            WHEN 'department' THEN (SELECT NULLIF(btrim(d.name), '') FROM org_departments d WHERE d.id = e.org_department_id)
                            WHEN 'hire_date' THEN to_char(e.hire_date, 'YYYY-MM-DD')
                            WHEN 'comment' THEN (SELECT NULLIF(btrim(c.comment), '') FROM employee_staff_comments c WHERE c.employee_id = e.id)
                            WHEN 'sign' THEN 'Работает'
                            ELSE NULL END AS k
               FROM employees e) x
           ORDER BY (k IS NULL), k ${dir}, id ${dir}`,
          [sort],
        )).map(row => Number(row.id));
        for (const pageSize of [1, 4, 7, 23, 50]) {
          const ids = await traverse(sort, dir, pageSize);
          expect(ids, `${sort} ${dir} по ${pageSize}`).toEqual(expected);
        }
      }
    }
  });

  it('строка, добавленная между порциями перед курсором, не сдвигает следующую порцию', async () => {
    const first = await callPage({ page: '1', keyset: '1', view: 'staff', pageSize: '5', sort: 'department', dir: 'asc' });
    const cursor = first.body.meta.next_cursor!;
    await q(`INSERT INTO employees (id, full_name, org_department_id) VALUES (900, 'Новый', $1)`, [D1]);
    try {
      const second = await callPage({
        page: '1', keyset: '1', view: 'staff', pageSize: '5', sort: 'department', dir: 'asc',
        after_id: String(cursor.id), after_null: cursor.isNull ? '1' : '0', ...(cursor.key !== null ? { after_key: cursor.key } : {}),
      });
      const seen = new Set(first.body.data.map(row => row.id));
      expect(second.body.data.some(row => seen.has(row.id))).toBe(false);
    } finally {
      await q('DELETE FROM employees WHERE id = 900');
    }
  });

  it('конкурентные «первые» комментарии: один сохраняется, второй — конфликт; повтор — no-op', async () => {
    audit.withClient.mockReset().mockResolvedValue(undefined);
    await q('DELETE FROM employee_staff_comments WHERE employee_id = 1');
    const req = { ip: '127.0.0.1', headers: {}, socket: {} } as unknown as Request;

    const results = await Promise.all([
      saveStaffComment({ req, userId: U1, employeeId: 1, comment: 'От Ивановой', expectedUpdatedAt: null }),
      saveStaffComment({ req, userId: U2, employeeId: 1, comment: 'От Петрова', expectedUpdatedAt: null }),
    ]);
    const statuses = results.map(result => result.status).sort();
    expect(statuses).toEqual(['conflict', 'ok']);
    expect(audit.withClient).toHaveBeenCalledTimes(1);

    const winner = results.find(result => result.status === 'ok');
    if (winner?.status !== 'ok' || !winner.current) throw new Error('нет сохранённого комментария');
    const [stored] = await q<{ comment: string }>('SELECT comment FROM employee_staff_comments WHERE employee_id = 1');
    expect(stored.comment).toBe(winner.current.comment);

    // Та же версия и тот же текст — без записи и аудита; версия с микросекундами совпадает.
    const repeat = await saveStaffComment({
      req, userId: U1, employeeId: 1, comment: winner.current.comment, expectedUpdatedAt: winner.current.updated_at,
    });
    expect(repeat).toMatchObject({ status: 'ok', changed: false });
    expect(audit.withClient).toHaveBeenCalledTimes(1);

    // Удаление по актуальной версии, затем повтор удаления со старой версией — конфликт с current null.
    const removed = await saveStaffComment({ req, userId: U1, employeeId: 1, comment: '', expectedUpdatedAt: winner.current.updated_at });
    expect(removed).toEqual({ status: 'ok', changed: true, current: null });
    const staleDelete = await saveStaffComment({ req, userId: U1, employeeId: 1, comment: '', expectedUpdatedAt: winner.current.updated_at });
    expect(staleDelete).toEqual({ status: 'conflict', current: null });
  });

  it('ошибка аудита откатывает запись комментария', async () => {
    audit.withClient.mockReset().mockRejectedValue(new Error('audit down'));
    const req = { ip: '127.0.0.1', headers: {}, socket: {} } as unknown as Request;
    await q('DELETE FROM employee_staff_comments WHERE employee_id = 2');
    await expect(saveStaffComment({ req, userId: U1, employeeId: 2, comment: 'Не сохранится', expectedUpdatedAt: null }))
      .rejects.toThrow('audit down');
    expect(await q('SELECT 1 FROM employee_staff_comments WHERE employee_id = 2')).toHaveLength(0);
  });

  it('счётчики месяца и выгрузка: реальный SQL, выгрузка совпадает с обходом списка', async () => {
    const monthStart = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' }).slice(0, 8) + '01';
    await q(`INSERT INTO employees (id, full_name, hire_date, employment_status) VALUES (801, 'Принят', $1::date, 'active')`, [monthStart]);
    await q(`INSERT INTO employees (id, full_name, dismissal_date, employment_status) VALUES (802, 'Уволен', $1::date, 'fired')`, [monthStart]);
    try {
      const res = {
        statusCode: 200, body: null as unknown, sent: null as Buffer | null,
        status(code: number) { res.statusCode = code; return res; },
        json(body: unknown) { res.body = body; return res; },
        setHeader: () => undefined,
        send(buffer: Buffer) { res.sent = buffer; return res; },
      };
      // Статус и период на счётчики не влияют.
      await employeesStaffController.getMonthMovement(makeReq({ status: 'fired', period: 'fired_month' }), res as unknown as Response);
      expect(res.body).toMatchObject({ data: { hired: 1, fired: 1 } });

      audit.withClient.mockReset().mockResolvedValue(undefined);
      await employeesStaffController.exportView(makeReq({ status: 'active', sort: 'department', dir: 'desc' }), res as unknown as Response);
      expect(res.statusCode).toBe(200);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(res.sent as unknown as ArrayBuffer);
      const ws = workbook.worksheets[0];
      const exportedNames = Array.from({ length: ws.rowCount - 1 }, (_, i) => String(ws.getRow(i + 2).getCell(2).value));

      const listed = await callPage({ page: '1', keyset: '1', view: 'staff', pageSize: '1000', sort: 'department', dir: 'desc' });
      expect(exportedNames).toEqual((listed.body.data as unknown as Array<{ full_name: string }>).map(row => row.full_name));
      expect(exportedNames).toContain('Принят');
      expect(exportedNames).not.toContain('Уволен');
      expect(audit.withClient).toHaveBeenCalledTimes(1);
    } finally {
      await q('DELETE FROM employees WHERE id IN (801, 802)');
    }
  });

  it('фильтры столбцов: обход по курсору = SQL-выборка, total совпадает, фасеты без своего столбца', async () => {
    const cf = { values: { department: ['Бухгалтерия', null] }, dates: { hire_date: { from: '2026-02-01', empty: true } } };
    const expected = (await q<{ id: number }>(
      `SELECT e.id FROM employees e LEFT JOIN org_departments d ON d.id = e.org_department_id
        WHERE (d.name = 'Бухгалтерия' OR e.org_department_id IS NULL)
          AND (e.hire_date >= '2026-02-01' OR e.hire_date IS NULL)
        ORDER BY (NULLIF(btrim(e.full_name), '') IS NULL), NULLIF(btrim(e.full_name), '') DESC, e.id DESC`,
    )).map(row => Number(row.id));
    expect(expected.length).toBeGreaterThan(2);

    for (const pageSize of [1, 3, 50]) {
      const ids: number[] = [];
      let cursor: { key: string | null; isNull: boolean; id: number } | null = null;
      for (let guard = 0; guard < 100; guard += 1) {
        const query: Record<string, string> = {
          page: '1', keyset: '1', view: 'staff', pageSize: String(pageSize), sort: 'name', dir: 'desc', cf: JSON.stringify(cf),
        };
        if (cursor) {
          query.after_id = String(cursor.id);
          query.after_null = cursor.isNull ? '1' : '0';
          if (!cursor.isNull && cursor.key !== null) query.after_key = cursor.key;
        }
        const res = await callPage(query);
        expect(res.statusCode).toBe(200);
        expect(res.body.meta.total).toBe(expected.length);
        ids.push(...res.body.data.map(row => row.id));
        cursor = res.body.meta.next_cursor;
        if (!cursor) break;
      }
      expect(ids, `по ${pageSize}`).toEqual(expected);
    }

    // Фасеты отдела: фильтр по отделу не применяется, фильтр по дате — применяется.
    const res = {
      statusCode: 200, body: null as unknown,
      status(code: number) { res.statusCode = code; return res; },
      json(body: unknown) { res.body = body; return res; },
    };
    await employeesStaffController.getColumnValues(makeReq({ column: 'department', cf: JSON.stringify(cf) }), res as unknown as Response);
    const facets = (res.body as { data: { values: Array<{ value: string | null; count: number }> } }).data.values;
    const expectedFacets = await q<{ value: string | null; count: number }>(
      `SELECT NULLIF(btrim(d.name), '') AS value, count(*)::int AS count
         FROM employees e LEFT JOIN org_departments d ON d.id = e.org_department_id
        WHERE (e.hire_date >= '2026-02-01' OR e.hire_date IS NULL)
        GROUP BY 1 ORDER BY 1 ASC NULLS LAST`,
    );
    expect(facets).toEqual(expectedFacets.map(row => ({ value: row.value, count: Number(row.count) })));
    expect(facets.map(f => f.value)).toContain('Склад');
  });

  it('участок: правило «По участкам», ячейка = ключ сортировки, курсор, фильтр по начальнику, фасеты, выгрузка', async () => {
    const R_SITE = '00000000-0000-0000-0000-00000000a001';
    const R_HEAD = '00000000-0000-0000-0000-00000000a002';
    await q(`INSERT INTO system_roles VALUES ($1, 'site_supervisor'), ($2, 'header')`, [R_SITE, R_HEAD]);
    // Начальники — без своего отдела. 703–708 — по разным причинам не начальники участка.
    const leaders: Array<[number, string, string, Partial<Record<'is_archived' | 'fired' | 'excluded', boolean>>]> = [
      [701, 'Журавлев Владимир Сергеевич', R_SITE, {}],
      [702, 'Пудовкин Александр Александрович', R_SITE, {}],
      [703, 'Архивный Начальник', R_SITE, { is_archived: true }],
      [704, 'Уволенный Начальник', R_SITE, { fired: true }],
      [705, 'Исключённый Начальник', R_SITE, { excluded: true }],
      [706, 'Синхронный Начальник', R_SITE, {}],
      [707, 'Неактивный Доступ', R_SITE, {}],
      [708, 'Руководитель Отдела', R_HEAD, {}],
      [709, 'Абаев Борис', R_SITE, {}],
    ];
    const profileOf = (id: number) => `00000000-0000-0000-0000-000000000${id}`;
    for (const [id, name, role, flags] of leaders) {
      await q(`INSERT INTO employees (id, full_name, is_archived, employment_status, excluded_from_timesheet)
               VALUES ($1, $2, $3, $4, $5)`, [id, name, flags.is_archived ?? false, flags.fired ? 'fired' : 'active', flags.excluded ?? false]);
      await q('INSERT INTO user_profiles (id, full_name, employee_id, system_role_id) VALUES ($1, $2, $3, $4)', [profileOf(id), name, id, role]);
    }
    await q(`INSERT INTO employee_department_access (employee_id, department_id, is_active, access_level, source) VALUES
               (701, $1, true, 'full', 'manual'), (702, $1, true, 'full', 'manual'), (702, $2, true, 'full', 'manual'),
               (703, $2, true, 'full', 'manual'), (704, $2, true, 'full', 'manual'), (705, $2, true, 'full', 'manual'),
               (706, $2, true, 'full', 'sigur_sync'), (707, $2, false, 'full', 'manual'), (707, $1, true, 'deputy', 'manual'),
               (708, $2, true, 'full', 'manual')`, [D1, D2]);
    // Личные назначения: 3 — без отдела, 4 — в D1 (объединение с начальниками отдела).
    await q('INSERT INTO user_employee_access (user_id, employee_id) VALUES ($1, 3), ($1, 4)', [profileOf(709)]);

    const expectedLabel = (id: number, dept: string | null): string | null => {
      if (id === 3) return 'Абаев Б.';
      if (id === 4) return 'Абаев Б., Журавлев В. С., Пудовкин А. А.';
      if (dept === D1) return 'Журавлев В. С., Пудовкин А. А.';
      if (dept === D2) return 'Пудовкин А. А.';
      return null;
    };
    const res = {
      statusCode: 200, body: null as unknown, sent: null as Buffer | null,
      status(code: number) { res.statusCode = code; return res; },
      json(body: unknown) { res.body = body; return res; },
      setHeader: () => undefined,
      send(buffer: Buffer) { res.sent = buffer; return res; },
    };
    try {
      const all = await callPage({ page: '1', keyset: '1', view: 'staff', pageSize: '1000' });
      const rows = all.body.data as unknown as Array<{ id: number; org_department_id: string | null; site_supervisor_names: string | null }>;
      expect(rows.length).toBe(all.body.meta.total);
      for (const row of rows) {
        expect(row.site_supervisor_names, `сотрудник ${row.id}`).toBe(expectedLabel(row.id, row.org_department_id));
      }
      const ids = rows.map(row => row.id);
      const labels = rows.map(row => row.site_supervisor_names);

      // Курсор по участку: равные ключи (весь D1), NULL в конце при обоих направлениях.
      for (const dir of ['asc', 'desc'] as const) {
        const expected = (await q<{ id: number }>(
          `SELECT id FROM unnest($1::int[], $2::text[]) AS x(id, k) ORDER BY (k IS NULL), k ${dir}, id ${dir}`,
          [ids, labels],
        )).map(row => Number(row.id));
        for (const pageSize of [1, 4, 7, 50]) {
          expect(await traverse('site', dir, pageSize, {}, rows.length), `site ${dir} по ${pageSize}`).toEqual(expected);
        }
      }

      // Фильтр по отдельному начальнику: личное назначение и отдел двух начальников попадают под каждого.
      const filtered = async (values: Array<string | null>) => {
        const page = await callPage({ page: '1', keyset: '1', view: 'staff', pageSize: '1000', cf: JSON.stringify({ values: { site: values } }) });
        expect(page.statusCode).toBe(200);
        return page.body.data.map(row => row.id).sort((a, b) => a - b);
      };
      const idsWith = (predicate: (label: string | null) => boolean) =>
        rows.filter(row => predicate(row.site_supervisor_names)).map(row => row.id).sort((a, b) => a - b);
      expect(await filtered(['Абаев Б.'])).toEqual([3, 4]);
      expect(await filtered(['Журавлев В. С.'])).toEqual(idsWith(label => label?.includes('Журавлев') ?? false));
      expect(await filtered(['Пудовкин А. А.'])).toEqual(idsWith(label => label?.includes('Пудовкин') ?? false));
      expect(await filtered([null])).toEqual(idsWith(label => label === null));
      expect(await filtered([null, 'Абаев Б.'])).toEqual(idsWith(label => label === null || label.includes('Абаев')));

      // Фасеты — по каждому начальнику; 703–708 в вариантах нет.
      await employeesStaffController.getColumnValues(makeReq({ column: 'site' }), res as unknown as Response);
      const facets = (res.body as { data: { values: Array<{ value: string | null; count: number }> } }).data.values;
      const countOf = (name: string) => labels.filter(label => label?.split(', ').includes(name)).length;
      expect(facets).toEqual([
        { value: 'Абаев Б.', count: countOf('Абаев Б.') },
        { value: 'Журавлев В. С.', count: countOf('Журавлев В. С.') },
        { value: 'Пудовкин А. А.', count: countOf('Пудовкин А. А.') },
        { value: null, count: labels.filter(label => label === null).length },
      ].sort((a, b) => (a.value === null ? 1 : b.value === null ? -1 : 0)));

      // Выгрузка с участком = список, отсортированный по участку.
      audit.withClient.mockReset().mockResolvedValue(undefined);
      await employeesStaffController.exportView(makeReq({ sort: 'site', dir: 'asc', columns: 'department,site' }), res as unknown as Response);
      expect(res.statusCode).toBe(200);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(res.sent as unknown as ArrayBuffer);
      const ws = workbook.worksheets[0];
      expect((ws.getRow(1).values as unknown[]).slice(1)).toEqual(['№', 'ФИО', 'Отдел', 'Участок', 'Признак']);
      const exported = Array.from({ length: ws.rowCount - 1 }, (_, i) => String(ws.getRow(i + 2).getCell(4).value ?? ''));
      const listed = await callPage({ page: '1', keyset: '1', view: 'staff', pageSize: '1000', sort: 'site', dir: 'asc' });
      expect(exported).toEqual((listed.body.data as unknown as Array<{ site_supervisor_names: string | null }>)
        .map(row => row.site_supervisor_names ?? ''));
    } finally {
      await q('DELETE FROM user_employee_access');
      await q('DELETE FROM employee_department_access');
      await q('DELETE FROM user_profiles WHERE employee_id IS NOT NULL');
      await q('DELETE FROM system_roles');
      await q('DELETE FROM employees WHERE id BETWEEN 701 AND 709');
    }
  });

  it('удаление профиля автора не удаляет комментарий (ON DELETE SET NULL)', async () => {
    const U3 = '00000000-0000-0000-0000-0000000000f3';
    await q(`INSERT INTO user_profiles VALUES ($1, 'Временный')`, [U3]);
    await q(`INSERT INTO employee_staff_comments (employee_id, comment, updated_by) VALUES (3, 'Текст', $1)
             ON CONFLICT (employee_id) DO UPDATE SET updated_by = EXCLUDED.updated_by`, [U3]);
    await q('DELETE FROM user_profiles WHERE id = $1', [U3]);
    const [row] = await q<{ updated_by: string | null }>('SELECT updated_by FROM employee_staff_comments WHERE employee_id = 3');
    expect(row.updated_by).toBeNull();
  });

  it('поиск по ФИО: ё/е, раскладка, пробелы, одна ошибка — по итоговому набору экрана', async () => {
    const monthStart = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' }).slice(0, 8) + '01';
    const rows: Array<[number, string, string, string | null, string | null, string | null]> = [
      [1001, 'Гринёв Андрей Александрович', 'active', D1, monthStart, null],
      [1002, 'Гриневич  Николай', 'active', D2, null, null],
      [1003, 'Петров Пётр', 'fired', D1, null, monthStart],
      [1004, 'Петрав Иван', 'active', D1, null, null],
      [1005, 'Смирнова Анна', 'active', D2, '2020-01-01', null],
      [1006, 'Смирнава Ольга', 'active', D1, monthStart, null],
      [1007, 'Тест_Подчёркивание', 'active', D1, null, null],
      [1008, 'Процент 50%', 'active', D1, null, null],
      [1009, 'Слэш\\Имя', 'active', D1, null, null],
      [1010, 'Иванов И.И.', 'active', D1, null, null],
      [1011, 'Иванов ИХИ', 'active', D1, null, null],
    ];
    for (const [id, name, status, dept, hire, dismissal] of rows) {
      await q(
        `INSERT INTO employees (id, full_name, employment_status, org_department_id, hire_date, dismissal_date)
         VALUES ($1, $2, $3, $4, $5::date, $6::date)`,
        [id, name, status, dept, hire, dismissal],
      );
    }
    const makeRes = () => {
      const res = {
        statusCode: 200, body: null as unknown, sent: null as Buffer | null,
        status(code: number) { res.statusCode = code; return res; },
        json(body: unknown) { res.body = body; return res; },
        setHeader: () => undefined,
        send(buffer: Buffer) { res.sent = buffer; return res; },
      };
      return res;
    };
    const names = async (query: Record<string, string>): Promise<string[]> => {
      const res = await callPage({ page: '1', keyset: '1', view: 'staff', pageSize: '1000', sort: 'name', dir: 'asc', ...query });
      expect(res.statusCode).toBe(200);
      // Порядок ФИО зависит от collation тестовой БД — сравниваем наборы.
      return (res.body.data as unknown as Array<{ full_name: string }>).map(row => row.full_name).sort();
    };
    try {
      const grin = ['Гринёв Андрей Александрович', 'Гриневич  Николай'].sort();
      expect(await names({ search: 'грине' })).toEqual(grin);
      expect(await names({ search: 'Гринев' })).toEqual(grin);
      expect(await names({ search: 'uhbyt' })).toEqual(grin);
      expect(await names({ search: 'Гриневич Николай' })).toEqual(['Гриневич  Николай']);
      // Одна ошибка: пропуск, лишняя, неверная, перестановка; две — ничего.
      for (const typo of ['гинёв', 'гриневв', 'гринеф', 'гирнев']) {
        expect(await names({ search: typo }), typo).toEqual(grin);
      }
      expect(await names({ search: 'гирнеф' })).toEqual([]);
      // Спецсимволы LIKE — буквально.
      expect(await names({ search: '_' })).toEqual(['Тест_Подчёркивание']);
      expect(await names({ search: '50%' })).toEqual(['Процент 50%']);
      expect(await names({ search: '\\' })).toEqual(['Слэш\\Имя']);
      // Точка — не «любой символ».
      expect(await names({ search: 'и.и' })).toEqual(['Иванов И.И.']);

      // Точный есть в наборе — только он; точный вне набора (статус, отдел, фильтр столбца, период) не мешает.
      expect(await names({ search: 'смирнова' })).toEqual(['Смирнова Анна']);
      expect(await names({ search: 'петров' })).toEqual(['Петрав Иван']);
      expect(await names({ search: 'петров', status: 'fired' })).toEqual(['Петров Пётр']);
      expect(await names({ search: 'смирнова', department_id: D1 })).toEqual(['Смирнава Ольга']);
      expect(await names({ search: 'смирнова', cf: JSON.stringify({ values: { department: ['Бухгалтерия'] } }) }))
        .toEqual(['Смирнава Ольга']);
      expect(await names({ search: 'смирнова', status: 'active', period: 'hired_month' })).toEqual(['Смирнава Ольга']);

      // Порции по курсору с опечаткой — без потерь и повторов, total один.
      const ids: number[] = [];
      let cursor: { key: string | null; isNull: boolean; id: number } | null = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const query: Record<string, string> = { page: '1', keyset: '1', view: 'staff', pageSize: '1', sort: 'name', dir: 'asc', search: 'гинёв' };
        if (cursor) {
          query.after_id = String(cursor.id);
          query.after_null = cursor.isNull ? '1' : '0';
          if (!cursor.isNull && cursor.key !== null) query.after_key = cursor.key;
        }
        const res = await callPage(query);
        expect(res.body.meta.total).toBe(2);
        ids.push(...res.body.data.map(row => row.id));
        cursor = res.body.meta.next_cursor;
        if (!cursor) break;
      }
      expect(ids.sort()).toEqual([1001, 1002]);

      // Выгрузка = список при тех же фильтрах.
      audit.withClient.mockReset().mockResolvedValue(undefined);
      const exported = makeRes();
      await employeesStaffController.exportView(makeReq({ status: 'active', sort: 'name', dir: 'asc', search: 'петров' }), exported as unknown as Response);
      expect(exported.statusCode).toBe(200);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(exported.sent as unknown as ArrayBuffer);
      const ws = workbook.worksheets[0];
      expect(Array.from({ length: ws.rowCount - 1 }, (_, i) => String(ws.getRow(i + 2).getCell(2).value))).toEqual(['Петрав Иван']);

      // Счётчики — тот же поиск по своему набору «приняты/уволены за месяц».
      const movement = makeRes();
      await employeesStaffController.getMonthMovement(makeReq({ search: 'петров' }), movement as unknown as Response);
      expect(movement.body).toMatchObject({ data: { hired: 0, fired: 1 } });
      await employeesStaffController.getMonthMovement(makeReq({ search: 'гинёв' }), movement as unknown as Response);
      expect(movement.body).toMatchObject({ data: { hired: 1, fired: 0 } });

      // Фасеты — тот же поиск без собственного фильтра столбца: точная «Смирнова» из «Склада» есть.
      const facets = makeRes();
      await employeesStaffController.getColumnValues(
        makeReq({ column: 'department', search: 'смирнова', cf: JSON.stringify({ values: { department: ['Бухгалтерия'] } }) }),
        facets as unknown as Response,
      );
      expect((facets.body as { data: { values: unknown[] } }).data.values).toEqual([{ value: 'Склад', count: 1 }]);
    } finally {
      await q('DELETE FROM employees WHERE id BETWEEN 1001 AND 1011');
    }
  });

  it('условия поиска ФИО идут по trigram-индексу idx_employees_full_name_trgm', async () => {
    // Из миграции 080 — только индекс по ФИО: tab_number в тестовой схеме нет.
    await q('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await q('CREATE INDEX IF NOT EXISTS idx_employees_full_name_trgm ON employees USING gin (full_name gin_trgm_ops)');
    const usesIndex = (plan: unknown): boolean => {
      if (Array.isArray(plan)) return plan.some(usesIndex);
      if (!plan || typeof plan !== 'object') return false;
      const node = plan as Record<string, unknown>;
      return node['Index Name'] === 'idx_employees_full_name_trgm' || Object.values(node).some(usesIndex);
    };
    // Таблица маленькая: без запретов планировщик выберет Seq Scan или проход по первичному ключу —
    // остаются только bitmap-сканы, и условие либо идёт по индексу ФИО, либо план сваливается в запрещённый.
    const explain = async (build: (params: unknown[]) => string): Promise<unknown> => {
      const params: unknown[] = [];
      const where = build(params);
      const client = await pg.pool!.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL enable_seqscan = off');
        await client.query('SET LOCAL enable_indexscan = off');
        const res = await client.query(`EXPLAIN (FORMAT JSON) SELECT id FROM employees WHERE ${where}`, params);
        return res.rows[0]['QUERY PLAN'];
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    };
    try {
      // «елена» → [её]л[её]на: обычных триграмм нет совсем.
      for (const input of ['грине', 'елена', 'uhbyt']) {
        const plan = await explain(params => fioExactConditionSql('employees', params, buildFioSearch(input)!));
        expect(usesIndex(plan), input).toBe(true);
      }
      const fuzzyPlan = await explain(params => fioFuzzyConditionSql('employees', params, buildFioSearch('грнев')!));
      expect(usesIndex(fuzzyPlan)).toBe(true);
    } finally {
      await q('DROP INDEX IF EXISTS idx_employees_full_name_trgm');
    }
  });
});
