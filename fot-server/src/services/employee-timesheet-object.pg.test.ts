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
// Права окна «Режим табелирования» проверяются в юнит-тестах; здесь — всё разрешено.
vi.mock('./data-scope.service.js', () => ({
  canWriteDepartmentInScope: vi.fn(async () => true),
  canWriteEmployeeInScope: vi.fn(async () => true),
  resolveAccessibleDepartmentIds: vi.fn(async () => 'all'),
  resolveWritableScopedDepartmentIds: vi.fn(async (_req: unknown, ids: string[] = []) => ids),
}));
vi.mock('./timesheet-object.service.js', () => ({ buildObjectAttendanceData: vi.fn() }));

import { resolveExportModes, nextMonthStart } from './timesheet-export-mode.service.js';
import { fetchEmployeeIdsPinnedToObjects } from './timesheet-objects-export.service.js';
import { activateTimesheetObjects, freezeMonth, recomputeCurrentMonth } from './employee-timesheet-object-auto.service.js';
import { monthEnd } from './employee-timesheet-object.service.js';
import { enforceOfficeForDepartments } from './timesheet-office-rule.js';
import { updateTimesheetOffice } from './timesheet-office.service.js';
import { refreezeDepartmentMonth } from './timesheet-object-month-refreeze.service.js';
import { applyOfficeWindowToFrozenMonth, fixWorkersFrozenMonth } from './employee-timesheet-object-month-fix.service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../docs/migrations/', import.meta.url));
const MIGRATION = readFileSync(`${MIGRATIONS_DIR}288_employee_timesheet_object.sql`, 'utf8');
const MIGRATION_AUTHOR = readFileSync(`${MIGRATIONS_DIR}289_timesheet_object_author.sql`, 'utf8');
const MIGRATION_DROP_MODE = readFileSync(`${MIGRATIONS_DIR}290_drop_timesheet_mode_management.sql`, 'utf8');
const MIGRATION_OFFICE = readFileSync(`${MIGRATIONS_DIR}291_timesheet_office_departments.sql`, 'utf8');

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
      department_object_assignment, timesheet_office_departments, audit_logs, employees, skud_objects,
      org_departments, user_profiles, system_roles, role_page_access, access_pages CASCADE;
    CREATE TABLE access_pages (
      key text PRIMARY KEY, label text NULL, group_code text NULL, group_label text NULL, area text NULL,
      surface text NULL, supports_edit boolean NULL, requires_data_scope boolean NULL,
      requires_employee_variant boolean NULL, sort_order integer NULL, is_active boolean NULL, is_system boolean NULL
    );
    CREATE TABLE role_page_access (
      role_code text NOT NULL, page_path text NOT NULL,
      can_view boolean NOT NULL DEFAULT false, can_edit boolean NOT NULL DEFAULT false,
      PRIMARY KEY (role_code, page_path)
    );
    CREATE TABLE system_roles (
      id uuid PRIMARY KEY, code text NOT NULL, name text NOT NULL, is_admin boolean NOT NULL DEFAULT false
    );
    CREATE TABLE user_profiles (
      id uuid PRIMARY KEY, full_name text NULL, employee_id integer NULL,
      system_role_id uuid NULL REFERENCES system_roles(id)
    );
    CREATE TABLE org_departments (
      id uuid PRIMARY KEY, name text NOT NULL, parent_id uuid NULL, is_active boolean NOT NULL DEFAULT true,
      kind text NULL, timesheet_export_mode text NULL, timesheet_export_object_id uuid NULL
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

  // Дальше код работает на схеме после 290 — без колонок режима отдела, как на проде.
  describe('удаление ручной настройки режима (290)', () => {
    const deptModeColumns = async (): Promise<string[]> => (await q<{ c: string }>(
      `SELECT column_name AS c FROM information_schema.columns
        WHERE table_name = 'org_departments' AND column_name LIKE 'timesheet_export%' ORDER BY 1`,
    )).map(row => row.c);

    it('режим отдела отличается от правила по умолчанию — миграция останавливается, ничего не меняя', async () => {
      const client = await pg.pool!.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE org_departments SET timesheet_export_mode = 'object', timesheet_export_object_id = $1 WHERE id = $2`,
          [DOM, D_OWN],
        );
        await expect(client.query(MIGRATION_DROP_MODE.replace(/^BEGIN;|COMMIT;\s*$/gm, '')))
          .rejects.toThrow(/290 остановлена/);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      expect(await deptModeColumns()).toEqual(['timesheet_export_mode', 'timesheet_export_object_id']);
    });

    it('режим отдела совпадает с «офисом отдела» — право и колонки удалены, повтор безопасен', async () => {
      await q(`INSERT INTO department_object_assignment (org_department_id, skud_object_id) VALUES ($1, $2)`, [D_OWN, OFFICE]);
      await q(`UPDATE org_departments SET timesheet_export_mode = 'current_activity' WHERE id = $1`, [D_OWN]);
      await q(`INSERT INTO access_pages (key) VALUES ('/staff-control/timesheet-mode'), ('/staff-control/schedule')`);
      await q(`INSERT INTO role_page_access (role_code, page_path)
               VALUES ('hr', '/staff-control/timesheet-mode'), ('hr', '/staff-control/schedule')`);
      try {
        await pg.pool!.query(MIGRATION_DROP_MODE);
        await pg.pool!.query(MIGRATION_DROP_MODE);
      } finally {
        await q('DELETE FROM department_object_assignment');
      }

      expect(await deptModeColumns()).toEqual([]);
      expect(await q('SELECT key FROM access_pages ORDER BY key')).toEqual([{ key: '/staff-control/schedule' }]);
      expect(await q('SELECT role_code, page_path FROM role_page_access'))
        .toEqual([{ role_code: 'hr', page_path: '/staff-control/schedule' }]);
    });
  });

  describe('режим за прошедший месяц', () => {
    beforeEach(async () => {
      await pg.pool!.query(`
        DELETE FROM employee_timesheet_object_months WHERE month <> '${baseline}'::date;
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

    it('назначение офиса отделу после фиксации — живое (граница задачи)', async () => {
      const now = new Date(`${shift(baseline, 1)}T12:00:00+03:00`);
      await q(`INSERT INTO department_object_assignment (org_department_id, skud_object_id) VALUES ($1, $2)`, [D_OWN, OFFICE]);
      try {
        const past = await resolveExportModes([1], undefined, { month: baseline, now });
        expect(past.get(1)).toMatchObject({ mode: 'current_activity', source: 'legacy_department' });
      } finally {
        await q('DELETE FROM department_object_assignment');
      }
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
      await pg.pool!.query(MIGRATION_AUTHOR);
      await pg.pool!.query(MIGRATION_DROP_MODE);
      await pg.pool!.query(MIGRATION_OFFICE);
    });

    it('активация: ручные режимы пересчитаны, подрядчик и архивный не тронуты; повтор — без изменений; пропущенный месяц при включённом расчёте — отказ', async () => {
      const current = shift(baseline, 1);
      const now = new Date(`${current.slice(0, 8)}10T12:00:00+03:00`);
      hours.byEmployee = new Map([
        [1, [{ value: ZIL, label: 'ЖК Зил 18,19,27', objectId: ZIL, hours: 40 }]],
        [2, [{ value: 'office', label: 'Офис', objectId: null, hours: 30 }]],
        [4, [{ value: DOM, label: 'ЖК Дом 56', objectId: DOM, hours: 100 }]],
      ]);

      const dry = await activateTimesheetObjects({ dryRun: true, now });
      expect(dry.report).toMatchObject({ employees: 3, withHours: 2, changed: 2, toOffice: 1, toObject: 1 });
      expect((await q<{ enabled: boolean }>('SELECT enabled FROM timesheet_object_auto_state'))[0].enabled).toBe(false);

      await activateTimesheetObjects({ dryRun: false, now });
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

      // Повтор — тот же расчёт, без изменений.
      expect((await activateTimesheetObjects({ dryRun: false, now })).report.changed).toBe(0);
      // Расчёт включён, а прошлый месяц не зафиксирован ночью — скрипт его не фиксирует.
      const nextMonthNow = new Date(`${shift(baseline, 2).slice(0, 8)}10T12:00:00+03:00`);
      await expect(activateTimesheetObjects({ dryRun: true, now: nextMonthNow }))
        .rejects.toThrow(/не зафиксирован/);
    });

    it('ночной пересчёт за ту же дату — no-op; прежний выбор сотрудника ночь ставит по часам; ноль изменений — без аудита', async () => {
      const current = shift(baseline, 1);
      await q(`UPDATE employees SET timesheet_export_mode = 'object', timesheet_export_object_id = $1,
                 timesheet_export_set_by = 'employee' WHERE id = 1`, [DOM]);
      const sameDay = new Date(`${current.slice(0, 8)}10T20:00:00+03:00`);
      expect(await recomputeCurrentMonth(sameDay)).toEqual({ kind: 'skipped', reason: 'already_applied' });

      const nextDay = new Date(`${current.slice(0, 8)}11T05:00:00+03:00`);
      expect(await recomputeCurrentMonth(nextDay)).toMatchObject({ kind: 'applied', changed: 1 });
      const [emp1] = await q(`SELECT timesheet_export_object_id::text AS o, timesheet_export_set_by AS s FROM employees WHERE id = 1`);
      expect(emp1).toEqual({ o: ZIL, s: 'auto' });

      const dayAfter = new Date(`${current.slice(0, 8)}12T05:00:00+03:00`);
      const auditBefore = Number((await q<{ n: string }>('SELECT count(*) AS n FROM audit_logs'))[0].n);
      expect(await recomputeCurrentMonth(dayAfter)).toMatchObject({ kind: 'applied', changed: 0 });
      // Ноль изменений — аудита нет, но applied_date сдвинулась.
      expect(Number((await q<{ n: string }>('SELECT count(*) AS n FROM audit_logs'))[0].n)).toBe(auditBefore);
      expect((await q<{ d: string }>('SELECT applied_date::text AS d FROM timesheet_object_auto_state'))[0].d)
        .toBe(`${current.slice(0, 8)}12`);
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
        { employee_id: 1, mode: 'object', object_id: ZIL, set_by: 'auto' },
        { employee_id: 2, mode: 'current_activity', object_id: null, set_by: 'auto' },
        { employee_id: 3, mode: 'current_activity', object_id: null, set_by: null },
      ]);
      // applied_date фиксация не трогает.
      const [state] = await q(`SELECT frozen_month::text AS f, applied_date::text AS a FROM timesheet_object_auto_state`);
      expect(state).toEqual({ f: month, a: `${month.slice(0, 8)}12` });

      expect(await freezeMonth(month, now)).toEqual({ kind: 'skipped', reason: 'already_frozen' });

      // Строки следующего месяца уже есть при frozen_month < M — порча, а не тихий пропуск.
      const next = shift(baseline, 2);
      await q(`INSERT INTO employee_timesheet_object_months (employee_id, month) VALUES (1, $1::date)`, [next]);
      await expect(freezeMonth(next, new Date(`${shift(baseline, 3)}T04:30:00+03:00`))).rejects.toThrow();
      expect((await q<{ f: string }>('SELECT frozen_month::text AS f FROM timesheet_object_auto_state'))[0].f).toBe(month);
    });
  });

  // Автор объекта табелирования (миграция 289): кто и когда вручную поставил личный режим.
  describe('автор объекта (289)', () => {
    const R_ADMIN = '00000000-0000-0000-0000-00000000e0ad';
    const R_MANAGER = '00000000-0000-0000-0000-00000000e0aa';
    const U_SHUPTA = '00000000-0000-0000-0000-00000000b020';
    const U_BOYUKYAN = '00000000-0000-0000-0000-00000000b351';
    const U_ADMIN = '00000000-0000-0000-0000-00000000b0ad';
    const U_TEMP = '00000000-0000-0000-0000-00000000b0ee';
    const AUTHOR_IDS = [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 90];
    let m1 = '';

    const authors = async () => q<{ id: number; user_id: string | null; set_at: string | null }>(
      `SELECT id, timesheet_export_set_by_user_id::text AS user_id,
              to_char(timesheet_export_set_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS set_at
         FROM employees WHERE id = ANY($1::int[]) ORDER BY id`, [AUTHOR_IDS],
    );
    const modes = async () => q(
      `SELECT id, timesheet_export_mode, timesheet_export_object_id::text, timesheet_export_set_by
         FROM employees ORDER BY id`,
    );
    const author = async (id: number) => (await authors()).find(row => row.id === id);

    let modesBefore: unknown[] = [];

    beforeAll(async () => {
      await resetSchema();
      await pg.pool!.query(MIGRATION);
      hours.byEmployee = new Map();
      m1 = shift(baseline, 1);
      // Состояние до 289: режимы уже стоят, журнал записан — миграция восстанавливает авторов.
      await pg.pool!.query(`
        INSERT INTO system_roles (id, code, name, is_admin) VALUES
          ('${R_ADMIN}', 'admin', 'Администратор', true),
          ('${R_MANAGER}', 'manager', 'Руководитель', false);
        INSERT INTO employees (id, full_name, org_department_id, timesheet_export_mode, timesheet_export_object_id, timesheet_export_set_by) VALUES
          (20, 'Шупта Максим Сергеевич', '${D_OWN}', 'object', '${DOM}', 'employee'),
          (21, 'Глянь Артём Денисович', '${D_OWN}', 'object', '${ZIL}', 'manager'),
          (22, 'Скрипт сменил объект', '${D_OWN}', 'object', '${DOM}', 'manager'),
          (23, 'Скрипт записал то же', '${D_OWN}', 'object', '${DOM}', NULL),
          (24, 'Откат скрипта без списка', '${D_OWN}', 'object', '${DOM}', NULL),
          (25, 'Чужой путь', '${D_OWN}', 'object', '${DOM}', 'employee'),
          (26, 'Без журнала', '${D_OWN}', 'object', '${DOM}', NULL),
          (27, 'Офис от админа', '${D_OWN}', 'current_activity', NULL, NULL),
          (28, 'По СКУД от админа', '${D_OWN}', 'skud', NULL, NULL),
          (29, 'Авто', '${D_OWN}', 'object', '${ZIL}', 'auto'),
          (90, 'Боюкян Микаел Варужанович', '${D_OWN}', NULL, NULL, NULL);
        INSERT INTO user_profiles (id, full_name, employee_id, system_role_id) VALUES
          ('${U_SHUPTA}', 'Шупта Максим', 20, '${R_MANAGER}'),
          ('${U_BOYUKYAN}', 'Боюкян Микаел', 90, '${R_MANAGER}'),
          ('${U_ADMIN}', 'Есенов Максим АДМ', NULL, '${R_ADMIN}'),
          ('${U_TEMP}', 'Временный Руководитель', NULL, '${R_MANAGER}');
        INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, created_at) VALUES
          ('${U_ADMIN}', 'TIMESHEET_MODE_UPDATED', 'employee', '28',
            '{"new_mode":"skud","new_object_id":null}', '2026-09-19T10:00:00Z'),
          ('${U_ADMIN}', 'TIMESHEET_MODE_UPDATED', 'employee', '23',
            '{"new_mode":"object","new_object_id":"${DOM}"}', '2026-09-20T10:00:00Z'),
          ('${U_ADMIN}', 'TIMESHEET_MODE_UPDATED', 'employee', '24',
            '{"new_mode":"object","new_object_id":"${DOM}"}', '2026-09-20T11:00:00Z'),
          -- Аудированный скрипт записал 23-му тот же объект.
          ('${U_ADMIN}', 'TIMESHEET_MODE_BULK_UPDATED', 'timesheet_export_mode', 'l4-objects-setup',
            '{"source":"set-timesheet-modes-l4","employees":[{"id":23,"new_mode":"object"}]}', '2026-09-21T10:00:00Z'),
          -- Откат скрипта без списка сотрудников — отменяет всех, кто был до него.
          ('${U_ADMIN}', 'TIMESHEET_MODE_BULK_UPDATED', 'timesheet_export_mode', 'l4-objects-rollback',
            '{"source":"set-timesheet-modes-l4 --rollback","reverted":5}', '2026-09-22T10:00:00Z'),
          ('${U_ADMIN}', 'TIMESHEET_MODE_BULK_UPDATED', 'employee', 'bulk:1',
            '{"new_mode":"current_activity","new_object_id":null,"affected_employees":[{"id":27,"name":"Офис от админа","old_mode":null,"old_object_id":null}]}',
            '2026-09-23T13:49:59Z'),
          ('${U_BOYUKYAN}', 'TIMESHEET_OBJECT_MANAGER_SELECTED', 'employee', '21',
            '{"new_mode":"object","new_object_id":"${ZIL}"}', '2026-09-29T06:40:23Z'),
          ('${U_BOYUKYAN}', 'TIMESHEET_OBJECT_MANAGER_SELECTED', 'employee', '22',
            '{"new_mode":"object","new_object_id":"${ZIL}"}', '2026-09-29T06:44:25Z'),
          ('${U_BOYUKYAN}', 'TIMESHEET_OBJECT_MANAGER_SELECTED', 'employee', '25',
            '{"new_mode":"object","new_object_id":"${DOM}"}', '2026-09-29T06:50:00Z'),
          ('${U_SHUPTA}', 'TIMESHEET_OBJECT_SELF_SELECTED', 'employee', '20',
            '{"new_mode":"object","new_object_id":"${DOM}"}', '2026-09-29T07:10:32Z');
        -- Месяц после базовой, зафиксированный до миграции: у 21-го правка раньше фиксации,
        -- у 20-го — позже.
        INSERT INTO employee_timesheet_object_months (employee_id, month, mode, object_id, set_by, frozen_at) VALUES
          (21, '${m1}', 'object', '${ZIL}', 'manager', '2026-10-01T01:00:00Z'),
          (20, '${m1}', 'object', '${DOM}', 'employee', '2026-09-29T07:00:00Z');
      `);
      modesBefore = await modes();
      await pg.pool!.query(MIGRATION_AUTHOR);
      await pg.pool!.query(MIGRATION_DROP_MODE);
      await pg.pool!.query(MIGRATION_OFFICE);
    });

    it('восстановление из журнала: только правка человеком того же пути и значения без скрипта после неё', async () => {
      expect(await authors()).toEqual([
        { id: 20, user_id: U_SHUPTA, set_at: '2026-09-29T07:10:32Z' },
        { id: 21, user_id: U_BOYUKYAN, set_at: '2026-09-29T06:40:23Z' },
        { id: 22, user_id: null, set_at: null }, // после человека объект сменил скрипт
        { id: 23, user_id: null, set_at: null }, // человек X → аудированный скрипт X
        { id: 24, user_id: null, set_at: null }, // откат скрипта без списка после человека
        { id: 25, user_id: null, set_at: null }, // последняя запись — другого пути
        { id: 26, user_id: null, set_at: null }, // журнала нет
        { id: 27, user_id: U_ADMIN, set_at: '2026-09-23T13:49:59Z' }, // массовая правка админа, «Офис»
        { id: 28, user_id: null, set_at: null }, // «По СКУД»
        { id: 29, user_id: null, set_at: null }, // авто
        { id: 90, user_id: null, set_at: null },
      ]);
      // Фиксация до миграции: запись не позже frozen_at.
      const months = await q(
        `SELECT employee_id, set_by_user_id::text AS user_id FROM employee_timesheet_object_months
          WHERE month = $1::date ORDER BY employee_id`, [m1],
      );
      expect(months).toEqual([
        { employee_id: 20, user_id: null },
        { employee_id: 21, user_id: U_BOYUKYAN },
      ]);
      // Режимы, объекты и источники миграция не трогает.
      expect(await modes()).toEqual(modesBefore);
    });

    it('повтор 289 ничего не меняет: восстановление только при первом запуске', async () => {
      // Скрипт привёл 22-го к значению его старой правки — повтор не должен вернуть автора.
      await q(`UPDATE employees SET timesheet_export_object_id = $1 WHERE id = 22`, [ZIL]);
      const before = await authors();
      await pg.pool!.query(MIGRATION_AUTHOR);
      expect(await authors()).toEqual(before);
      expect((await author(22))?.user_id).toBeNull();
    });

    it('триггер: человек — автор остаётся; «человек X → скрипт записал тот же X» и «По СКУД» — автора нет', async () => {
      await q(`UPDATE employees
                  SET timesheet_export_mode = 'object', timesheet_export_object_id = $1, timesheet_export_set_by = NULL,
                      timesheet_export_set_by_user_id = $2, timesheet_export_set_at = now()
                WHERE id = 26`, [ZIL, U_ADMIN]);
      expect((await author(26))?.user_id).toBe(U_ADMIN);

      await q(`UPDATE employees
                  SET timesheet_export_mode = 'object', timesheet_export_object_id = $1, timesheet_export_set_by = NULL
                WHERE id = 26`, [ZIL]);
      expect(await author(26)).toMatchObject({ user_id: null, set_at: null });

      await q(`UPDATE employees
                  SET timesheet_export_mode = 'skud', timesheet_export_object_id = NULL, timesheet_export_set_by = NULL,
                      timesheet_export_set_by_user_id = $1, timesheet_export_set_at = now()
                WHERE id = 28`, [U_ADMIN]);
      expect(await author(28)).toMatchObject({ user_id: null, set_at: null });
    });

    it('CHECK: дата только у объекта или «Офиса» не от авто, ID — только с датой', async () => {
      await expect(q(`UPDATE employees SET timesheet_export_set_at = now() WHERE id = 28`))
        .rejects.toThrow(/employees_timesheet_export_author_check/);
      await expect(q(`UPDATE employees SET timesheet_export_set_at = now() WHERE id = 29`))
        .rejects.toThrow(/employees_timesheet_export_author_check/);
      await expect(q(`UPDATE employees SET timesheet_export_set_at = now() WHERE id = 90`))
        .rejects.toThrow(/employees_timesheet_export_author_check/);
      await expect(q(`UPDATE employees SET timesheet_export_set_by_user_id = $1 WHERE id = 22`, [U_ADMIN]))
        .rejects.toThrow(/employees_timesheet_export_author_check/);
      await expect(q(`INSERT INTO employee_timesheet_object_months (employee_id, month, mode, set_at)
                        VALUES (28, $1::date, 'skud', now())`, [shift(baseline, 5)]))
        .rejects.toThrow(/employee_timesheet_object_months_author_check/);
    });

    it('удаление профиля автора: ID обнуляется, дата остаётся', async () => {
      await q(`UPDATE employees
                  SET timesheet_export_mode = 'object', timesheet_export_object_id = $1, timesheet_export_set_by = 'manager',
                      timesheet_export_set_by_user_id = $2, timesheet_export_set_at = now()
                WHERE id = 24`, [DOM, U_TEMP]);
      await q(`DELETE FROM user_profiles WHERE id = $1`, [U_TEMP]);
      const row = await author(24);
      expect(row?.user_id).toBeNull();
      expect(row?.set_at).not.toBeNull();
    });

    it('фиксация месяца копирует автора в строку месяца', async () => {
      await q(`DELETE FROM employee_timesheet_object_months WHERE month = $1::date`, [m1]);
      await q(`UPDATE timesheet_object_auto_state SET enabled = true`);
      hours.byEmployee = new Map();

      const result = await freezeMonth(m1, new Date(`${shift(baseline, 2)}T04:30:00+03:00`));
      expect(result).toMatchObject({ kind: 'frozen', month: m1 });
      const rows = await q(
        `SELECT employee_id, set_by_user_id::text AS user_id,
                to_char(set_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS set_at
           FROM employee_timesheet_object_months
          WHERE month = $1::date AND employee_id IN (21, 22, 27) ORDER BY employee_id`, [m1],
      );
      expect(rows).toEqual([
        { employee_id: 21, user_id: U_BOYUKYAN, set_at: '2026-09-29T06:40:23Z' },
        { employee_id: 22, user_id: null, set_at: null },
        { employee_id: 27, user_id: U_ADMIN, set_at: '2026-09-23T13:49:59Z' },
      ]);
    });

    it('скрипт пересчитывает прежний выбор сотрудника и ручной объект админа; личный «Офис» (291) не трогает; без часов — прежние объект и автор', async () => {
      hours.byEmployee = new Map([
        [20, [{ value: ZIL, label: 'ЖК Зил 18,19,27', objectId: ZIL, hours: 30 }]],
        [26, [{ value: DOM, label: 'ЖК Дом 56', objectId: DOM, hours: 40 }]],
        [27, [{ value: ZIL, label: 'ЖК Зил 18,19,27', objectId: ZIL, hours: 40 }]],
      ]);
      const now = new Date(`${shift(baseline, 2).slice(0, 8)}10T12:00:00+03:00`);

      await activateTimesheetObjects({ dryRun: false, now });

      const rows = await q(
        `SELECT id, timesheet_export_mode AS mode, timesheet_export_object_id::text AS object_id,
                timesheet_export_set_by AS set_by, timesheet_export_set_by_user_id::text AS user_id
           FROM employees WHERE id IN (20, 26, 27) ORDER BY id`,
      );
      expect(rows).toEqual([
        // Прежний выбор сотрудника в ЛК — по часам, автор стёрт.
        { id: 20, mode: 'object', object_id: ZIL, set_by: 'auto', user_id: null },
        // Ручной объект админа без автора — пересчитан.
        { id: 26, mode: 'object', object_id: DOM, set_by: 'auto', user_id: null },
        // «Офис» с автором и set_by = NULL — личный «Офис» окна: не трогается.
        { id: 27, mode: 'current_activity', object_id: null, set_by: null, user_id: U_ADMIN },
      ]);
      // У 21-го (выбор руководителя) часов нет — объект и автор прежние.
      expect((await author(21))?.user_id).toBe(U_BOYUKYAN);
    });
  });

  // «Офис» из окна «Режим табелирования» (миграция 291): правило отдела, ночь, фиксация.
  describe('«Офис» отдела и личный «Офис» (291)', () => {
    const D_OTHER = '00000000-0000-0000-0000-00000000d002';
    const U_HR = '00000000-0000-0000-0000-00000000b0a1';
    const CONTRACTOR_IDS = [ROOT, CONTR];
    let current = '';

    const emp = async (id: number) => (await q(
      `SELECT timesheet_export_mode AS mode, timesheet_export_object_id::text AS object_id,
              timesheet_export_set_by AS set_by, timesheet_export_set_by_user_id::text AS user_id
         FROM employees WHERE id = $1`, [id],
    ))[0];
    const enforce = async (departmentIds: string[]) => {
      const client = await pg.pool!.connect();
      try {
        await client.query('BEGIN');
        const changes = await enforceOfficeForDepartments(client, departmentIds, CONTRACTOR_IDS);
        await client.query('COMMIT');
        return changes;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };

    beforeAll(async () => {
      await resetSchema();
      await pg.pool!.query(MIGRATION);
      await pg.pool!.query(MIGRATION_AUTHOR);
      await pg.pool!.query(MIGRATION_DROP_MODE);
      await pg.pool!.query(MIGRATION_OFFICE);
      current = shift(baseline, 1);
      hours.byEmployee = new Map();
      await pg.pool!.query(`
        INSERT INTO org_departments (id, name) VALUES ('${D_OTHER}', 'Другой отдел');
        INSERT INTO user_profiles (id, full_name) VALUES ('${U_HR}', 'Кадровый админ');
        UPDATE timesheet_object_auto_state
           SET enabled = true, frozen_month = '${baseline}', objects_rebuilt_month = '${baseline}', applied_date = NULL;
        INSERT INTO employees (id, full_name, org_department_id, employment_status,
                               timesheet_export_mode, timesheet_export_object_id, timesheet_export_set_by) VALUES
          (40, 'Сам выбрал ЗИЛ', '${D_OWN}', 'active', 'object', '${ZIL}', 'employee'),
          (41, 'Уже «Офис» от ночи', '${D_OWN}', 'active', 'current_activity', NULL, 'auto'),
          (43, 'Уволен', '${D_OWN}', 'dismissed', 'object', '${DOM}', 'auto'),
          (44, 'В другом отделе', '${D_OTHER}', 'active', 'object', '${DOM}', 'auto'),
          (46, 'Другой отдел, авто', '${D_OTHER}', 'active', 'object', '${ZIL}', 'auto');
        INSERT INTO employees (id, full_name, org_department_id, timesheet_export_mode,
                               timesheet_export_set_by, timesheet_export_set_by_user_id, timesheet_export_set_at) VALUES
          (42, 'Личный «Офис»', '${D_OTHER}', 'current_activity', NULL, '${U_HR}', now());
      `);
    });

    it('миграция 291: таблица, право для admin и hr_admin; повтор ничего не меняет', async () => {
      await pg.pool!.query(MIGRATION_OFFICE);
      expect(await q(`SELECT key, sort_order FROM access_pages WHERE key = '/staff-control/timesheet-office'`))
        .toEqual([{ key: '/staff-control/timesheet-office', sort_order: 164 }]);
      expect(await q(`SELECT role_code, can_view, can_edit FROM role_page_access
                       WHERE page_path = '/staff-control/timesheet-office' ORDER BY role_code`))
        .toEqual([
          { role_code: 'admin', can_view: true, can_edit: true },
          { role_code: 'hr_admin', can_view: true, can_edit: true },
        ]);
    });

    it('правило отдела: «Офис» всем прямым работающим своим при любом источнике; личный, уволенный и чужой — нет', async () => {
      await q('INSERT INTO timesheet_office_departments (org_department_id, created_by) VALUES ($1, $2)', [D_OWN, U_HR]);
      const changes = await enforce([D_OWN]);
      // 1 — без режима, 2 — старый ручной объект админа, 3 — «Офис» без автора, 40 — сам выбрал ЗИЛ.
      expect(changes.map(change => change.employeeId).sort((a, b) => a - b)).toEqual([1, 2, 3, 40]);
      expect(await emp(40)).toEqual({ mode: 'current_activity', object_id: null, set_by: 'auto', user_id: null });
      expect(await emp(41)).toMatchObject({ mode: 'current_activity', set_by: 'auto' });
      expect(await emp(43)).toMatchObject({ mode: 'object', object_id: DOM, set_by: 'auto' });
      expect(await emp(4)).toMatchObject({ mode: null });

      // Повтор — без изменений.
      expect(await enforce([D_OWN])).toEqual([]);
    });

    it('ночь: у сотрудников отдела «Офис» при любых часах; переведённому — поверх ручного выбора; повтор — без изменений', async () => {
      // Перевод в отдел с «Офисом» с ручным объектом из прошлого отдела.
      await q(`UPDATE employees SET org_department_id = $1, timesheet_export_object_id = $2, timesheet_export_set_by = 'manager'
                WHERE id = 44`, [D_OWN, ZIL]);
      hours.byEmployee = new Map([
        [40, [{ value: DOM, label: 'ЖК Дом 56', objectId: DOM, hours: 100 }]],
        [44, [{ value: DOM, label: 'ЖК Дом 56', objectId: DOM, hours: 50 }]],
      ]);
      const result = await recomputeCurrentMonth(new Date(`${current.slice(0, 8)}10T05:00:00+03:00`));
      expect(result).toMatchObject({ kind: 'applied', changed: 1 });
      expect(await emp(40)).toMatchObject({ mode: 'current_activity', set_by: 'auto' });
      expect(await emp(44)).toMatchObject({ mode: 'current_activity', object_id: null, set_by: 'auto' });
      expect(await emp(42)).toMatchObject({ mode: 'current_activity', set_by: null, user_id: U_HR });
      expect(await q(`SELECT entity_id, details->>'old_set_by' AS old_set_by, details->>'reason' AS reason
                        FROM audit_logs WHERE action = 'TIMESHEET_OFFICE_UPDATED'`))
        .toEqual([{ entity_id: '44', old_set_by: 'manager', reason: 'current_month' }]);

      const next = await recomputeCurrentMonth(new Date(`${current.slice(0, 8)}11T05:00:00+03:00`));
      expect(next).toMatchObject({ kind: 'applied', changed: 0 });
    });

    it('ушедший из отдела с «Офисом» — объект снова по часам', async () => {
      await q('UPDATE employees SET org_department_id = $1 WHERE id = 40', [D_OTHER]);
      hours.byEmployee = new Map([[40, [{ value: DOM, label: 'ЖК Дом 56', objectId: DOM, hours: 100 }]]]);
      const result = await recomputeCurrentMonth(new Date(`${current.slice(0, 8)}12T05:00:00+03:00`));
      expect(result).toMatchObject({ kind: 'applied', changed: 1 });
      expect(await emp(40)).toMatchObject({ mode: 'object', object_id: DOM, set_by: 'auto' });
    });

    it('закрытие месяца: перевод в последний день до 04:00 — месяц с «Офисом»; снятие правила после пересчёта дня — по часам', async () => {
      const lastDay = monthEnd(current);
      // Ночью последнего дня (до 04:00): 40 вернули в отдел с «Офисом», у «Другого отдела» тоже «Офис».
      await q('UPDATE employees SET org_department_id = $1 WHERE id = 40', [D_OWN]);
      await q('INSERT INTO timesheet_office_departments (org_department_id) VALUES ($1)', [D_OTHER]);
      hours.byEmployee = new Map([
        [40, [{ value: DOM, label: 'ЖК Дом 56', objectId: DOM, hours: 100 }]],
        [46, [{ value: DOM, label: 'ЖК Дом 56', objectId: DOM, hours: 80 }]],
      ]);
      await recomputeCurrentMonth(new Date(`${lastDay}T05:00:00+03:00`));
      expect(await emp(40)).toMatchObject({ mode: 'current_activity', set_by: 'auto' });
      expect(await emp(46)).toMatchObject({ mode: 'current_activity', set_by: 'auto' });
      // Отдел главнее личного: личный «Офис» 42-го стал «Офисом» отдела — источник auto, автора нет.
      expect(await emp(42)).toEqual({ mode: 'current_activity', object_id: null, set_by: 'auto', user_id: null });

      // После пересчёта дня «Офис» с «Другого отдела» сняли — фиксация считает 46-го по часам.
      await q('DELETE FROM timesheet_office_departments WHERE org_department_id = $1', [D_OTHER]);
      const next = nextMonthStart(current);
      const frozen = await freezeMonth(current, new Date(`${next}T05:00:00+03:00`));
      expect(frozen).toMatchObject({ kind: 'frozen', month: current });
      expect(await q(`SELECT employee_id, mode, object_id::text FROM employee_timesheet_object_months
                        WHERE month = $1::date AND employee_id IN (40, 46) ORDER BY employee_id`, [current]))
        .toEqual([
          { employee_id: 40, mode: 'current_activity', object_id: null },
          { employee_id: 46, mode: 'object', object_id: DOM },
        ]);

      expect(await freezeMonth(current, new Date(`${next}T06:00:00+03:00`)))
        .toEqual({ kind: 'skipped', reason: 'already_frozen' });
    });

    it('окно: личный «Офис» в отделе с «Офисом» — 400; «Вернуть» и снятие с отдела — объект по часам сразу', async () => {
      const req = { user: { id: U_HR }, ip: '127.0.0.1', headers: {}, socket: {} } as never;
      const now = new Date(`${nextMonthStart(current).slice(0, 8)}10T12:00:00+03:00`);

      await updateTimesheetOffice(req, { departments: { add: [], remove: [] }, employees: { add: [46], remove: [] } }, now);
      expect(await emp(46)).toEqual({ mode: 'current_activity', object_id: null, set_by: null, user_id: U_HR });

      // 41 — в отделе с «Офисом»: личного там не бывает.
      await expect(updateTimesheetOffice(req, { departments: { add: [], remove: [] }, employees: { add: [41], remove: [] } }, now))
        .rejects.toMatchObject({ status: 400, code: 'TIMESHEET_OFFICE_INVALID', details: [41] });

      hours.byEmployee = new Map([[46, [{ value: DOM, label: 'ЖК Дом 56', objectId: DOM, hours: 80 }]]]);
      const back = await updateTimesheetOffice(req, { departments: { add: [], remove: [] }, employees: { add: [], remove: [46] } }, now);
      expect(back).toMatchObject({ changed: true, employees_removed: 1, recomputed: 1 });
      expect(await emp(46)).toEqual({ mode: 'object', object_id: DOM, set_by: 'auto', user_id: null });

      // Снятие «Офиса» с отдела: сотрудники с часами — сразу по часам, без часов — «Офис» от авто.
      hours.byEmployee = new Map([
        [40, [{ value: ZIL, label: 'ЗИЛ', objectId: ZIL, hours: 30 }]],
        [44, [{ value: DOM, label: 'ЖК Дом 56', objectId: DOM, hours: 50 }]],
      ]);
      const removed = await updateTimesheetOffice(req, { departments: { add: [], remove: [D_OWN] }, employees: { add: [], remove: [] } }, now);
      expect(removed).toMatchObject({ changed: true, departments_removed: 1, recomputed: 2 });
      expect(await emp(40)).toMatchObject({ mode: 'object', object_id: ZIL, set_by: 'auto' });
      expect(await emp(44)).toMatchObject({ mode: 'object', object_id: DOM, set_by: 'auto' });
      expect(await emp(41)).toMatchObject({ mode: 'current_activity', set_by: 'auto' });
      expect(await q(`SELECT user_id::text, details->>'reason' AS reason, (details->>'changed')::int AS changed
                        FROM audit_logs WHERE action = 'TIMESHEET_OBJECT_AUTO_ASSIGNED' AND details->>'reason' = 'office_removed'
                       ORDER BY id`))
        .toEqual([
          { user_id: U_HR, reason: 'office_removed', changed: 1 },
          { user_id: U_HR, reason: 'office_removed', changed: 2 },
        ]);
    });

    it('пересчёт фиксации месяца после снятия «Офиса» с отдела: по часам за месяц, офис-лидер и личный «Офис» — как были; повтор — no-op', async () => {
      const now = new Date(`${nextMonthStart(current).slice(0, 8)}10T12:00:00+03:00`);
      const frozen = async () => q(
        `SELECT employee_id, mode, object_id::text, set_by FROM employee_timesheet_object_months
          WHERE month = $1::date AND employee_id IN (3, 40, 41, 43, 44) ORDER BY employee_id`, [current],
      );
      // Месяц зафиксирован «Офисом» отдела; 3-му в фиксации — личный «Офис» окна.
      await q(`UPDATE employee_timesheet_object_months SET set_by = NULL, set_by_user_id = $2, set_at = now()
                WHERE month = $1::date AND employee_id = 3`, [current, U_HR]);
      const before = await frozen();
      expect(before).toEqual([
        { employee_id: 3, mode: 'current_activity', object_id: null, set_by: null },
        { employee_id: 40, mode: 'current_activity', object_id: null, set_by: 'auto' },
        { employee_id: 41, mode: 'current_activity', object_id: null, set_by: 'auto' },
        { employee_id: 43, mode: 'object', object_id: DOM, set_by: 'auto' },
        { employee_id: 44, mode: 'current_activity', object_id: null, set_by: 'auto' },
      ]);
      hours.byEmployee = new Map([
        [3, [{ value: DOM, label: 'ЖК Дом 56', objectId: DOM, hours: 90 }]],
        [40, [{ value: DOM, label: 'ЖК Дом 56', objectId: DOM, hours: 100 }, { value: 'office', label: 'Офис', objectId: null, hours: 20 }]],
        [41, [{ value: 'office', label: 'Офис', objectId: null, hours: 150 }, { value: ZIL, label: 'ЗИЛ', objectId: ZIL, hours: 10 }]],
        [43, [{ value: ZIL, label: 'ЗИЛ', objectId: ZIL, hours: 50 }]],
        [44, [{ value: ZIL, label: 'ЗИЛ', objectId: ZIL, hours: 60 }]],
      ]);
      const auditCount = async () => Number((await q<{ n: string }>(
        `SELECT count(*) AS n FROM audit_logs WHERE details->>'reason' = 'month_refreeze'`))[0].n);

      const dry = await refreezeDepartmentMonth({ month: current, departmentId: D_OWN, dryRun: true, now });
      expect(dry.changes.map(change => change.employeeId)).toEqual([40, 43, 44]);
      expect(dry).toMatchObject({ personalOffice: 1, appliedIds: [], withoutFreezeRow: [] });
      expect(dry.employeeIds).toEqual([1, 2, 3, 40, 41, 43, 44]);
      expect(await frozen()).toEqual(before);
      expect(await auditCount()).toBe(0);

      const applied = await refreezeDepartmentMonth({ month: current, departmentId: D_OWN, dryRun: false, now });
      expect(applied.appliedIds).toEqual([40, 43, 44]);
      expect(await frozen()).toEqual([
        { employee_id: 3, mode: 'current_activity', object_id: null, set_by: null },
        { employee_id: 40, mode: 'object', object_id: DOM, set_by: 'auto' },
        { employee_id: 41, mode: 'current_activity', object_id: null, set_by: 'auto' },
        { employee_id: 43, mode: 'object', object_id: ZIL, set_by: 'auto' },
        { employee_id: 44, mode: 'object', object_id: ZIL, set_by: 'auto' },
      ]);
      expect(await q(`SELECT entity_id, (details->>'changed')::int AS changed FROM audit_logs
                       WHERE details->>'reason' = 'month_refreeze'`))
        .toEqual([{ entity_id: `refreeze:${current}:${D_OWN}`, changed: 3 }]);
      // Табель и 1С за прошедший месяц читают фиксацию.
      const resolved = await resolveExportModes([40], undefined, { month: current, now });
      expect(resolved.get(40)).toMatchObject({ mode: 'object', pinnedObjectId: DOM });

      const again = await refreezeDepartmentMonth({ month: current, departmentId: D_OWN, dryRun: false, now });
      expect(again).toMatchObject({ changes: [], appliedIds: [] });
      expect(await auditCount()).toBe(1);
    });

    it('пересчёт фиксации: отказ, если у отдела стоит «Офис» или месяц не зафиксирован', async () => {
      const now = new Date(`${nextMonthStart(current).slice(0, 8)}10T12:00:00+03:00`);
      await q('INSERT INTO timesheet_office_departments (org_department_id) VALUES ($1)', [D_OTHER]);
      await expect(refreezeDepartmentMonth({ month: current, departmentId: D_OTHER, dryRun: true, now }))
        .rejects.toThrow(/сначала снимите/);
      await q('DELETE FROM timesheet_office_departments WHERE org_department_id = $1', [D_OTHER]);

      const later = new Date(`${shift(current, 2).slice(0, 8)}10T12:00:00+03:00`);
      await expect(refreezeDepartmentMonth({ month: nextMonthStart(current), departmentId: D_OWN, dryRun: true, now: later }))
        .rejects.toThrow(/ещё не зафиксирован/);
    });
  });
  // Рабочие (роль «Рабочий» или бригадник без учётки): «По СКУД» вместо объекта по часам —
  // ночь, фиксация месяца и разовая правка уже зафиксированного месяца.
  describe('рабочие — «По СКУД» (правило рабочих)', () => {
    const TECH = '00000000-0000-0000-0000-00000000b100';
    const SU10 = '2cd8a403-6454-408b-9c2b-8a2db65c7511';
    const FOLDER = '00000000-0000-0000-0000-00000000b101';
    const BRIG = '00000000-0000-0000-0000-00000000b102';
    const FIRED_DEPT = '00000000-0000-0000-0000-00000000b103';
    const D_OFFICE = '00000000-0000-0000-0000-00000000b104';
    const R_WORKER = '00000000-0000-0000-0000-00000000e0b1';
    const R_OFFICE = '00000000-0000-0000-0000-00000000e0b2';
    const U_HR = '00000000-0000-0000-0000-00000000e0b3';
    let current = '';
    let next = '';

    const emp = async (id: number) => (await q(
      `SELECT timesheet_export_mode AS mode, timesheet_export_object_id::text AS object_id,
              timesheet_export_set_by AS set_by
         FROM employees WHERE id = $1`, [id],
    ))[0];
    const frozenRows = async (ids: number[]) => q(
      `SELECT employee_id, mode, object_id::text, set_by FROM employee_timesheet_object_months
        WHERE month = $1::date AND employee_id = ANY($2::int[]) ORDER BY employee_id`, [current, ids],
    );

    beforeAll(async () => {
      await resetSchema();
      await pg.pool!.query(MIGRATION);
      await pg.pool!.query(MIGRATION_AUTHOR);
      await pg.pool!.query(MIGRATION_DROP_MODE);
      await pg.pool!.query(MIGRATION_OFFICE);
      current = shift(baseline, 1);
      next = nextMonthStart(current);
      hours.byEmployee = new Map();
      await pg.pool!.query(`
        DROP TABLE IF EXISTS employee_dismissal_events;
        CREATE TABLE employee_dismissal_events (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id integer NOT NULL, dismissal_date date NULL,
          cancelled boolean NOT NULL DEFAULT false, from_department_id uuid NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO org_departments (id, name, parent_id, kind) VALUES
          ('${TECH}', 'Объект', NULL, 'object'),
          ('${SU10}', '(СУ-10) ООО СУ-10', '${TECH}', 'department'),
          ('${FOLDER}', 'Бригады', '${SU10}', 'department'),
          ('${BRIG}', 'бр.Тестов Т.Т.', '${FOLDER}', 'brigade'),
          ('${FIRED_DEPT}', 'Уволенные', '${TECH}', 'department'),
          ('${D_OFFICE}', 'ОТиТБ', '${SU10}', 'department');
        INSERT INTO system_roles (id, code, name) VALUES
          ('${R_WORKER}', 'worker', 'Рабочий'), ('${R_OFFICE}', 'office', 'Офисный сотрудник');
        UPDATE timesheet_object_auto_state
           SET enabled = true, frozen_month = '${baseline}', objects_rebuilt_month = '${baseline}', applied_date = NULL;
        INSERT INTO employees (id, full_name, org_department_id, employment_status,
                               timesheet_export_mode, timesheet_export_object_id, timesheet_export_set_by) VALUES
          (60, 'Рабочий по роли', '${D_OWN}', 'active', 'object', '${ZIL}', 'auto'),
          (61, 'Бригадник без учётки', '${BRIG}', 'active', NULL, NULL, NULL),
          (62, 'Энергетик в бригадах', '${BRIG}', 'active', 'object', '${ZIL}', 'auto'),
          (64, 'Рабочий подрядчика', '${CONTR}', 'active', NULL, NULL, NULL),
          (65, 'Уволенный рабочий', '${FIRED_DEPT}', 'fired', 'object', '${DOM}', 'auto'),
          (66, 'Давно уволенный бригадник', '${FIRED_DEPT}', 'fired', NULL, NULL, NULL),
          (67, 'Рабочий в отделе с «Офисом»', '${D_OFFICE}', 'active', 'object', '${DOM}', 'auto'),
          (68, 'Рабочий, ручной «По СКУД»', '${D_OWN}', 'active', 'skud', NULL, NULL),
          (69, 'Уволенный бригадник без учётки', '${FIRED_DEPT}', 'fired', 'object', '${DOM}', 'auto'),
          (70, 'Уволенный не рабочий', '${FIRED_DEPT}', 'fired', 'object', '${DOM}', 'auto'),
          (71, 'Уволенный рабочий из отдела с «Офисом»', '${FIRED_DEPT}', 'fired', 'object', '${DOM}', 'auto');
        INSERT INTO user_profiles (id, full_name, employee_id, system_role_id) VALUES
          ('${U_HR}', 'Кадровик', NULL, '${R_OFFICE}'),
          ('00000000-0000-0000-0000-00000000f060', 'Рабочий по роли', 60, '${R_WORKER}'),
          ('00000000-0000-0000-0000-00000000f062', 'Энергетик', 62, '${R_OFFICE}'),
          ('00000000-0000-0000-0000-00000000f063', 'Личный «Офис»', 63, '${R_WORKER}'),
          ('00000000-0000-0000-0000-00000000f064', 'Подрядчик', 64, '${R_WORKER}'),
          ('00000000-0000-0000-0000-00000000f065', 'Уволенный', 65, '${R_WORKER}'),
          ('00000000-0000-0000-0000-00000000f067', 'Офис отдела', 67, '${R_WORKER}'),
          ('00000000-0000-0000-0000-00000000f068', 'Ручной', 68, '${R_WORKER}'),
          ('00000000-0000-0000-0000-00000000f071', 'Офис отдела, уволен', 71, '${R_WORKER}');
        INSERT INTO employees (id, full_name, org_department_id, timesheet_export_mode,
                               timesheet_export_set_by, timesheet_export_set_by_user_id, timesheet_export_set_at) VALUES
          (63, 'Рабочий с личным «Офисом»', '${D_OWN}', 'current_activity', NULL, '${U_HR}', now());
        INSERT INTO employee_dismissal_events (employee_id, dismissal_date, from_department_id) VALUES
          (65, '${current}', '${D_OWN}'),
          (66, '${baseline}', '${BRIG}'),
          (69, '${current}', '${BRIG}'),
          (70, '${current}', '${D_OWN}'),
          (71, '${current}', '${D_OFFICE}');
        INSERT INTO timesheet_office_departments (org_department_id, created_by) VALUES ('${D_OFFICE}', '${U_HR}');
      `);
    });

    it('ночь: рабочим skud/auto без учёта часов; не рабочий в бригадах — по часам; личный «Офис», подрядчик и «Офис» отдела главнее', async () => {
      hours.byEmployee = new Map([
        [60, [{ value: DOM, label: 'ЖК Дом 56', objectId: DOM, hours: 100 }]],
        [62, [{ value: DOM, label: 'ЖК Дом 56', objectId: DOM, hours: 90 }]],
      ]);
      const result = await recomputeCurrentMonth(new Date(`${current.slice(0, 8)}10T05:00:00+03:00`));
      expect(result).toMatchObject({ kind: 'applied' });
      expect(await emp(60)).toEqual({ mode: 'skud', object_id: null, set_by: 'auto' });
      expect(await emp(61)).toEqual({ mode: 'skud', object_id: null, set_by: 'auto' });
      expect(await emp(68)).toEqual({ mode: 'skud', object_id: null, set_by: 'auto' });
      expect(await emp(62)).toEqual({ mode: 'object', object_id: DOM, set_by: 'auto' });
      expect(await emp(63)).toEqual({ mode: 'current_activity', object_id: null, set_by: null });
      expect(await emp(64)).toEqual({ mode: null, object_id: null, set_by: null });
      expect(await emp(67)).toEqual({ mode: 'current_activity', object_id: null, set_by: 'auto' });
      // Уволенных ночь не трогает.
      expect(await emp(65)).toEqual({ mode: 'object', object_id: DOM, set_by: 'auto' });
      const audit = await q<{ changes: Array<{ id: number; to_mode: string }> }>(
        `SELECT details->'changes' AS changes FROM audit_logs
          WHERE action = 'TIMESHEET_OBJECT_AUTO_ASSIGNED' AND details->>'reason' = 'current_month'`,
      );
      expect(audit[0].changes.filter(change => change.to_mode === 'skud').map(change => change.id).sort())
        .toEqual([60, 61, 68]);

      // Повтор на следующий день — без изменений.
      const again = await recomputeCurrentMonth(new Date(`${current.slice(0, 8)}11T05:00:00+03:00`));
      expect(again).toMatchObject({ kind: 'applied', changed: 0 });
      // Резолвер отдаёт источник: skud/auto — правило рабочих.
      expect((await resolveExportModes([60, 62])).get(60)).toMatchObject({ mode: 'skud', setBy: 'auto' });
    });

    it('фиксация месяца: рабочим skud/auto, уволенному — как в карточке', async () => {
      const frozen = await freezeMonth(current, new Date(`${next}T04:30:00+03:00`));
      expect(frozen).toMatchObject({ kind: 'frozen', month: current });
      expect(await frozenRows([60, 61, 62, 65, 66])).toEqual([
        { employee_id: 60, mode: 'skud', object_id: null, set_by: 'auto' },
        { employee_id: 61, mode: 'skud', object_id: null, set_by: 'auto' },
        { employee_id: 62, mode: 'object', object_id: DOM, set_by: 'auto' },
        { employee_id: 65, mode: 'object', object_id: DOM, set_by: 'auto' },
        { employee_id: 66, mode: null, object_id: null, set_by: null },
      ]);
      const resolved = await resolveExportModes([60], undefined, { month: current, now: new Date(`${next}T12:00:00+03:00`) });
      expect(resolved.get(60)).toMatchObject({ mode: 'skud', setBy: 'auto' });
    });

    it('правка зафиксированного месяца: рабочие → skud/auto, у уволенного отдел — до увольнения; повтор — 0, маркер пересборки — только при изменениях', async () => {
      // Месяц как зафиксированный до правила: объект по часам, NULL, ручной «По СКУД».
      await q(`UPDATE employee_timesheet_object_months SET mode = 'object', object_id = $2, set_by = 'auto'
                WHERE month = $1::date AND employee_id = 60`, [current, ZIL]);
      await q(`UPDATE employee_timesheet_object_months SET mode = NULL, set_by = NULL
                WHERE month = $1::date AND employee_id = 61`, [current]);
      await q(`UPDATE employee_timesheet_object_months SET mode = 'skud', set_by = NULL
                WHERE month = $1::date AND employee_id = 68`, [current]);
      await q(`UPDATE timesheet_object_auto_state SET objects_rebuilt_month = $1::date`, [current]);

      const dry = await fixWorkersFrozenMonth({ month: current, dryRun: true });
      // 66 — давно уволен (NULL), 70 — не рабочий, 71 — отдел до увольнения с «Офисом».
      expect(dry.frozen.map(row => row.employeeId)).toEqual([60, 61, 65, 68, 69]);
      expect(dry.live.map(row => row.employeeId)).toEqual([65, 69]);
      expect(dry.rebuildRequested).toBe(false);
      expect((await frozenRows([60]))[0]).toMatchObject({ mode: 'object' });

      const applied = await fixWorkersFrozenMonth({ month: current, dryRun: false });
      expect(applied.frozen.map(row => row.employeeId)).toEqual([60, 61, 65, 68, 69]);
      expect(applied.rebuildRequested).toBe(true);
      expect(await frozenRows([60, 61, 62, 63, 65, 66, 67, 68, 69, 70, 71])).toEqual([
        { employee_id: 60, mode: 'skud', object_id: null, set_by: 'auto' },
        { employee_id: 61, mode: 'skud', object_id: null, set_by: 'auto' },
        { employee_id: 62, mode: 'object', object_id: DOM, set_by: 'auto' },
        { employee_id: 63, mode: 'current_activity', object_id: null, set_by: null },
        { employee_id: 65, mode: 'skud', object_id: null, set_by: 'auto' },
        { employee_id: 66, mode: null, object_id: null, set_by: null },
        { employee_id: 67, mode: 'current_activity', object_id: null, set_by: 'auto' },
        { employee_id: 68, mode: 'skud', object_id: null, set_by: 'auto' },
        { employee_id: 69, mode: 'skud', object_id: null, set_by: 'auto' },
        { employee_id: 70, mode: 'object', object_id: DOM, set_by: 'auto' },
        { employee_id: 71, mode: 'object', object_id: DOM, set_by: 'auto' },
      ]);
      expect(await emp(65)).toEqual({ mode: 'skud', object_id: null, set_by: 'auto' });
      expect(await emp(69)).toEqual({ mode: 'skud', object_id: null, set_by: 'auto' });
      expect(await emp(70)).toEqual({ mode: 'object', object_id: DOM, set_by: 'auto' });
      expect((await q<{ m: string }>('SELECT objects_rebuilt_month::text AS m FROM timesheet_object_auto_state'))[0].m)
        .toBe(baseline);
      expect(await q(`SELECT entity_id, (details->>'frozen_changed')::int AS f, (details->>'live_changed')::int AS l
                        FROM audit_logs WHERE details->>'reason' = 'workers_skud'`))
        .toEqual([{ entity_id: `workers:${current}`, f: 5, l: 2 }]);

      // Повтор — 0 изменений, маркер не трогается, аудита нет.
      await q(`UPDATE timesheet_object_auto_state SET objects_rebuilt_month = $1::date`, [current]);
      const again = await fixWorkersFrozenMonth({ month: current, dryRun: false });
      expect(again).toMatchObject({ frozen: [], live: [], rebuildRequested: false });
      expect((await q<{ m: string }>('SELECT objects_rebuilt_month::text AS m FROM timesheet_object_auto_state'))[0].m)
        .toBe(current);
      expect(Number((await q<{ n: string }>(`SELECT count(*) AS n FROM audit_logs WHERE details->>'reason' = 'workers_skud'`))[0].n))
        .toBe(1);
    });

    it('правка месяца: отказ для незафиксированного и базового месяца', async () => {
      await expect(fixWorkersFrozenMonth({ month: next, dryRun: true })).rejects.toThrow(/не зафиксирован/);
      await expect(fixWorkersFrozenMonth({ month: baseline, dryRun: true })).rejects.toThrow(/не позже базового/);
    });
  });
  // «Офис» из окна «Режим табелирования», поставленный после фиксации месяца: правка ставит
  // его в строках фиксации всем, кто сейчас в окне.
  describe('«Офис» окна в зафиксированном месяце', () => {
    const D_OFFICE = '00000000-0000-0000-0000-00000000c104';
    const U_HR = '00000000-0000-0000-0000-00000000c0b3';
    let month = '';

    const frozen = async (ids: number[]) => q(
      `SELECT employee_id, mode, object_id::text, set_by, set_by_user_id::text AS author, (set_at IS NOT NULL) AS has_set_at
         FROM employee_timesheet_object_months WHERE month = $1::date AND employee_id = ANY($2::int[]) ORDER BY employee_id`,
      [month, ids],
    );

    beforeAll(async () => {
      await resetSchema();
      await pg.pool!.query(MIGRATION);
      await pg.pool!.query(MIGRATION_AUTHOR);
      await pg.pool!.query(MIGRATION_DROP_MODE);
      await pg.pool!.query(MIGRATION_OFFICE);
      month = shift(baseline, 1);
      await pg.pool!.query(`
        INSERT INTO org_departments (id, name) VALUES ('${D_OFFICE}', 'УОК-Офис');
        INSERT INTO user_profiles (id, full_name) VALUES ('${U_HR}', 'Кадровик');
        INSERT INTO employees (id, full_name, org_department_id, employment_status,
                               timesheet_export_mode, timesheet_export_object_id, timesheet_export_set_by) VALUES
          (80, 'Отдел с «Офисом», объект в фиксации', '${D_OFFICE}', 'active', 'current_activity', NULL, 'auto'),
          (81, 'Отдел с «Офисом», уже «Офис»', '${D_OFFICE}', 'active', 'current_activity', NULL, 'auto'),
          (84, 'Уволенный из отдела с «Офисом»', '${D_OFFICE}', 'fired', 'object', '${DOM}', 'auto'),
          (85, 'Подрядчик в отделе с «Офисом»', '${CONTR}', 'active', 'object', '${DOM}', 'auto'),
          (86, 'Не в окне', '${D_OWN}', 'active', 'object', '${ZIL}', 'auto');
        INSERT INTO employees (id, full_name, org_department_id, timesheet_export_mode,
                               timesheet_export_set_by, timesheet_export_set_by_user_id, timesheet_export_set_at) VALUES
          (82, 'Личный «Офис», объект в фиксации', '${D_OWN}', 'current_activity', NULL, '${U_HR}', '2026-09-30T10:05:00Z'),
          (83, 'Личный «Офис», уже «Офис»', '${D_OWN}', 'current_activity', NULL, '${U_HR}', '2026-09-30T10:06:00Z');
        INSERT INTO timesheet_office_departments (org_department_id, created_by) VALUES ('${D_OFFICE}', '${U_HR}'), ('${CONTR}', '${U_HR}');
        INSERT INTO employee_timesheet_object_months (employee_id, month, mode, object_id, set_by) VALUES
          (80, '${month}', 'object', '${ZIL}', 'auto'),
          (81, '${month}', 'current_activity', NULL, 'auto'),
          (82, '${month}', 'object', '${DOM}', 'auto'),
          (84, '${month}', 'object', '${DOM}', 'auto'),
          (85, '${month}', 'object', '${DOM}', 'auto'),
          (86, '${month}', 'object', '${ZIL}', 'auto');
        INSERT INTO employee_timesheet_object_months (employee_id, month, mode, object_id, set_by, set_by_user_id, set_at) VALUES
          (83, '${month}', 'current_activity', NULL, NULL, '${U_HR}', '2026-09-30T10:06:00Z');
        UPDATE timesheet_object_auto_state
           SET enabled = true, frozen_month = '${month}', objects_rebuilt_month = '${month}', applied_date = NULL;
      `);
    });

    it('«Офис» отдела и личный — в строках фиксации; уже «Офис», уволенный, подрядчик и не из окна — нет; маркер пересборки только при изменениях; повтор — 0', async () => {
      const dry = await applyOfficeWindowToFrozenMonth({ month, dryRun: true });
      expect(dry.rows.map(row => [row.employeeId, row.via])).toEqual([[80, 'department'], [82, 'personal']]);
      expect((await frozen([80]))[0]).toMatchObject({ mode: 'object' });

      const applied = await applyOfficeWindowToFrozenMonth({ month, dryRun: false });
      expect(applied.rows.map(row => row.employeeId)).toEqual([80, 82]);
      expect(applied.rebuildRequested).toBe(true);
      expect(await frozen([80, 81, 82, 83, 84, 85, 86])).toEqual([
        { employee_id: 80, mode: 'current_activity', object_id: null, set_by: 'auto', author: null, has_set_at: false },
        { employee_id: 81, mode: 'current_activity', object_id: null, set_by: 'auto', author: null, has_set_at: false },
        { employee_id: 82, mode: 'current_activity', object_id: null, set_by: null, author: U_HR, has_set_at: true },
        { employee_id: 83, mode: 'current_activity', object_id: null, set_by: null, author: U_HR, has_set_at: true },
        { employee_id: 84, mode: 'object', object_id: DOM, set_by: 'auto', author: null, has_set_at: false },
        { employee_id: 85, mode: 'object', object_id: DOM, set_by: 'auto', author: null, has_set_at: false },
        { employee_id: 86, mode: 'object', object_id: ZIL, set_by: 'auto', author: null, has_set_at: false },
      ]);
      expect((await q<{ m: string }>('SELECT objects_rebuilt_month::text AS m FROM timesheet_object_auto_state'))[0].m)
        .toBe(minusMonth(month));
      expect(await q(`SELECT entity_id, (details->>'changed')::int AS changed FROM audit_logs
                       WHERE details->>'reason' = 'office_window_month'`))
        .toEqual([{ entity_id: `office:${month}`, changed: 2 }]);
      // Табель и 1С за этот месяц читают фиксацию: личный «Офис» узнаётся и в ней.
      const resolved = await resolveExportModes([80, 82], undefined, { month, now: new Date(`${nextMonthStart(month)}T12:00:00+03:00`) });
      expect(resolved.get(80)).toMatchObject({ mode: 'current_activity' });
      expect(resolved.get(82)).toMatchObject({ mode: 'current_activity' });

      await q(`UPDATE timesheet_object_auto_state SET objects_rebuilt_month = $1::date`, [month]);
      const again = await applyOfficeWindowToFrozenMonth({ month, dryRun: false });
      expect(again).toMatchObject({ rows: [], rebuildRequested: false });
      expect((await q<{ m: string }>('SELECT objects_rebuilt_month::text AS m FROM timesheet_object_auto_state'))[0].m).toBe(month);
    });

    it('отказ для незафиксированного и базового месяца', async () => {
      await expect(applyOfficeWindowToFrozenMonth({ month: nextMonthStart(month), dryRun: true })).rejects.toThrow(/не зафиксирован/);
      await expect(applyOfficeWindowToFrozenMonth({ month: baseline, dryRun: true })).rejects.toThrow(/не позже базового/);
    });
  });
});
