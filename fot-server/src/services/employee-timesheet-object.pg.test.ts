import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Объект табелирования (миграция 288) на настоящем PostgreSQL: миграция и её повтор,
// резолв режима прошедшего месяца по фиксации (зафиксированный NULL ≠ «нет строки»),
// состав выгрузки по объектам, фиксация месяца и активация. Запускается только при
// FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы-заглушки пересоздаются).

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
    pool: () => pg.pool,
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

const hours = vi.hoisted(() => ({ byEmployee: new Map<number, Array<{ value: string; label: string; objectId: string | null; hours: number }>>() }));
vi.mock('./employee-timesheet-object.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./employee-timesheet-object.service.js')>()),
  loadTimesheetObjectHours: vi.fn(async (ids: number[]) => new Map(
    ids.filter(id => hours.byEmployee.has(id)).map(id => [id, hours.byEmployee.get(id)!]),
  )),
}));
vi.mock('./attendance.service.js', () => ({ loadAttendanceAdjustments: vi.fn() }));
vi.mock('./timesheet-object.service.js', () => ({ buildObjectAttendanceData: vi.fn() }));

import { resolveExportModes, nextMonthStart } from './timesheet-export-mode.service.js';
import { fetchEmployeeIdsPinnedToObjects } from './timesheet-objects-export.service.js';
import { activateTimesheetObjects, freezeMonth, recomputeCurrentMonth } from './employee-timesheet-object-auto.service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../docs/migrations/', import.meta.url));
const MIGRATION = readFileSync(`${MIGRATIONS_DIR}288_employee_timesheet_object.sql`, 'utf8');

const ROOT = '00000000-0000-0000-0000-00000000c000';
const CONTR = '00000000-0000-0000-0000-00000000c001';
const D_OWN = '00000000-0000-0000-0000-00000000d001';
const OFFICE = '00000000-0000-0000-0000-0000000000f1';
const IT = '00000000-0000-0000-0000-0000000000f2';
const DOM = '00000000-0000-0000-0000-0000000000a1';
const ZIL = '00000000-0000-0000-0000-0000000000a2';

const q = async <T extends import('pg').QueryResultRow>(sql: string, params?: unknown[]) =>
  (await pg.pool!.query<T>(sql, params)).rows;

/** Первое число месяца со сдвигом от базового. */
const shift = (monthStart: string, months: number): string => {
  let month = monthStart;
  for (let i = 0; i < months; i += 1) month = nextMonthStart(month);
  return month;
};

/** Первое число предыдущего месяца. */
const minusMonth = (monthStart: string): string => {
  const date = new Date(`${monthStart}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 10);
};

let baseline = '';

const resetSchema = async (): Promise<void> => {
  await pg.pool!.query(`
    DROP TABLE IF EXISTS employee_timesheet_object_months, timesheet_object_auto_state, timesheet_versions,
      department_object_assignment, audit_logs, employees, skud_objects, org_departments CASCADE;
    CREATE TABLE org_departments (
      id uuid PRIMARY KEY, name text NOT NULL, parent_id uuid NULL, is_active boolean NOT NULL DEFAULT true,
      timesheet_export_mode text NULL, timesheet_export_object_id uuid NULL
    );
    CREATE TABLE skud_objects (
      id uuid PRIMARY KEY, name text NOT NULL UNIQUE, alt_name text NULL,
      is_active boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE employees (
      id integer PRIMARY KEY, full_name text, is_archived boolean NOT NULL DEFAULT false,
      employment_status text NOT NULL DEFAULT 'active', org_department_id uuid NULL,
      timesheet_export_mode text NULL, timesheet_export_object_id uuid NULL REFERENCES skud_objects(id),
      updated_at timestamptz NULL,
      CONSTRAINT employees_export_mode_object_consistent CHECK (
        (timesheet_export_mode = 'object' AND timesheet_export_object_id IS NOT NULL)
        OR (timesheet_export_mode IS DISTINCT FROM 'object' AND timesheet_export_object_id IS NULL))
    );
    CREATE TABLE department_object_assignment (
      org_department_id uuid NOT NULL, skud_object_id uuid NOT NULL, is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE timesheet_versions (
      id serial PRIMARY KEY, source text NOT NULL,
      CONSTRAINT timesheet_versions_source_check CHECK (source IN ('approve', 'close', 'backfill', 'rebuild'))
    );
    CREATE TABLE audit_logs (
      id bigserial PRIMARY KEY, user_id uuid NULL, action text NOT NULL, entity_type text NULL,
      entity_id text NULL, details jsonb NULL, ip_address text NULL, user_agent text NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE OR REPLACE FUNCTION public.get_descendant_department_ids(root_ids uuid[])
    RETURNS TABLE(id uuid) LANGUAGE sql STABLE AS $$
      WITH RECURSIVE tree AS (
        SELECT d.id FROM org_departments d WHERE d.id = ANY(root_ids)
        UNION
        SELECT c.id FROM org_departments c JOIN tree t ON c.parent_id = t.id
      )
      SELECT tree.id FROM tree
    $$;

    INSERT INTO org_departments (id, name, parent_id) VALUES
      ('${ROOT}', 'Подрядные организации', NULL),
      ('${CONTR}', 'ООО Подрядчик', '${ROOT}'),
      ('${D_OWN}', 'Отдел СУ-10', NULL);
    INSERT INTO skud_objects (id, name, alt_name) VALUES
      ('${OFFICE}', 'Офис Полковая', 'Текущая деятельность'),
      ('${IT}', 'ИТ', NULL),
      ('${DOM}', 'ЖК Дом 56', 'Фридриха Энгельса ул.'),
      ('${ZIL}', 'ЖК Зил 18,19,27', 'Автозаводская ул.');
    INSERT INTO employees (id, full_name, org_department_id, timesheet_export_mode, timesheet_export_object_id, is_archived) VALUES
      (1, 'Без режима', '${D_OWN}', NULL, NULL, false),
      (2, 'Ручной объект', '${D_OWN}', 'object', '${DOM}', false),
      (3, 'Офис закреплён', '${D_OWN}', 'object', '${OFFICE}', false),
      (4, 'Подрядчик', '${CONTR}', NULL, NULL, false),
      (5, 'Архивный', '${D_OWN}', NULL, NULL, true);
  `);
};

describe.skipIf(!PG_URL)('объект табелирования (288) на PostgreSQL', () => {
  beforeAll(async () => {
    await resetSchema();
    await pg.pool!.query(MIGRATION);
    baseline = (await q<{ m: string }>(
      `SELECT (date_trunc('month', now() AT TIME ZONE 'Europe/Moscow') - interval '1 month')::date::text AS m`,
    ))[0].m;
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  describe('миграция', () => {
    it('ИТ входит в «Офис», офисное закрепление нормализовано, версии принимают source = objects', async () => {
      expect((await q<{ alt_name: string }>(`SELECT alt_name FROM skud_objects WHERE name = 'ИТ'`))[0].alt_name)
        .toBe('Текущая деятельность');
      const [emp3] = await q(`SELECT timesheet_export_mode, timesheet_export_object_id FROM employees WHERE id = 3`);
      expect(emp3).toEqual({ timesheet_export_mode: 'current_activity', timesheet_export_object_id: null });
      await q(`INSERT INTO timesheet_versions (source) VALUES ('objects')`);
    });

    it('базовая фиксация: свои не архивные, с уже нормализованными режимами; подрядчиков нет', async () => {
      const rows = await q<{ employee_id: number; mode: string | null; object_id: string | null }>(
        `SELECT employee_id, mode, object_id::text FROM employee_timesheet_object_months
          WHERE month = $1::date ORDER BY employee_id`, [baseline],
      );
      expect(rows).toEqual([
        { employee_id: 1, mode: null, object_id: null },
        { employee_id: 2, mode: 'object', object_id: DOM },
        { employee_id: 3, mode: 'current_activity', object_id: null },
      ]);
      const [state] = await q(`SELECT enabled, baseline_month::text, frozen_month::text, objects_rebuilt_month::text, applied_date
                                 FROM timesheet_object_auto_state`);
      expect(state).toEqual({
        enabled: false, baseline_month: baseline, frozen_month: baseline, objects_rebuilt_month: baseline, applied_date: null,
      });
    });

    it('повторный запуск: baseline не меняется, дублей нет', async () => {
      await pg.pool!.query(MIGRATION);
      await pg.pool!.query(MIGRATION);
      expect(Number((await q<{ n: string }>('SELECT count(*) AS n FROM employee_timesheet_object_months'))[0].n)).toBe(3);
      expect(Number((await q<{ n: string }>('SELECT count(*) AS n FROM timesheet_object_auto_state'))[0].n)).toBe(1);
      expect((await q<{ b: string }>('SELECT baseline_month::text AS b FROM timesheet_object_auto_state'))[0].b).toBe(baseline);
    });

    it('без корня подрядчиков миграция откатывается', async () => {
      const client = await pg.pool!.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE org_departments SET name = 'переименован' WHERE id = '${ROOT}'`);
        await expect(client.query(MIGRATION.replace(/^BEGIN;|COMMIT;\s*$/gm, '')))
          .rejects.toThrow(/Подрядные организации/);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });

  describe('режим за прошедший месяц', () => {
    beforeEach(async () => {
      await pg.pool!.query(`
        DELETE FROM employee_timesheet_object_months WHERE month <> '${baseline}'::date;
        UPDATE org_departments SET timesheet_export_mode = NULL, timesheet_export_object_id = NULL;
        UPDATE employees SET timesheet_export_mode = NULL, timesheet_export_object_id = NULL WHERE id = 1;
        UPDATE employees SET timesheet_export_mode = 'object', timesheet_export_object_id = '${DOM}' WHERE id = 2;
      `);
    });

    it('зафиксированный NULL ≠ «нет строки»: поздний личный объект прошлый месяц не меняет', async () => {
      await q(`UPDATE employees SET timesheet_export_mode = 'object', timesheet_export_object_id = $1 WHERE id = 1`, [ZIL]);
      const now = new Date(`${shift(baseline, 1)}T12:00:00+03:00`);

      const past = await resolveExportModes([1], undefined, { month: baseline, now });
      expect(past.get(1)).toMatchObject({ mode: 'skud', source: 'legacy_default' });

      const current = await resolveExportModes([1], undefined, { month: shift(baseline, 1), now });
      expect(current.get(1)).toMatchObject({ mode: 'object', pinnedObjectId: ZIL });
    });

    it('месяц ≤ базовой берёт базовую фиксацию; после базовой — ровно свою строку; нет строки — живой', async () => {
      const m1 = shift(baseline, 1);
      const now = new Date(`${shift(baseline, 3)}T12:00:00+03:00`);
      await q(`INSERT INTO employee_timesheet_object_months (employee_id, month, mode, object_id) VALUES (2, $1::date, 'object', $2)`, [m1, ZIL]);
      // Живой режим отличается и от базовой фиксации (DOM), и от фиксации m1 (ZIL).
      await q(`UPDATE employees SET timesheet_export_mode = 'current_activity', timesheet_export_object_id = NULL WHERE id = 2`);

      const older = await resolveExportModes([2], undefined, { month: minusMonth(baseline), now });
      expect(older.get(2)).toMatchObject({ mode: 'object', pinnedObjectId: DOM });
      const atBaseline = await resolveExportModes([2], undefined, { month: baseline, now });
      expect(atBaseline.get(2)).toMatchObject({ mode: 'object', pinnedObjectId: DOM });

      const exact = await resolveExportModes([2], undefined, { month: m1, now });
      expect(exact.get(2)).toMatchObject({ mode: 'object', pinnedObjectId: ZIL });

      // Сотрудник 1 без строки за m1 — живой режим (аварийный best effort).
      await q(`UPDATE employees SET timesheet_export_mode = 'current_activity' WHERE id = 1`);
      const missing = await resolveExportModes([1], undefined, { month: m1, now });
      expect(missing.get(1)).toMatchObject({ mode: 'current_activity' });
    });

    it('режим отдела после фиксации — живой (граница задачи)', async () => {
      const now = new Date(`${shift(baseline, 1)}T12:00:00+03:00`);
      await q(`UPDATE org_departments SET timesheet_export_mode = 'current_activity' WHERE id = $1`, [D_OWN]);
      const past = await resolveExportModes([1], undefined, { month: baseline, now });
      expect(past.get(1)).toMatchObject({ mode: 'current_activity', source: 'department_explicit' });
    });

    it('выгрузка по объектам: состав прошедшего месяца — по фиксации, текущего — по живому', async () => {
      const m1 = shift(baseline, 1);
      const now = new Date(`${shift(baseline, 2)}T12:00:00+03:00`);
      await q(`INSERT INTO employee_timesheet_object_months (employee_id, month, mode, object_id) VALUES (2, $1::date, 'object', $2)`, [m1, DOM]);
      await q(`UPDATE employees SET timesheet_export_object_id = $1 WHERE id = 2`, [ZIL]);

      expect(await fetchEmployeeIdsPinnedToObjects([DOM], m1.slice(0, 7), now)).toEqual([2]);
      expect(await fetchEmployeeIdsPinnedToObjects([DOM], shift(baseline, 2).slice(0, 7), now)).toEqual([]);
      expect(await fetchEmployeeIdsPinnedToObjects([ZIL], shift(baseline, 2).slice(0, 7), now)).toEqual([2]);
    });
  });

  describe('активация, фиксация и ночной пересчёт', () => {
    beforeAll(async () => {
      await resetSchema();
      await pg.pool!.query(MIGRATION);
    });

    it('активация с --all: ручные режимы пересчитаны, подрядчик и архивный не тронуты, повтор без --force отклонён', async () => {
      const current = shift(baseline, 1);
      const now = new Date(`${current.slice(0, 8)}10T12:00:00+03:00`);
      hours.byEmployee = new Map([
        [1, [{ value: ZIL, label: 'ЖК Зил 18,19,27', objectId: ZIL, hours: 40 }]],
        [2, [{ value: 'office', label: 'Офис', objectId: null, hours: 30 }]],
        [4, [{ value: DOM, label: 'ЖК Дом 56', objectId: DOM, hours: 100 }]],
      ]);

      const dry = await activateTimesheetObjects({ all: true, force: false, dryRun: true, now });
      expect(dry.report).toMatchObject({ employees: 3, withHours: 2, changed: 2, toOffice: 1, toObject: 1 });
      expect((await q<{ enabled: boolean }>('SELECT enabled FROM timesheet_object_auto_state'))[0].enabled).toBe(false);

      await activateTimesheetObjects({ all: true, force: false, dryRun: false, now });
      const emps = await q(`SELECT id, timesheet_export_mode, timesheet_export_object_id::text, timesheet_export_set_by
                              FROM employees ORDER BY id`);
      expect(emps).toEqual([
        { id: 1, timesheet_export_mode: 'object', timesheet_export_object_id: ZIL, timesheet_export_set_by: 'auto' },
        { id: 2, timesheet_export_mode: 'current_activity', timesheet_export_object_id: null, timesheet_export_set_by: 'auto' },
        { id: 3, timesheet_export_mode: 'current_activity', timesheet_export_object_id: null, timesheet_export_set_by: null },
        { id: 4, timesheet_export_mode: null, timesheet_export_object_id: null, timesheet_export_set_by: null },
        { id: 5, timesheet_export_mode: null, timesheet_export_object_id: null, timesheet_export_set_by: null },
      ]);
      const [state] = await q(`SELECT enabled, applied_date::text FROM timesheet_object_auto_state`);
      expect(state).toEqual({ enabled: true, applied_date: `${current.slice(0, 8)}10` });

      await expect(activateTimesheetObjects({ all: true, force: false, dryRun: false, now }))
        .rejects.toThrow(/--force/);
    });

    it('ночной пересчёт за ту же дату — no-op; ручной выбор сотрудника не трогается', async () => {
      const current = shift(baseline, 1);
      await q(`UPDATE employees SET timesheet_export_mode = 'object', timesheet_export_object_id = $1,
                 timesheet_export_set_by = 'employee' WHERE id = 1`, [DOM]);
      const sameDay = new Date(`${current.slice(0, 8)}10T20:00:00+03:00`);
      expect(await recomputeCurrentMonth(sameDay)).toEqual({ kind: 'skipped', reason: 'already_applied' });

      const nextDay = new Date(`${current.slice(0, 8)}11T05:00:00+03:00`);
      const auditBefore = Number((await q<{ n: string }>('SELECT count(*) AS n FROM audit_logs'))[0].n);
      const result = await recomputeCurrentMonth(nextDay);
      expect(result).toMatchObject({ kind: 'applied', changed: 0 });
      // Ноль изменений — аудита нет, но applied_date сдвинулась.
      expect(Number((await q<{ n: string }>('SELECT count(*) AS n FROM audit_logs'))[0].n)).toBe(auditBefore);
      expect((await q<{ d: string }>('SELECT applied_date::text AS d FROM timesheet_object_auto_state'))[0].d)
        .toBe(`${current.slice(0, 8)}11`);
      const [emp1] = await q(`SELECT timesheet_export_object_id::text AS o, timesheet_export_set_by AS s FROM employees WHERE id = 1`);
      expect(emp1).toEqual({ o: DOM, s: 'employee' });
    });

    it('фиксация месяца: строки своих сотрудников, frozen_month; повтор — no-op; порча состояния — ошибка', async () => {
      const month = shift(baseline, 1);
      const now = new Date(`${shift(baseline, 2)}T04:30:00+03:00`);
      const result = await freezeMonth(month, now);
      expect(result).toMatchObject({ kind: 'frozen', month, rows: 3 });
      // Свои не архивные: подрядчик (4) и архивный (5) не фиксируются.
      const rows = await q(`SELECT employee_id, mode, object_id::text, set_by FROM employee_timesheet_object_months
                              WHERE month = $1::date ORDER BY employee_id`, [month]);
      expect(rows).toEqual([
        { employee_id: 1, mode: 'object', object_id: DOM, set_by: 'employee' },
        { employee_id: 2, mode: 'current_activity', object_id: null, set_by: 'auto' },
        { employee_id: 3, mode: 'current_activity', object_id: null, set_by: null },
      ]);
      // applied_date фиксация не трогает.
      const [state] = await q(`SELECT frozen_month::text AS f, applied_date::text AS a FROM timesheet_object_auto_state`);
      expect(state).toEqual({ f: month, a: `${month.slice(0, 8)}11` });

      expect(await freezeMonth(month, now)).toEqual({ kind: 'skipped', reason: 'already_frozen' });

      // Строки следующего месяца уже есть при frozen_month < M — порча, а не тихий пропуск.
      const next = shift(baseline, 2);
      await q(`INSERT INTO employee_timesheet_object_months (employee_id, month) VALUES (1, $1::date)`, [next]);
      await expect(freezeMonth(next, new Date(`${shift(baseline, 3)}T04:30:00+03:00`))).rejects.toThrow();
      expect((await q<{ f: string }>('SELECT frozen_month::text AS f FROM timesheet_object_auto_state'))[0].f).toBe(month);
    });
  });
});
