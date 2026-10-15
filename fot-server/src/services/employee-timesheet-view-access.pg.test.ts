import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// «Просмотр табеля» (миграция 309) на настоящем PostgreSQL: миграция и её повтор, полная
// замена списка и её повтор, параллельные сохранения (остаётся последний список, а не
// объединение), CHECK на самого себя, CASCADE при удалении сотрудника, и что состав
// личной подачи (employee_direct_reports) о списке просмотра не знает.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы-заглушки пересоздаются).

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../config/postgres.js', async () => {
  const { Pool, types } = await import('pg');
  // Как в config/postgres.ts: bigint — числом (employee_direct_reports фильтрует Number.isInteger).
  types.setTypeParser(20, (value: string) => Number(value));
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 10 }) : null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool.query(sql, params as unknown[]);
  };
  return {
    getPool: () => pg.pool,
    query: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows[0] ?? null,
    execute: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rowCount ?? 0,
    withTransaction: async <T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> => {
      const client = await pg.pool!.connect();
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

import {
  listTimesheetViewAssignments,
  listTimesheetViewEmployeeIds,
  replaceTimesheetViewEmployees,
  resolveTimesheetViewOnlyEmployeeIds,
} from './employee-timesheet-view-access.service.js';
import { listDirectReportIdsInPeriod } from './employee-direct-reports.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../docs/migrations/', import.meta.url));
const MIGRATION = readFileSync(`${MIGRATIONS_DIR}309_employee_timesheet_view_access.sql`, 'utf8');

const VIEWER = 2562;
const A = 1361;
const B = 46;
const C = 1576;
const D = 736;
const ADMIN_PROFILE = '00000000-0000-0000-0000-000000000001';

const q = async <T extends import('pg').QueryResultRow>(sql: string, params?: unknown[]) =>
  (await pg.pool!.query<T>(sql, params)).rows;

const rowsOf = async (viewer: number): Promise<number[]> => (
  await q<{ employee_id: string }>(
    'SELECT employee_id FROM employee_timesheet_view_access WHERE viewer_employee_id = $1 ORDER BY employee_id',
    [viewer],
  )
).map(row => Number(row.employee_id));

const replaceInTx = async (ids: number[]) => {
  const client = await pg.pool!.connect();
  try {
    await client.query('BEGIN');
    const out = await replaceTimesheetViewEmployees(client, VIEWER, ids, ADMIN_PROFILE);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const makeReq = (roleCode = 'manager_obj'): AuthenticatedRequest => ({
  user: { id: 'u', employee_id: VIEWER, role_code: roleCode, is_admin: false },
} as unknown as AuthenticatedRequest);

describe.skipIf(!PG_URL)('employee_timesheet_view_access (миграция 309) — PostgreSQL', () => {
  beforeAll(async () => {
    await q(`
      DROP TABLE IF EXISTS employee_timesheet_view_access, employee_direct_reports, user_profiles, employees CASCADE;
      CREATE TABLE employees (
        id bigint PRIMARY KEY,
        full_name text,
        employment_status text NOT NULL DEFAULT 'active',
        dismissal_date date,
        is_archived boolean NOT NULL DEFAULT false,
        excluded_from_timesheet boolean NOT NULL DEFAULT false,
        excluded_from_timesheet_date date
      );
      CREATE TABLE user_profiles (id uuid PRIMARY KEY);
      CREATE TABLE employee_direct_reports (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        subordinate_employee_id bigint NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        manager_employee_id bigint NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        assigned_at timestamptz NOT NULL DEFAULT now(),
        unassigned_at timestamptz,
        is_active boolean NOT NULL DEFAULT true
      );
    `);
    // Миграция идемпотентна: второй прогон не падает.
    await q(MIGRATION);
    await q(MIGRATION);
  });

  beforeEach(async () => {
    await q('TRUNCATE employee_timesheet_view_access, employee_direct_reports, user_profiles, employees CASCADE');
    await q(
      `INSERT INTO employees (id, full_name) VALUES
         ($1, 'Владимиров Иван Ильич'), ($2, 'Остриогло Вадим Иванович'),
         ($3, 'Абдурахманов Бобир Хайдарович'), ($4, 'Салий Виталий Владимирович'),
         ($5, 'Кабыка Дмитрий Михайлович')`,
      [VIEWER, A, B, C, D],
    );
    await q('INSERT INTO user_profiles (id) VALUES ($1)', [ADMIN_PROFILE]);
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('полная замена: diff и повтор без изменений', async () => {
    expect(await replaceInTx([A, B])).toEqual({ added: [B, A].sort((x, y) => x - y), removed: [] });
    expect(await replaceInTx([B, C])).toEqual({ added: [C], removed: [A] });
    expect(await replaceInTx([C, B, B])).toEqual({ added: [], removed: [] });
    expect(await rowsOf(VIEWER)).toEqual([B, C].sort((x, y) => x - y));
    expect(await replaceInTx([])).toEqual({ added: [], removed: [B, C].sort((x, y) => x - y) });
    expect(await rowsOf(VIEWER)).toEqual([]);
  });

  it('сам себя: сервис отбрасывает, таблица не принимает (CHECK)', async () => {
    expect(await replaceInTx([VIEWER, A])).toEqual({ added: [A], removed: [] });
    await expect(q(
      'INSERT INTO employee_timesheet_view_access (viewer_employee_id, employee_id) VALUES ($1, $1)',
      [VIEWER],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('параллельные сохранения: остаётся список последнего, а не объединение', async () => {
    await replaceInTx([D]);
    const first = await pg.pool!.connect();
    const second = await pg.pool!.connect();
    try {
      await first.query('BEGIN');
      await replaceTimesheetViewEmployees(first, VIEWER, [A], ADMIN_PROFILE);
      await second.query('BEGIN');
      // Второе сохранение ждёт блокировку строки смотрящего, пока первое не закоммичено.
      const secondDone = replaceTimesheetViewEmployees(second, VIEWER, [B, C], ADMIN_PROFILE);
      await new Promise(resolve => setTimeout(resolve, 200));
      await first.query('COMMIT');
      await secondDone;
      await second.query('COMMIT');
    } finally {
      first.release();
      second.release();
    }
    expect(await rowsOf(VIEWER)).toEqual([B, C].sort((x, y) => x - y));
  });

  it('удаление сотрудника снимает связи с обеих сторон (CASCADE), автор — SET NULL', async () => {
    await replaceInTx([A, B]);
    await q('DELETE FROM employees WHERE id = $1', [A]);
    expect(await rowsOf(VIEWER)).toEqual([B]);
    await q('DELETE FROM user_profiles WHERE id = $1', [ADMIN_PROFILE]);
    expect(await q('SELECT created_by FROM employee_timesheet_view_access')).toEqual([{ created_by: null }]);
    await q('DELETE FROM employees WHERE id = $1', [VIEWER]);
    expect(await q('SELECT 1 FROM employee_timesheet_view_access')).toEqual([]);
  });

  it('чтение: список для гейтов, панель с ФИО, табельщице — пусто', async () => {
    await replaceInTx([A, B]);
    expect((await listTimesheetViewEmployeeIds(VIEWER)).sort((x, y) => x - y)).toEqual([B, A].sort((x, y) => x - y));
    expect(await listTimesheetViewAssignments(VIEWER)).toEqual([
      { employee_id: B, full_name: 'Абдурахманов Бобир Хайдарович', employment_status: 'active' },
      { employee_id: A, full_name: 'Остриогло Вадим Иванович', employment_status: 'active' },
    ]);
    expect([...await resolveTimesheetViewOnlyEmployeeIds(makeReq())].sort((x, y) => x - y)).toEqual([B, A].sort((x, y) => x - y));
    expect([...await resolveTimesheetViewOnlyEmployeeIds(makeReq('timekeeper'))]).toEqual([]);
  });

  it('состав личной подачи берёт только прямых подчинённых, не список просмотра', async () => {
    await q(
      'INSERT INTO employee_direct_reports (subordinate_employee_id, manager_employee_id, assigned_at) VALUES ($1, $2, $3)',
      [D, VIEWER, '2026-05-20T10:00:00+03:00'],
    );
    await replaceInTx([A, B]);
    expect(await listDirectReportIdsInPeriod(VIEWER, '2026-10-01', '2026-10-15')).toEqual([D]);
  });
});
