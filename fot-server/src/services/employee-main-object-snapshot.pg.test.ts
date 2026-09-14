import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Снимки 277/279 на настоящем PostgreSQL: идемпотентность миграции и проверка схемы,
// атомарная публикация поколения, откат, конкурирующие пересчёты, согласованное чтение.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы снимков и заглушка
// employees пересоздаются). В обычном прогоне пропускается.

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../config/postgres.js', async () => {
  const { Pool } = await import('pg');
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 10 }) : null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool.query(sql, params as unknown[]);
  };
  const tx = (begin: string) => async <T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    const client = await pg.pool.connect();
    try {
      await client.query(begin);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
  return {
    query: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows[0] ?? null,
    execute: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rowCount ?? 0,
    withTransaction: tx('BEGIN'),
    withReadOnlySnapshot: tx('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'),
  };
});

const objects = vi.hoisted(() => ({ loadObjectHoursByEmployee: vi.fn() }));
vi.mock('./employees-export-objects.service.js', async () => {
  const actual = await vi.importActual<typeof import('./employees-export-objects.service.js')>('./employees-export-objects.service.js');
  return { ...actual, loadObjectHoursByEmployee: objects.loadObjectHoursByEmployee };
});
vi.mock('./timesheet-object.service.js', () => ({ buildObjectAttendanceData: vi.fn() }));
vi.mock('./attendance.service.js', () => ({ loadAttendanceAdjustments: vi.fn() }));

import { loadMainObjects, loadSnapshotData, rebuildMainObjectSnapshot } from './employee-main-object-snapshot.service.js';
import { checkPublishedSnapshot } from './employee-main-object-snapshot-check.service.js';
import type { IMainObject } from './employees-export-objects.service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../docs/migrations/', import.meta.url));
const migration = (name: string): string => readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf8');

const NOW = new Date('2026-09-14T09:00:00Z'); // период снимка 2026-08-15..2026-09-13
const O1 = '00000000-0000-0000-0000-0000000000a1';
const O2 = '00000000-0000-0000-0000-0000000000a2';
const O3 = '00000000-0000-0000-0000-0000000000a3';

const lists = (): Map<number, IMainObject[]> => new Map([
  [1, [{ objectId: O1, objectName: 'ЖК Альфа', hours: 40 }, { objectId: O2, objectName: 'ЖК Бета', hours: 12.5 }]],
  [2, [{ objectId: O3, objectName: 'ЖК Гамма', hours: 8 }]],
]);

const q = async <T extends import('pg').QueryResultRow>(sql: string, params?: unknown[]) =>
  (await pg.pool!.query<T>(sql, params)).rows;

/** Бизнес-поля снимков без run_id и временных меток. */
const businessState = async () => ({
  main: await q(`SELECT employee_id, skud_object_id::text, object_name, hours::text, period_start::text, period_end::text
                   FROM employee_main_object_snapshot ORDER BY employee_id`),
  objects: await q(`SELECT employee_id, skud_object_id::text, object_name, hours::text
                      FROM employee_object_hours_snapshot ORDER BY employee_id, skud_object_id`),
});

const activeRunId = async (): Promise<number | null> => {
  const [row] = await q<{ active_run_id: string | null }>('SELECT active_run_id FROM employee_main_object_snapshot_state');
  return row?.active_run_id != null ? Number(row.active_run_id) : null;
};

describe.skipIf(!PG_URL)('снимки 277/279 на PostgreSQL', () => {
  beforeAll(async () => {
    await pg.pool!.query(`
      DROP TABLE IF EXISTS employee_object_hours_snapshot, employee_main_object_snapshot_state,
        employee_main_object_snapshot, employee_main_object_snapshot_runs, employees CASCADE;
      CREATE TABLE employees (
        id integer PRIMARY KEY,
        is_archived boolean NOT NULL DEFAULT false,
        employment_status text NOT NULL DEFAULT 'active',
        dismissal_date date NULL
      );
      INSERT INTO employees (id) VALUES (1), (2), (3);
    `);
    await pg.pool!.query(migration('277_employee_main_object_snapshot.sql'));
    await pg.pool!.query(migration('279_employee_object_hours_snapshot.sql'));
  });

  beforeEach(async () => {
    objects.loadObjectHoursByEmployee.mockReset().mockImplementation(async () => lists());
    await pg.pool!.query(`
      UPDATE employee_main_object_snapshot_state SET active_run_id = NULL, published_at = NULL;
      DELETE FROM employee_object_hours_snapshot;
      DELETE FROM employee_main_object_snapshot;
      DELETE FROM employee_main_object_snapshot_runs;
    `);
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('миграция 279 повторно применяется без ошибок и не трогает данные', async () => {
    await rebuildMainObjectSnapshot({ now: NOW });
    const before = await businessState();
    const runBefore = await activeRunId();

    await pg.pool!.query(migration('279_employee_object_hours_snapshot.sql'));
    await pg.pool!.query(migration('279_employee_object_hours_snapshot.sql'));

    expect(await businessState()).toEqual(before);
    expect(await activeRunId()).toBe(runBefore);
    expect(Number((await q<{ n: string }>('SELECT count(*) AS n FROM employee_main_object_snapshot_state'))[0].n)).toBe(1);
  });

  it('проверка схемы в 279 ловит несовместимую существующую таблицу', async () => {
    const client = await pg.pool!.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE employee_object_hours_snapshot DROP CONSTRAINT employee_object_hours_snapshot_hours_check');
      await expect(client.query(migration('279_employee_object_hours_snapshot.sql').replace(/^BEGIN;|COMMIT;\s*$/gm, '')))
        .rejects.toThrow(/CHECK \(hours > 0\)/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('до первой публикации 279 — расчёт на лету; после — снимок', async () => {
    const live = await loadMainObjects([1, 2], { start: '2026-08-16', end: '2026-09-14' });
    expect(live.source).toBe('live');

    const result = await rebuildMainObjectSnapshot({ now: NOW });
    expect(result.published).toBe(true);

    const snap = await loadMainObjects([1, 2, 3], { start: '2026-08-16', end: '2026-09-14' });
    expect(snap.source).toBe('snapshot');
    expect(snap.period).toEqual({ start: '2026-08-15', end: '2026-09-13' });
    expect([...snap.objects]).toEqual(expect.arrayContaining([[1, 'ЖК Альфа'], [2, 'ЖК Гамма']]));
    expect(snap.objectNamesByEmployee.get(1)).toEqual(['ЖК Альфа', 'ЖК Бета']);
    expect(snap.objectNamesByEmployee.has(3)).toBe(false);
    // Порядок снимка = порядок расчёта на лету.
    expect(snap.objectNamesByEmployee.get(1)).toEqual(live.objectNamesByEmployee.get(1));
  });

  it('двукратная пересборка: бизнес-поля совпадают, все строки — активного запуска, устаревшие объекты удалены', async () => {
    await rebuildMainObjectSnapshot({ now: NOW });
    const first = await businessState();
    await rebuildMainObjectSnapshot({ now: NOW });
    expect(await businessState()).toEqual(first);

    const active = await activeRunId();
    const foreign = await q<{ main: string; objs: string }>(
      `SELECT (SELECT count(*) FROM employee_main_object_snapshot WHERE run_id IS DISTINCT FROM $1) AS main,
              (SELECT count(*) FROM employee_object_hours_snapshot WHERE run_id <> $1) AS objs`,
      [active],
    );
    expect(foreign[0]).toEqual({ main: '0', objs: '0' });

    objects.loadObjectHoursByEmployee.mockImplementation(async () => new Map([[2, [{ objectId: O3, objectName: 'ЖК Гамма', hours: 8 }]]]));
    await rebuildMainObjectSnapshot({ now: NOW });
    const after = await businessState();
    expect(after.objects.map(row => row.employee_id)).toEqual([2]);
    expect(after.main.map(row => row.employee_id)).toEqual([2]);

    expect((await checkPublishedSnapshot({ now: NOW })).failures).toEqual([]);
  });

  it('ошибка INSERT списка (CHECK hours > 0): откат обеих таблиц и указателя, прошлое поколение активно', async () => {
    await rebuildMainObjectSnapshot({ now: NOW });
    const before = await businessState();
    const runBefore = await activeRunId();

    objects.loadObjectHoursByEmployee.mockImplementation(async () => new Map([
      [1, [{ objectId: O1, objectName: 'ЖК Альфа', hours: 50 }, { objectId: O2, objectName: 'ЖК Бета', hours: 0 }]],
    ]));
    await expect(rebuildMainObjectSnapshot({ now: NOW })).rejects.toThrow(/hours_check/);

    expect(await businessState()).toEqual(before);
    expect(await activeRunId()).toBe(runBefore);
    const statuses = await q<{ status: string; object_hours_ready: boolean }>(
      'SELECT status, object_hours_ready FROM employee_main_object_snapshot_runs ORDER BY id',
    );
    expect(statuses.map(row => [row.status, row.object_hours_ready])).toEqual([['ok', true], ['error', false]]);
  });

  it('пустой успешный снимок — готов, списки пусты без расчёта на лету', async () => {
    objects.loadObjectHoursByEmployee.mockImplementation(async () => new Map());
    const result = await rebuildMainObjectSnapshot({ now: NOW });
    expect(result.published).toBe(true);

    objects.loadObjectHoursByEmployee.mockClear();
    const snap = await loadMainObjects([1, 2], { start: '2026-08-16', end: '2026-09-14' });
    expect(snap.source).toBe('snapshot');
    expect(snap.objectNamesByEmployee.size).toBe(0);
    expect(objects.loadObjectHoursByEmployee).not.toHaveBeenCalled();

    expect((await checkPublishedSnapshot({ now: NOW, allowEmpty: true })).failures).toEqual([]);
    expect((await checkPublishedSnapshot({ now: NOW })).failures).toHaveLength(1);
  });

  it('конкурирующие запуски за один период: A стартовал раньше, B опубликовался первым → A superseded, активен B', async () => {
    let releaseA: () => void = () => {};
    const aGate = new Promise<void>(resolve => { releaseA = resolve; });
    const aLists = new Map([[1, [{ objectId: O2, objectName: 'ЖК Бета', hours: 99 }]]]);

    objects.loadObjectHoursByEmployee
      .mockImplementationOnce(async () => { await aGate; return aLists; }) // A
      .mockImplementationOnce(async () => lists()); // B

    const runA = rebuildMainObjectSnapshot({ now: NOW });
    // Дать A записать running и дойти до расчёта раньше B.
    await vi.waitFor(async () => {
      expect((await q('SELECT id FROM employee_main_object_snapshot_runs')).length).toBe(1);
    });
    const resultB = await rebuildMainObjectSnapshot({ now: NOW });
    releaseA();
    const resultA = await runA;

    expect(resultB.published).toBe(true);
    expect(resultA.published).toBe(false);

    const runs = await q<{ id: string; status: string }>('SELECT id, status FROM employee_main_object_snapshot_runs ORDER BY id');
    expect(runs.map(row => row.status)).toEqual(['superseded', 'ok']);
    expect(await activeRunId()).toBe(Number(runs[1].id));
    const state = await businessState();
    expect(state.main.find(row => row.employee_id === 1)?.object_name).toBe('ЖК Альфа');
    expect((await checkPublishedSnapshot({ now: NOW })).failures).toEqual([]);
  });

  it('более старый период не публикуется поверх более свежего', async () => {
    await rebuildMainObjectSnapshot({ now: NOW });
    const active = await activeRunId();
    const older = await rebuildMainObjectSnapshot({ now: new Date('2026-09-10T09:00:00Z') });
    expect(older.published).toBe(false);
    expect(await activeRunId()).toBe(active);
  });

  it('чтение идёт по активному поколению, даже если последний ok-запуск журнала — другой', async () => {
    await rebuildMainObjectSnapshot({ now: NOW });
    const active = await activeRunId();
    // Посторонняя «ok»-запись с большим id, но не опубликованная.
    await pg.pool!.query(
      `INSERT INTO employee_main_object_snapshot_runs (period_start, period_end, status, object_hours_ready)
       VALUES ('2026-08-15', '2026-09-13', 'ok', true)`,
    );
    const data = await loadSnapshotData([1]);
    expect(data?.run.id).toBe(active);
    expect(data?.objects.get(1)).toBe('ЖК Альфа');
  });
});
