import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Request } from 'express';

// Тип зоны точки доступа с датой начала (миграция 305) на настоящем PostgreSQL: миграция и её
// повтор, граница рабочих дней 30.09 / 01.10 в SQL-функциях, ночная смена через границу, смена
// типа с блокировкой, очередь пересборки, пометка версий для 1С и идемпотентность пересборки.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы-заглушки пересоздаются).

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

// «Дорога» проверяется своими тестами; здесь — только то, что пересборка её вызывает и что
// решение, оставшееся без сегмента, попадает в аудит. Мок удаляет сегменты диапазона.
const travel = vi.hoisted(() => ({ calls: [] as Array<{ employeeIds: number[]; startDate: string; endDate: string }> }));
vi.mock('./skud-travel.service.js', () => ({
  invalidateTravelSegmentsCache: vi.fn(),
  calculateAndSyncTravelSegments: vi.fn(async (params: { employeeIds: number[]; startDate: string; endDate: string }) => {
    travel.calls.push(params);
    await pg.pool!.query(
      'DELETE FROM skud_travel_segments WHERE employee_id = ANY($1::bigint[]) AND work_date BETWEEN $2 AND $3',
      [params.employeeIds, params.startDate, params.endDate],
    );
    return { segments: [], summaryByDay: new Map(), syncedAt: new Date().toISOString() };
  }),
}));
vi.mock('./skud-realtime.service.js', () => ({ notifySkudRealtimeChanged: vi.fn() }));
// Смена типа будит воркер в фоне — в тесте очередь разбираем сами, иначе он гонится с проверками.
vi.mock('./access-point-zone-reconcile.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./access-point-zone-reconcile.service.js')>()),
  kickAccessPointZoneReconcile: vi.fn(),
}));
vi.mock('./sigur.service.js', () => ({ sigurService: { isConfigured: vi.fn(async () => false), getAccessPoints: vi.fn() } }));

import { changeAccessPointZone } from './access-point-zone.service.js';
import {
  buildZoneChangePlan, reconcileAccessPointZone, runZoneReconcileOnce, stopAccessPointZoneReconcileWorker,
} from './access-point-zone-reconcile.service.js';
import { getInternalAccessPoints, getInternalPointsByWorkDate, invalidateInternalPointsCache } from './skud-shared.service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../docs/migrations/', import.meta.url));
const read = (name: string): string => readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf8');
const MIGRATION = read('305_skud_access_point_zone_periods.sql');

/** Определение одной функции из файла миграции — как на проде перед 305. */
const functionFrom = (file: string, name: string): string => {
  const match = read(file).match(new RegExp(`CREATE OR REPLACE FUNCTION\\s+public\\.${name}\\s*\\([\\s\\S]*?AS\\s+(\\$\\w*\\$)[\\s\\S]*?\\1;`));
  if (!match) throw new Error(`Функция ${name} не найдена в ${file}`);
  return match[0];
};

const POINT = 'кпп ASTERUS';
const actor = { req: { ip: '127.0.0.1', headers: {}, socket: {} } as unknown as Request, userId: null };

const q = async <T extends import('pg').QueryResultRow>(sql: string, params?: unknown[]) =>
  (await pg.pool!.query<T>(sql, params)).rows;

const addEvent = (employeeId: number, date: string, time: string, direction: 'entry' | 'exit', point: string) =>
  pg.pool!.query(
    'INSERT INTO skud_events (employee_id, event_date, event_time, direction, access_point) VALUES ($1, $2, $3, $4, $5)',
    [employeeId, date, time, direction, point],
  );

const recalc = (employeeId: number, date: string) =>
  pg.pool!.query('SELECT public.recalculate_skud_daily_summary(NULL::uuid, $1::bigint, $2::date)', [employeeId, date]);

const summary = async (employeeId: number, date: string) =>
  (await q<{ first_entry: string | null; total_minutes: number | null; is_present: boolean }>(
    'SELECT first_entry::text AS first_entry, total_minutes, is_present FROM skud_daily_summary WHERE employee_id = $1 AND date = $2',
    [employeeId, date],
  ))[0] ?? null;

const resetSchema = async (): Promise<void> => {
  await pg.pool!.query(`
    DROP TABLE IF EXISTS skud_access_point_zone_periods, skud_access_point_zone_reconcile, skud_access_point_settings,
      skud_events, skud_daily_summary, skud_event_failures, skud_travel_segments, skud_object_access_points,
      employee_schedule_assignments, work_schedules, timesheet_approval_employees, timesheet_approvals, audit_logs CASCADE;
    DROP FUNCTION IF EXISTS public.recalculate_skud_daily_summary(uuid, bigint, date);
    DROP FUNCTION IF EXISTS public.batch_recalculate_skud_daily_summary(jsonb);
    DROP FUNCTION IF EXISTS public.is_skud_anomalous_day(bigint, date, boolean);
    DROP FUNCTION IF EXISTS public.is_night_shift_for(bigint, date);
    DROP FUNCTION IF EXISTS public.is_access_point_internal(text, date);

    CREATE TABLE skud_access_point_settings (
      id bigserial PRIMARY KEY, department_id uuid NOT NULL, access_point_name text NOT NULL,
      is_internal boolean DEFAULT false, created_at timestamptz DEFAULT now()
    );
    CREATE TABLE skud_events (
      id bigserial PRIMARY KEY, employee_id bigint, event_date date NOT NULL, event_time time NOT NULL,
      direction text, access_point text
    );
    CREATE TABLE skud_daily_summary (
      id bigserial PRIMARY KEY, employee_id bigint NOT NULL, date date NOT NULL, first_entry time, last_exit time,
      total_hours numeric, break_hours numeric, total_minutes integer, break_minutes integer, is_present boolean,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), UNIQUE (employee_id, date)
    );
    CREATE TABLE skud_event_failures (employee_id bigint, event_date date);
    CREATE TABLE skud_travel_segments (
      id bigserial PRIMARY KEY, employee_id bigint NOT NULL, work_date date NOT NULL, exit_time time NOT NULL,
      entry_time time NOT NULL, from_access_point_name text, to_access_point_name text, status text NOT NULL,
      credited_minutes integer NOT NULL DEFAULT 0, approved_by uuid, approved_at timestamptz, approval_comment text
    );
    CREATE TABLE skud_object_access_points (object_id uuid, access_point_name text NOT NULL);
    CREATE TABLE work_schedules (
      id uuid PRIMARY KEY, cycle_days jsonb, day_overrides jsonb, work_start time, work_end time
    );
    CREATE TABLE employee_schedule_assignments (
      employee_id bigint NOT NULL, schedule_id uuid NOT NULL REFERENCES work_schedules(id),
      effective_from date NOT NULL, effective_to date
    );
    CREATE TABLE timesheet_approvals (
      id bigserial PRIMARY KEY, status text NOT NULL, unlocked_at timestamptz, start_date date NOT NULL, end_date date NOT NULL,
      version_dirty_seq bigint NOT NULL DEFAULT 0, version_dirty_at timestamptz, version_rebuild_attempts integer NOT NULL DEFAULT 0,
      version_rebuild_after timestamptz, version_rebuild_last_error text
    );
    CREATE TABLE timesheet_approval_employees (approval_id bigint NOT NULL, employee_id bigint NOT NULL);
    DROP TABLE IF EXISTS org_departments CASCADE;
    CREATE TABLE org_departments (id uuid PRIMARY KEY, parent_id uuid, created_at timestamptz DEFAULT now());
    CREATE TABLE audit_logs (
      id serial PRIMARY KEY, user_id uuid, action text, entity_type text, entity_id text, details jsonb,
      ip_address text, user_agent text, created_at timestamptz DEFAULT now()
    );
  `);
  // Функции — как на проде перед миграцией: batch из 119, аномалии из 161, ночной гейт и recalc из 168.
  await pg.pool!.query(functionFrom('168_skud_night_shift_gate.sql', 'is_night_shift_for'));
  await pg.pool!.query(functionFrom('168_skud_night_shift_gate.sql', 'recalculate_skud_daily_summary'));
  await pg.pool!.query(functionFrom('119_night_shift_skud_summary.sql', 'batch_recalculate_skud_daily_summary'));
  await pg.pool!.query(functionFrom('161_skud_summary_sum_of_pairs.sql', 'is_skud_anomalous_day'));
  // Прод перед миграцией: «Коридор» и «кпп ASTERUS» отмечены внутренними.
  await pg.pool!.query(
    `INSERT INTO skud_access_point_settings (department_id, access_point_name, is_internal) VALUES
       ('00000000-0000-0000-0000-000000000001', 'Коридор', true),
       ('00000000-0000-0000-0000-000000000001', 'кпп ASTERUS', true),
       ('00000000-0000-0000-0000-000000000002', 'Коридор ', true)`,
  );
  await pg.pool!.query(`INSERT INTO skud_object_access_points (access_point_name) VALUES ('Склад'), ('ALIA'), ('кпп ASTERUS')`);
  await pg.pool!.query(MIGRATION);
  invalidateInternalPointsCache();
  travel.calls.length = 0;
};

describe.skipIf(!PG_URL)('тип зоны точки доступа с датой начала (PG)', () => {
  beforeAll(async () => {
    await resetSchema();
  });

  beforeEach(async () => {
    await resetSchema();
    // 13.10.2026 12:00 МСК; подменяем только Date — таймеры нужны pg.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T09:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    stopAccessPointZoneReconcileWorker();
    await pg.pool?.end();
  });

  it('миграция: внутренние точки перенесены «с самого начала», ASTERUS внешняя с 01.10; повтор безопасен', async () => {
    await pg.pool!.query(MIGRATION);
    const rows = await q<{ access_point_name: string; is_internal: boolean; effective_from: string }>(
      `SELECT access_point_name, is_internal, effective_from::text AS effective_from
         FROM skud_access_point_zone_periods ORDER BY access_point_name, effective_from`,
    );
    // «Коридор» отмечен в двух отделах (один раз с пробелом) — в истории одна строка.
    expect(rows).toEqual([
      { access_point_name: 'Коридор', is_internal: true, effective_from: '2000-01-01' },
      { access_point_name: POINT, is_internal: true, effective_from: '2000-01-01' },
      { access_point_name: POINT, is_internal: false, effective_from: '2026-10-01' },
    ]);

    const zones = await getInternalPointsByWorkDate();
    expect(zones.has(POINT, '2026-09-30')).toBe(true);
    expect(zones.has(POINT, '2026-10-01')).toBe(false);
  });

  it('миграция: preflight останавливает замену функции с чужим телом', async () => {
    await pg.pool!.query(`
      CREATE OR REPLACE FUNCTION public.is_skud_anomalous_day(p_employee_id bigint, p_date date, p_scheduled boolean DEFAULT true)
      RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    `);
    await expect(pg.pool!.query(MIGRATION)).rejects.toThrow(/is_skud_anomalous_day/);
  });

  it('сводка: рабочий день 30.09 — точка внутренняя, 01.10 — внешняя', async () => {
    for (const date of ['2026-09-30', '2026-10-01']) {
      await addEvent(1, date, '09:00', 'entry', POINT);
      await addEvent(1, date, '18:00', 'exit', POINT);
      await recalc(1, date);
    }
    expect(await summary(1, '2026-09-30')).toEqual({ first_entry: null, total_minutes: null, is_present: false });
    expect(await summary(1, '2026-10-01')).toEqual({ first_entry: '09:00:00', total_minutes: 540, is_present: true });
  });

  it('ночная смена 30.09 с выходом через точку 01.10 считается по правилу 30.09', async () => {
    await pg.pool!.query(
      `INSERT INTO work_schedules (id, work_start, work_end) VALUES ('00000000-0000-0000-0000-0000000000aa', '20:00', '06:00')`,
    );
    await pg.pool!.query(
      `INSERT INTO employee_schedule_assignments (employee_id, schedule_id, effective_from)
       VALUES (2, '00000000-0000-0000-0000-0000000000aa', '2026-01-01')`,
    );
    await addEvent(2, '2026-09-30', '20:00', 'entry', 'ALIA');
    await addEvent(2, '2026-10-01', '06:00', 'exit', POINT);
    await recalc(2, '2026-09-30');
    // Выход 01.10 через точку относится к смене 30.09, а для неё точка внутренняя: пара не закрыта.
    expect(await summary(2, '2026-09-30')).toEqual({ first_entry: '20:00:00', total_minutes: null, is_present: true });

    // Тот же выход через обычный турникет пару закрывает — правило не сломало ночные смены.
    await addEvent(2, '2026-10-01', '06:10', 'exit', 'ALIA');
    await recalc(2, '2026-09-30');
    expect((await summary(2, '2026-09-30'))?.total_minutes).toBe(610);
  });

  it('аномальность дня считается по тому же правилу рабочего дня', async () => {
    for (const date of ['2026-09-30', '2026-10-01']) {
      await addEvent(3, date, '09:00', 'entry', 'ALIA');
      await addEvent(3, date, '10:00', 'entry', POINT);
      await addEvent(3, date, '18:00', 'exit', 'ALIA');
    }
    const anomalous = async (date: string): Promise<boolean> =>
      (await q<{ a: boolean }>('SELECT public.is_skud_anomalous_day(3, $1::date, false) AS a', [date]))[0].a;
    // 30.09: проход через точку не виден расчёту — обычная пара. 01.10: два входа подряд.
    expect(await anomalous('2026-09-30')).toBe(false);
    expect(await anomalous('2026-10-01')).toBe(true);
  });

  it('смена типа: история, задача пересборки и аудит; повтор ничего не добавляет', async () => {
    const first = await changeAccessPointZone({ accessPointName: 'Склад', isInternal: true, effectiveFrom: '2026-10-05' }, actor);
    expect(first.changed).toBe(true);
    const again = await changeAccessPointZone({ accessPointName: 'Склад', isInternal: true, effectiveFrom: '2026-10-05' }, actor);
    expect(again.changed).toBe(false);

    expect(await q(`SELECT is_internal, effective_from::text AS effective_from FROM skud_access_point_zone_periods WHERE access_point_name = 'Склад'`))
      .toEqual([{ is_internal: true, effective_from: '2026-10-05' }]);
    expect(await q(`SELECT from_date::text AS from_date, to_date::text AS to_date, state FROM skud_access_point_zone_reconcile WHERE access_point_name = 'Склад'`))
      .toEqual([{ from_date: '2026-10-05', to_date: '2026-10-13', state: 'queued' }]);
    const audit = await q<{ details: { timeline_before: unknown[]; timeline_after: unknown[] } }>(
      `SELECT details FROM audit_logs WHERE action = 'SKUD_ACCESS_POINT_ZONE_CHANGED'`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].details.timeline_before).toEqual([]);
    expect(audit[0].details.timeline_after).toEqual([{ is_internal: true, effective_from: '2026-10-05' }]);
  });

  it('экраны портала видят тип «на сегодня»: смена типа обновляет и прежнюю таблицу', async () => {
    // «Коридор» внутренний и отмечен в двух отделах (один раз с пробелом в имени).
    expect((await getInternalAccessPoints()).has('Коридор')).toBe(true);

    await changeAccessPointZone({ accessPointName: 'Коридор', isInternal: false, effectiveFrom: '2026-10-05' }, actor);
    expect(await q(`SELECT 1 FROM skud_access_point_settings WHERE btrim(access_point_name) = 'Коридор'`)).toHaveLength(0);
    // Прежняя функция (её читают присутствие, списки проходов, выгрузки) — точка внешняя.
    expect((await getInternalAccessPoints()).has('Коридор')).toBe(false);
    // Расчёт часов — по рабочему дню: до 05.10 точка внутренняя.
    const zones = await getInternalPointsByWorkDate();
    expect(zones.has('Коридор', '2026-10-04')).toBe(true);
    expect(zones.has('Коридор', '2026-10-05')).toBe(false);

    await changeAccessPointZone({ accessPointName: 'Коридор', isInternal: true, effectiveFrom: '2026-10-05' }, actor);
    expect(await q(`SELECT access_point_name, is_internal FROM skud_access_point_settings WHERE btrim(access_point_name) = 'Коридор'`))
      .toEqual([{ access_point_name: 'Коридор', is_internal: true }]);
    expect((await getInternalAccessPoints()).has('Коридор')).toBe(true);
  });

  it('дата раньше 1-го числа месяца отклоняется и в БД ничего не пишет', async () => {
    await expect(changeAccessPointZone({ accessPointName: POINT, isInternal: true, effectiveFrom: '2026-09-01' }, actor))
      .rejects.toMatchObject({ status: 400 });
    expect(await q('SELECT 1 FROM skud_access_point_zone_reconcile')).toHaveLength(0);
  });

  it('две одновременные смены одной точки дают согласованную историю', async () => {
    await Promise.all([
      changeAccessPointZone({ accessPointName: 'Склад', isInternal: true, effectiveFrom: '2026-10-05' }, actor),
      changeAccessPointZone({ accessPointName: 'Склад', isInternal: true, effectiveFrom: '2026-10-08' }, actor),
    ]);
    // В любом порядке: внутренняя с более ранней даты, без лишней второй строки.
    expect(await q(`SELECT is_internal, effective_from::text AS effective_from FROM skud_access_point_zone_periods WHERE access_point_name = 'Склад'`))
      .toEqual([{ is_internal: true, effective_from: '2026-10-05' }]);
  });

  it('пересборка: сводка, «Дорога», версии для 1С; второй прогон ничего не меняет', async () => {
    // Сотрудник 1 ходил через точку 01–02.10; сводка посчитана, когда точка была внутренней.
    for (const date of ['2026-10-01', '2026-10-02']) {
      await addEvent(1, date, '09:00', 'entry', POINT);
      await addEvent(1, date, '18:00', 'exit', POINT);
      await pg.pool!.query(
        `INSERT INTO skud_daily_summary (employee_id, date, is_present, break_hours, break_minutes) VALUES (1, $1, false, 0, 0)`,
        [date],
      );
    }
    // Одобренный сегмент «Дороги», который после пересборки исчезнет.
    await pg.pool!.query(
      `INSERT INTO skud_travel_segments (employee_id, work_date, exit_time, entry_time, from_access_point_name, to_access_point_name, status, approval_comment)
       VALUES (1, '2026-10-01', '12:00', '14:00', 'ALIA', 'Склад', 'approved', 'согласовано')`,
    );
    // Подачи: А — закрытая с затронутым; Б — закрытая без него; В — открытая; Г — закрытая за сентябрь.
    await pg.pool!.query(
      `INSERT INTO timesheet_approvals (id, status, unlocked_at, start_date, end_date) VALUES
         (1, 'approved', NULL, '2026-10-01', '2026-10-15'),
         (2, 'approved', NULL, '2026-10-01', '2026-10-15'),
         (3, 'approved', now(), '2026-10-01', '2026-10-15'),
         (4, 'approved', NULL, '2026-09-01', '2026-09-15')`,
    );
    await pg.pool!.query(`INSERT INTO timesheet_approval_employees (approval_id, employee_id) VALUES (1, 1), (2, 9), (3, 1), (4, 1)`);

    await pg.pool!.query(
      `INSERT INTO skud_access_point_zone_reconcile (access_point_name, from_date, to_date) VALUES ($1, '2026-10-01', '2026-10-13')`,
      [POINT],
    );
    expect(await runZoneReconcileOnce()).toBe(true);
    expect(await runZoneReconcileOnce()).toBe(false);

    expect((await summary(1, '2026-10-01'))?.total_minutes).toBe(540);
    expect((await summary(1, '2026-10-02'))?.total_minutes).toBe(540);
    expect(travel.calls).toEqual([{ employeeIds: [1], startDate: '2026-10-01', endDate: '2026-10-13' }]);
    expect(await q(`SELECT state, last_error FROM skud_access_point_zone_reconcile`)).toEqual([{ state: 'done', last_error: null }]);

    // Помечена только закрытая подача с затронутым сотрудником в диапазоне.
    const marked = await q<{ id: number }>('SELECT id FROM timesheet_approvals WHERE version_dirty_at IS NOT NULL ORDER BY id');
    expect(marked.map(row => Number(row.id))).toEqual([1]);

    const audit = await q<{ details: { summary_changed: number; lost_travel_decisions: Array<{ status: string; approval_comment: string }>; marked_approval_ids: number[] } }>(
      `SELECT details FROM audit_logs WHERE action = 'SKUD_ACCESS_POINT_ZONE_RECONCILED'`,
    );
    // Два дня стали «отработано» + появилась строка-заглушка за 30.09 (batch пересчитывает и D−1).
    expect(audit[0].details.summary_changed).toBe(3);
    expect(await summary(1, '2026-09-30')).toEqual({ first_entry: null, total_minutes: null, is_present: false });
    expect(audit[0].details.marked_approval_ids).toEqual([1]);
    // Решение не пропало бесследно.
    expect(audit[0].details.lost_travel_decisions).toEqual([
      expect.objectContaining({ status: 'approved', approval_comment: 'согласовано', work_date: '2026-10-01' }),
    ]);

    // Идемпотентность: тот же план повторно — ни одной изменившейся строки.
    const repeat = await reconcileAccessPointZone(await buildZoneChangePlan(POINT, '2026-10-01', '2026-10-13', true));
    expect(repeat.summaryChanged).toBe(0);
    expect(repeat.travelChanged).toBe(0);
    expect(repeat.lostTravelDecisions).toEqual([]);
  });

  it('несколько смен одной точки подряд пересобираются один раз — от самой ранней даты', async () => {
    await addEvent(1, '2026-10-03', '09:00', 'entry', 'Склад');
    await pg.pool!.query(
      `INSERT INTO skud_access_point_zone_reconcile (access_point_name, from_date, to_date) VALUES
         ('Склад', '2026-10-05', '2026-10-13'), ('Склад', '2026-10-03', '2026-10-13')`,
    );
    expect(await runZoneReconcileOnce()).toBe(true);
    expect(travel.calls).toEqual([{ employeeIds: [1], startDate: '2026-10-03', endDate: '2026-10-13' }]);
    expect(await q(`SELECT DISTINCT state FROM skud_access_point_zone_reconcile`)).toEqual([{ state: 'done' }]);
    expect(await runZoneReconcileOnce()).toBe(false);
  });
});
