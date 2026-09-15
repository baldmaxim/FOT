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
const traverse = async (sort: string, dir: 'asc' | 'desc', pageSize: number): Promise<number[]> => {
  const ids: number[] = [];
  let cursor: { key: string | null; isNull: boolean; id: number } | null = null;
  for (let guard = 0; guard < 100; guard += 1) {
    const query: Record<string, string> = { page: '1', keyset: '1', view: 'staff', pageSize: String(pageSize), sort, dir };
    if (cursor) {
      query.after_id = String(cursor.id);
      query.after_null = cursor.isNull ? '1' : '0';
      if (!cursor.isNull && cursor.key !== null) query.after_key = cursor.key;
    }
    const res = await callPage(query);
    expect(res.statusCode).toBe(200);
    expect(res.body.meta.total).toBe(EMPLOYEES);
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
                           employee_schedule_assignments, work_schedules CASCADE;
      CREATE TABLE user_profiles (id uuid PRIMARY KEY, full_name text);
      CREATE TABLE org_departments (id uuid PRIMARY KEY, name text);
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

  it('удаление профиля автора не удаляет комментарий (ON DELETE SET NULL)', async () => {
    const U3 = '00000000-0000-0000-0000-0000000000f3';
    await q(`INSERT INTO user_profiles VALUES ($1, 'Временный')`, [U3]);
    await q(`INSERT INTO employee_staff_comments (employee_id, comment, updated_by) VALUES (3, 'Текст', $1)
             ON CONFLICT (employee_id) DO UPDATE SET updated_by = EXCLUDED.updated_by`, [U3]);
    await q('DELETE FROM user_profiles WHERE id = $1', [U3]);
    const [row] = await q<{ updated_by: string | null }>('SELECT updated_by FROM employee_staff_comments WHERE employee_id = 3');
    expect(row.updated_by).toBeNull();
  });
});
