import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// «Табель → Зарплата по объектам» (миграции 330, 336) на настоящем PostgreSQL: миграции и их повтор, CHECK,
// удаление тестовой выработки и остановка 336 на любой другой старой строке, фиксация по редакциям закрытых подач
// (две половины и одна подача на месяц) с долями по объектам из снимков редакций, живые веса для редакции без
// снимка и их заморозка, config_errors снимка — ошибка бригады, «Требует перерасчёта» при открытой подаче, старый
// результат (format 1) не показывается, пересчёт без пустого аудита, повторное чтение без пересчёта, уволенный в
// месяце увольнения — по живому табелю, начальник участка — вне дележа. 341: сумма бригаде — «или — или» с
// объектами (сервис и триггер под одним замком), фиксация с mode = brigade, повторы без записи, список «Бригады».
// Состав, живой табель, режимы табелирования и графики подменены: их SQL проверяют свои тесты.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы-заглушки пересоздаются).

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../../config/postgres.js', async () => {
  const { Pool, types } = await import('pg');
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

const fx = vi.hoisted(() => ({
  members: [] as Array<{ employee_id: number; transferred_out_date: string | null; joined_date: string | null }>,
  supervisors: new Set<number>(),
  live: new Map<number, Map<string, { status: string; hours: number; corrected: boolean; hoursOverridden: boolean }>>(),
  /** Живые объектные проходы: веса разбивки для живых дней и для редакций без снимка. */
  entries: [] as Array<{ employee_id: number; work_date: string; object_key: string; hours: number }>,
  cutoff: new Map<number, string | null>(),
  workHours: 10,
  liveCalls: [] as number[][],
}));

const schedule = (workHours: number) => ({
  schedule_id: 's', schedule_type: 'office', work_start: '07:00:00', work_end: '17:00:00', work_hours: workHours,
  work_days: [1, 2, 3, 4, 5], office_days: null, late_threshold_minutes: 0, day_overrides: null, lunch_minutes: 0,
  respects_holidays: true, pattern_type: 'custom', expected_saturdays_per_month: 0, expected_sundays_per_month: 0,
  full_day_threshold_minutes: null, weekend_full_day_threshold_minutes: null, cycle_length: null, cycle_days: null,
  anchor_date: null, assignment_anchor_date: null, source: 'employee',
});

const scheduleMaps = (ids: number[], start: string, end: string) => {
  const result = new Map<number, Map<string, ReturnType<typeof schedule>>>();
  const last = Number(end.slice(8, 10));
  for (const id of ids) {
    const byDate = new Map<string, ReturnType<typeof schedule>>();
    for (let day = Number(start.slice(8, 10)); day <= last; day += 1) {
      byDate.set(`${start.slice(0, 8)}${String(day).padStart(2, '0')}`, schedule(fx.workHours));
    }
    result.set(id, byDate);
  }
  return result;
};

vi.mock('../timesheet-department-assignments.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../timesheet-department-assignments.service.js')>()),
  listEmployeeMembershipsForDepartmentPeriod: vi.fn(async () => fx.members),
}));

vi.mock('../../controllers/timesheet-assigned-export.controller.js', () => ({
  listBrigadeSupervisorEmployeeIdsForDepartments: vi.fn(async () => fx.supervisors),
}));

vi.mock('../schedule.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../schedule.service.js')>()),
  resolveSchedulesForPeriod: vi.fn(async (employees: Array<{ id: number }>, start: string, end: string) => (
    scheduleMaps(employees.map(employee => employee.id), start, end)
  )),
  loadCalendarMonth: vi.fn(async () => null),
}));

vi.mock('../timesheet-export.service.js', () => ({
  fetchTimesheetDataForEmployees: vi.fn(async (_month: string, ids: number[], _name: string, range: { startDate: string; endDate: string }) => {
    fx.liveCalls.push([...ids].sort((a, b) => a - b));
    const dataMap = new Map();
    for (const id of ids) dataMap.set(id, fx.live.get(id) ?? new Map());
    return {
      dataMap,
      cutoffByEmployeeId: fx.cutoff,
      dailySchedulesMap: scheduleMaps(ids, range.startDate, range.endDate),
      calendarMonth: null,
      objectEntries: fx.entries
        .filter(entry => ids.includes(entry.employee_id))
        .map(entry => ({
          adjustment_id: null, employee_id: entry.employee_id, work_date: entry.work_date, object_key: entry.object_key,
          object_id: entry.object_key, object_name: OBJECT_NAMES[entry.object_key], hours_worked: entry.hours,
          display_hours_worked: entry.hours, base_hours_worked: entry.hours, is_correction: false,
        })),
    };
  }),
}));

// Режим табелирования месяца: все — «по СКУД» (как 688 рабочих бригад в сентябре).
vi.mock('../timesheet-export-mode.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../timesheet-export-mode.service.js')>()),
  resolveExportModes: vi.fn(async () => new Map()),
}));

const audit = vi.hoisted(() => ({ calls: [] as Array<{ action: string; details: Record<string, unknown> }> }));
vi.mock('../audit.service.js', () => ({
  auditService: {
    logFromRequestWithClient: vi.fn(async (_client: unknown, _req: unknown, _user: unknown, action: string, options: { details: Record<string, unknown> }) => {
      audit.calls.push({ action, details: options.details });
    }),
  },
}));

import { getBrigadeSalary, getBrigadeShares } from './brigade-salary.service.js';
import {
  BrigadeOutputModeConflictError,
  setBrigadeKtu,
  setBrigadeObjectOutput,
  setBrigadeOutput,
} from './brigade-salary-inputs.service.js';
import { listBrigadeOutputs } from './brigade-output-list.service.js';
import type { AuthenticatedRequest } from '../../types/index.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../docs/migrations/', import.meta.url));
const MIGRATION = readFileSync(`${MIGRATIONS_DIR}330_brigade_salary.sql`, 'utf8');
const MIGRATION_336 = readFileSync(`${MIGRATIONS_DIR}336_brigade_salary_object_outputs.sql`, 'utf8');
const MIGRATION_341 = readFileSync(`${MIGRATIONS_DIR}341_brigade_salary_brigade_outputs.sql`, 'utf8');

const BRIGADE = '5049c2c9-1334-49e6-8d55-7a04bebcaa8c';
const KHODZHAKULOV = 'bc645c62-4ff1-4f9e-a1ce-503196b1eb8e';
const WAVE = '2b1f7a0e-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const STORIES = '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a';
const OBJECT_NAMES: Record<string, string> = { [WAVE]: 'ЖК Wave', [STORIES]: 'ЖК Stories' };
const PROFILE = '00000000-0000-0000-0000-000000000001';
const A = 1951;
const B = 2325;
const F = 2413; // уволен 04.09, в редакции его нет
const S = 1438; // начальник участка — в редакции есть, в дележе нет

const req = { user: { id: PROFILE } } as unknown as AuthenticatedRequest;

const q = async <T extends import('pg').QueryResultRow>(sql: string, params?: unknown[]) =>
  (await pg.pool!.query<T>(sql, params)).rows;

const work = (hours: number, patch: Record<string, unknown> = {}) => ({
  status: 'work', hours, corrected: false, hours_overridden: false, ...patch,
});

const payload = (employees: Record<number, Record<string, unknown>>) => ({
  employees: Object.entries(employees).map(([id, days]) => ({ identity: { employee_id: Number(id) }, days })),
});

const addApproval = async (start: string, end: string, status = 'approved'): Promise<number> => Number((
  await q<{ id: string }>(
    `INSERT INTO timesheet_approvals (department_id, status, start_date, end_date)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [BRIGADE, status, start, end],
  )
)[0].id);

const addVersion = async (approvalId: number, revision: number, body: unknown): Promise<number> => Number((
  await q<{ id: string }>(
    'INSERT INTO timesheet_versions (approval_id, revision, payload) VALUES ($1, $2, $3::jsonb) RETURNING id',
    [approvalId, revision, JSON.stringify(body)],
  )
)[0].id);

/** Снимок объектов редакции: сотрудник → объект → дата → часы (как timesheet_version_objects.payload). */
const addObjects = async (
  versionId: number,
  employees: Record<number, Record<string, Record<string, number>>>,
  configErrors: unknown[] = [],
): Promise<void> => {
  const body = {
    employees: Object.entries(employees).map(([id, objects]) => ({
      employee_id: Number(id),
      objects: Object.entries(objects).map(([key, days]) => ({
        object_id: key.startsWith('__') ? null : key,
        object_key: key,
        object_name: OBJECT_NAMES[key] ?? 'Не определён',
        days,
      })),
    })),
  };
  await q(
    'INSERT INTO timesheet_version_objects (version_id, payload, config_errors) VALUES ($1, $2::jsonb, $3::jsonb)',
    [versionId, JSON.stringify(body), JSON.stringify(configErrors)],
  );
};

const setOutput = (objectKey: string, amount: string | null) => setBrigadeObjectOutput(
  BRIGADE, '2026-09-01', objectKey, OBJECT_NAMES[objectKey] ?? 'Не определён', amount, PROFILE,
);

const amounts = (rows: Array<{ employee_id: number; amount: string | null }>) => (
  Object.fromEntries(rows.map(row => [row.employee_id, row.amount]))
);

const sumCents = (rows: Array<{ amount: string | null }>) => rows.reduce(
  (sum, row) => sum + Math.round(Number(row.amount ?? 0) * 100), 0,
);

describe.skipIf(!PG_URL)('brigade salary (PostgreSQL, миграции 330 и 336)', () => {
  beforeAll(async () => {
    await q(`
      DROP TABLE IF EXISTS brigade_salary_brigade_outputs, brigade_salary_object_outputs, brigade_salary_results,
        brigade_salary_ktu, brigade_salary_outputs, timesheet_version_objects, timesheet_versions, timesheet_approvals,
        employees, employee_assignments, employee_dismissal_events, org_departments, user_profiles, skud_objects CASCADE;
      CREATE TABLE user_profiles (id uuid PRIMARY KEY);
      CREATE TABLE org_departments (id uuid PRIMARY KEY, name text, kind text, is_active boolean DEFAULT true);
      CREATE TABLE employees (
        id bigint PRIMARY KEY, full_name text, org_department_id uuid, is_archived boolean NOT NULL DEFAULT false,
        employment_status text NOT NULL DEFAULT 'active', dismissal_date date);
      CREATE TABLE employee_assignments (
        employee_id bigint, org_department_id uuid, effective_from date, effective_to date);
      CREATE TABLE employee_dismissal_events (
        employee_id bigint, from_department_id uuid, dismissal_date date, cancelled boolean NOT NULL DEFAULT false);
      CREATE TABLE skud_objects (id uuid PRIMARY KEY, name text, alt_name text);
      CREATE TABLE timesheet_approvals (
        id bigserial PRIMARY KEY, department_id uuid, manager_employee_id bigint, status text,
        start_date date, end_date date, unlocked_at timestamptz);
      CREATE TABLE timesheet_versions (
        id bigserial PRIMARY KEY, approval_id bigint REFERENCES timesheet_approvals(id) ON DELETE CASCADE,
        revision int, payload jsonb);
      CREATE TABLE timesheet_version_objects (
        version_id bigint PRIMARY KEY REFERENCES timesheet_versions(id) ON DELETE CASCADE,
        payload jsonb NOT NULL, config_errors jsonb NOT NULL DEFAULT '[]'::jsonb);
    `);
    await q(MIGRATION);
    await q(MIGRATION);
    await q('INSERT INTO user_profiles (id) VALUES ($1)', [PROFILE]);
    await q(`INSERT INTO org_departments (id, name, kind) VALUES ($1, 'бр.Аюби М.С.', 'brigade'), ($2, 'бр.Ходжакулов С.Ж.', 'brigade')`, [BRIGADE, KHODZHAKULOV]);
    await q(`INSERT INTO employees (id, full_name) VALUES (${A}, 'А'), (${B}, 'Б'), (${F}, 'Уволенный'), (${S}, 'Начальник')`);
    await q(`INSERT INTO skud_objects (id, name, alt_name) VALUES ($1, 'ЖК Wave', NULL), ($2, 'ЖК Stories', NULL)`, [WAVE, STORIES]);
    // Как на проде: единственная выработка — тестовая, у бр.Ходжакулов за сентябрь.
    await q(`INSERT INTO brigade_salary_outputs (department_id, month, amount) VALUES ($1, '2026-09-01', 2000000.00)`, [KHODZHAKULOV]);
    await q(MIGRATION_336);
    await q(MIGRATION_336);
    await q(MIGRATION_341);
    await q(MIGRATION_341);
    // 336 после 341 и пустой 330 — повтор тоже проходит.
    await q(MIGRATION_336);
  });

  beforeEach(async () => {
    await q(`TRUNCATE brigade_salary_brigade_outputs, brigade_salary_object_outputs, brigade_salary_results,
      brigade_salary_ktu, brigade_salary_outputs, timesheet_version_objects, timesheet_versions, timesheet_approvals`);
    fx.members = [
      { employee_id: A, transferred_out_date: null, joined_date: null },
      { employee_id: B, transferred_out_date: null, joined_date: null },
      { employee_id: F, transferred_out_date: '2026-09-05', joined_date: null },
    ];
    fx.supervisors = new Set([S]);
    fx.live = new Map([[F, new Map([
      ['2026-09-03', { status: 'work', hours: 10, corrected: false, hoursOverridden: false }],
      // После увольнения — не считается.
      ['2026-09-07', { status: 'work', hours: 10, corrected: false, hoursOverridden: false }],
    ])]]);
    fx.entries = [{ employee_id: F, work_date: '2026-09-03', object_key: WAVE, hours: 10 }];
    fx.cutoff = new Map([[F, '2026-09-05']]);
    fx.workHours = 10;
    fx.liveCalls = [];
    audit.calls = [];
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('336: тестовая выработка Ходжакулова удалена, повтор проходит; любая другая старая строка — стоп', async () => {
    expect(await q('SELECT 1 FROM brigade_salary_outputs')).toHaveLength(0);
    await q(`INSERT INTO brigade_salary_outputs (department_id, month, amount) VALUES ($1, '2026-09-01', 1999999.00)`, [KHODZHAKULOV]);
    // Отдельное соединение: упавшая миграция оставляет его в прерванной транзакции до ROLLBACK.
    const client = await pg.pool!.connect();
    try {
      await expect(client.query(MIGRATION_336)).rejects.toThrow(/внесённая по-старому/);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    // Миграция не прошла — строка на месте, ничего не потеряно.
    expect(await q('SELECT amount::text AS amount FROM brigade_salary_outputs')).toEqual([{ amount: '1999999.00' }]);
  });

  it('CHECK: месяц с 1-го, КТУ 0,5…2,0, выработка не отрицательная, ключ объекта, формат и итог результата', async () => {
    await expect(q(`INSERT INTO brigade_salary_object_outputs (department_id, month, object_key, object_name, amount)
      VALUES ($1, '2026-09-02', $2, 'ЖК Wave', 1)`, [BRIGADE, WAVE])).rejects.toThrow(/month_first_day/);
    await expect(q(`INSERT INTO brigade_salary_object_outputs (department_id, month, object_key, object_name, amount)
      VALUES ($1, '2026-09-01', $2, 'ЖК Wave', -1)`, [BRIGADE, WAVE])).rejects.toThrow(/amount_non_negative/);
    await expect(q(`INSERT INTO brigade_salary_object_outputs (department_id, month, object_key, object_name, amount)
      VALUES ($1, '2026-09-01', 'ЖК Wave', 'ЖК Wave', 1)`, [BRIGADE])).rejects.toThrow(/object_key/);
    await q(`INSERT INTO brigade_salary_object_outputs (department_id, month, object_key, object_name, amount)
      VALUES ($1, '2026-09-01', '__unknown_object__', 'Не определён', 0)`, [BRIGADE]);
    await expect(q(`INSERT INTO brigade_salary_ktu (department_id, month, employee_id, ktu) VALUES ($1, '2026-09-01', ${A}, 0.4)`, [BRIGADE]))
      .rejects.toThrow(/ktu_range/);
    await expect(q(`INSERT INTO brigade_salary_ktu (department_id, month, employee_id, ktu) VALUES ($1, '2026-09-01', ${A}, 2.1)`, [BRIGADE]))
      .rejects.toThrow(/ktu_range/);
    await expect(q(`INSERT INTO brigade_salary_results (department_id, month, status, inputs_hash, versions, rows, format)
      VALUES ($1, '2026-09-01', 'fixed', 'x', '[]', '[]', 3)`, [BRIGADE])).rejects.toThrow(/results_format/);
    await expect(q(`INSERT INTO brigade_salary_results (department_id, month, status, inputs_hash, versions, rows, distribution)
      VALUES ($1, '2026-09-01', 'fixed', 'x', '[]', '[]', 'partial')`, [BRIGADE])).rejects.toThrow(/results_distribution/);
  });

  /**
   * А: 01.09 12 ч (график 10 → 600 мин) — Wave; 16.09 10 ч — Stories.
   * Б: 01.09 10 ч — Wave 6 ч / Stories 4 ч → 360 / 240 мин; 16.09 корректировка 12 ч (720 мин) — Wave.
   * Начальник участка — в редакции и снимке есть, в дележе нет. Уволенный: 03.09 10 ч по живому табелю — Wave.
   */
  const closeSeptemberInHalves = async (options: { h2Snapshot?: boolean } = {}) => {
    const h1 = await addApproval('2026-09-01', '2026-09-15');
    const h2 = await addApproval('2026-09-16', '2026-09-30');
    const v1 = await addVersion(h1, 1, payload({
      [A]: { '2026-09-01': work(12) },
      [B]: { '2026-09-01': work(10) },
      [S]: { '2026-09-01': work(10) },
    }));
    await addObjects(v1, {
      [A]: { [WAVE]: { '2026-09-01': 12 } },
      [B]: { [WAVE]: { '2026-09-01': 6 }, [STORIES]: { '2026-09-01': 4 } },
      [S]: { [WAVE]: { '2026-09-01': 10 } },
    });
    const v2 = await addVersion(h2, 1, payload({
      [A]: { '2026-09-16': work(10) },
      [B]: { '2026-09-16': work(12, { corrected: true, hours_overridden: true }) },
    }));
    if (options.h2Snapshot !== false) {
      await addObjects(v2, {
        [A]: { [STORIES]: { '2026-09-16': 10 } },
        [B]: { [WAVE]: { '2026-09-16': 12 } },
      });
    }
    return { h1, h2, v1, v2 };
  };

  // Wave: А 6000, Б 10 800, уволенный 6000 → 228 000 = 60 000 / 108 000 / 60 000.
  // Stories: А 6000, Б 2400 → 84 000 = 60 000 / 24 000.
  const enterBoth = async () => {
    await setOutput(WAVE, '228000.00');
    await setOutput(STORIES, '84000.00');
  };

  const objectShares = (rows: Array<{ employee_id: number; objects: Array<{ object_key: string; amount: string | null }> }>) => (
    Object.fromEntries(rows.map(row => [row.employee_id, Object.fromEntries(row.objects.map(part => [OBJECT_NAMES[part.object_key], part.amount]))]))
  );

  it('две закрытые половины → фиксируется по объектам снимков; уволенный — по живому табелю; начальник участка вне дележа', async () => {
    await closeSeptemberInHalves();
    await enterBoth();

    const result = await getBrigadeSalary(req, BRIGADE, '2026-09');

    expect(result.state).toBe('fixed');
    expect(result.distribution).toBe('ok');
    expect(amounts(result.rows)).toEqual({ [A]: '120000.00', [B]: '132000.00', [F]: '60000.00' });
    expect(objectShares(result.rows)).toEqual({
      [A]: { 'ЖК Wave': '60000.00', 'ЖК Stories': '60000.00' },
      [B]: { 'ЖК Wave': '108000.00', 'ЖК Stories': '24000.00' },
      [F]: { 'ЖК Wave': '60000.00' },
    });
    expect(result.objects).toEqual([
      { object_key: STORIES, object_name: 'ЖК Stories', output: '84000.00', state: 'ok', total_weight: 8400 },
      { object_key: WAVE, object_name: 'ЖК Wave', output: '228000.00', state: 'ok', total_weight: 22800 },
    ]);
    const a = result.rows.find(row => row.employee_id === A)!;
    expect(a.objects.find(part => part.object_key === WAVE)).toEqual({
      object_key: WAVE, days: { '2026-09-01': 12 }, counted_minutes: 600, weight: 6000, amount: '60000.00',
    });
    expect(result.rows.find(row => row.employee_id === F)?.source).toBe('live');
    expect(result.rows.some(row => row.employee_id === S)).toBe(false);
    expect(fx.liveCalls).toEqual([[F]]);

    const stored = await q<{ status: string; format: number; distribution: string; objects: unknown }>(
      'SELECT status, format, distribution, objects FROM brigade_salary_results',
    );
    expect(stored).toEqual([expect.objectContaining({ status: 'fixed', format: 2, distribution: 'ok' })]);
    expect(audit.calls).toEqual([]);
  });

  it('одна подача на месяц тоже закрывает месяц; 0,00 на объекте — всем там 0', async () => {
    const full = await addApproval('2026-09-01', '2026-09-30');
    const v = await addVersion(full, 1, payload({ [A]: { '2026-09-01': work(10) }, [B]: { '2026-09-01': work(10) } }));
    await addObjects(v, { [A]: { [WAVE]: { '2026-09-01': 10 } }, [B]: { [WAVE]: { '2026-09-01': 10 } } });
    await setOutput(WAVE, '0.00');

    const result = await getBrigadeSalary(req, BRIGADE, '2026-09');

    expect(result.state).toBe('fixed');
    expect(amounts(result.rows)).toEqual({ [A]: '0.00', [B]: '0.00', [F]: '0.00' });
  });

  it('выработка внесена только на Wave — у работавших на Stories итога нет, у уволенного (только Wave) есть', async () => {
    await closeSeptemberInHalves();
    await setOutput(WAVE, '228000.00');

    const result = await getBrigadeSalary(req, BRIGADE, '2026-09');

    expect(result.distribution).toBe('no_output');
    expect(amounts(result.rows)).toEqual({ [A]: null, [B]: null, [F]: '60000.00' });
    expect(objectShares(result.rows)[A]).toEqual({ 'ЖК Wave': '60000.00', 'ЖК Stories': null });
    expect(result.objects.find(object => object.object_key === STORIES)).toMatchObject({ state: 'no_output', output: null });
  });

  it('доли для «К выплате (ФОТ)»: закрытый месяц — зафиксированные с объектами, тот же расчёт, что во вкладке; открытый — нет', async () => {
    const { h2 } = await closeSeptemberInHalves();
    await enterBoth();

    const shares = await getBrigadeShares(req, BRIGADE, '2026-09');

    expect(shares.state).toBe('fixed');
    expect(shares.output_amount).toBe('312000.00');
    expect(shares.objects.map(object => object.object_name)).toEqual(['ЖК Stories', 'ЖК Wave']);
    expect(amounts(shares.rows)).toEqual({ [A]: '120000.00', [B]: '132000.00', [F]: '60000.00' });
    expect(amounts((await getBrigadeSalary(req, BRIGADE, '2026-09')).rows)).toEqual(amounts(shares.rows));
    expect(await q('SELECT 1 FROM brigade_salary_results')).toHaveLength(1);

    await q('UPDATE timesheet_approvals SET unlocked_at = now() WHERE id = $1', [h2]);
    expect(await getBrigadeShares(req, BRIGADE, '2026-09')).toEqual({
      state: 'open', mode: 'objects', distribution: null, output_amount: null, rows: [], objects: [],
    });
  });

  it('половина не закрыта и результата не было → «Предварительно» по живому табелю и живой разбивке, ничего не сохраняется', async () => {
    const h1 = await addApproval('2026-09-01', '2026-09-15');
    await addVersion(h1, 1, payload({ [A]: { '2026-09-01': work(10) } }));
    await addApproval('2026-09-16', '2026-09-30', 'draft');
    fx.live.set(A, new Map([['2026-09-01', { status: 'work', hours: 10, corrected: false, hoursOverridden: false }]]));
    fx.entries.push({ employee_id: A, work_date: '2026-09-01', object_key: WAVE, hours: 10 });
    await setOutput(WAVE, '1000.00');

    const result = await getBrigadeSalary(req, BRIGADE, '2026-09');

    expect(result.state).toBe('preliminary');
    expect(result.as_of).toBe('2026-09-30');
    expect(result.open_ranges).toEqual([{ start_date: '2026-09-16', end_date: '2026-09-30' }]);
    // А 600 мин на Wave, уволенный 600 мин на Wave, Б без дней — 0,00 (выработка у бригады есть).
    expect(amounts(result.rows)).toEqual({ [A]: '500.00', [B]: '0.00', [F]: '500.00' });
    expect(await q('SELECT 1 FROM brigade_salary_results')).toHaveLength(0);
  });

  it('открыли подачу → «Требует перерасчёта» с прежними суммами и днями; новая редакция после закрытия → пересчёт и аудит', async () => {
    const { h2 } = await closeSeptemberInHalves();
    await enterBoth();
    await getBrigadeSalary(req, BRIGADE, '2026-09');

    await q('UPDATE timesheet_approvals SET unlocked_at = now() WHERE id = $1', [h2]);
    const stale = await getBrigadeSalary(req, BRIGADE, '2026-09');
    expect(stale.state).toBe('stale');
    expect(amounts(stale.rows)[A]).toBe('120000.00');
    expect(stale.rows.find(row => row.employee_id === A)?.objects.length).toBe(2);
    expect(stale.open_ranges).toEqual([{ start_date: '2026-09-16', end_date: '2026-09-30' }]);

    // Закрыли снова: у А добавился день на Stories.
    const v3 = await addVersion(h2, 2, payload({
      [A]: { '2026-09-16': work(10), '2026-09-17': work(10) },
      [B]: { '2026-09-16': work(12, { corrected: true, hours_overridden: true }) },
    }));
    await addObjects(v3, {
      [A]: { [STORIES]: { '2026-09-16': 10, '2026-09-17': 10 } },
      [B]: { [WAVE]: { '2026-09-16': 12 } },
    });
    await q('UPDATE timesheet_approvals SET unlocked_at = NULL WHERE id = $1', [h2]);
    const recalculated = await getBrigadeSalary(req, BRIGADE, '2026-09');

    expect(recalculated.state).toBe('fixed');
    expect(sumCents(recalculated.rows)).toBe(31200000);
    expect(Number(amounts(recalculated.rows)[A])).toBeGreaterThan(120000);
    expect(audit.calls.map(call => call.action)).toEqual(['BRIGADE_SALARY_RECALCULATED']);
    expect(audit.calls[0].details.total).toEqual({ from: '312000.00', to: '312000.00' });
  });

  it('старый результат (format 1, без объектов): подачу открыли — не отдаётся, считается предварительно; закрыта — пересчёт без пустого аудита', async () => {
    const { h1, h2, v1, v2 } = await closeSeptemberInHalves();
    // Как 73 результата на проде: зафиксированы по тем же редакциям, выработки нет.
    const legacyRows = JSON.stringify([A, B, F].map(id => ({
      employee_id: id, ktu: '1.0', counted_minutes: 600, amount: null, source: 'version',
    })));
    const versions = JSON.stringify([{ approval_id: h1, version_id: v1 }, { approval_id: h2, version_id: v2 }]);
    await q(`INSERT INTO brigade_salary_results (department_id, month, status, inputs_hash, versions, rows)
      VALUES ($1, '2026-09-01', 'fixed', 'v1-hash', $2::jsonb, $3::jsonb)`, [BRIGADE, versions, legacyRows]);

    await q('UPDATE timesheet_approvals SET unlocked_at = now() WHERE id = $1', [h2]);
    fx.live.set(A, new Map([['2026-09-16', { status: 'work', hours: 10, corrected: false, hoursOverridden: false }]]));
    const reopened = await getBrigadeSalary(req, BRIGADE, '2026-09');
    expect(reopened.state).toBe('preliminary');
    expect(reopened.rows.every(row => Array.isArray(row.objects))).toBe(true);

    await q('UPDATE timesheet_approvals SET unlocked_at = NULL WHERE id = $1', [h2]);
    const fixed = await getBrigadeSalary(req, BRIGADE, '2026-09');
    expect(fixed.state).toBe('fixed');
    expect((await q<{ format: number }>('SELECT format FROM brigade_salary_results'))[0].format).toBe(2);
    // Суммы не поменялись (выработки нет ни раньше, ни сейчас) — пустой пересчёт в аудит не идёт.
    expect(audit.calls).toEqual([]);
  });

  it('повторное чтение с теми же входами — без пересчёта и без аудита', async () => {
    await closeSeptemberInHalves();
    await enterBoth();
    const first = await getBrigadeSalary(req, BRIGADE, '2026-09');
    const second = await getBrigadeSalary(req, BRIGADE, '2026-09');
    expect(second.computed_at).toBe(first.computed_at);
    expect(second.rows).toEqual(first.rows);
    expect(audit.calls).toEqual([]);
  });

  it('редакция без снимка — живые веса; после фиксации проходы поменялись → дни, веса и суммы прежние', async () => {
    await closeSeptemberInHalves({ h2Snapshot: false });
    // 16.09 по проходам: А — Stories, Б — Wave (как в снимке первого теста).
    fx.entries.push(
      { employee_id: A, work_date: '2026-09-16', object_key: STORIES, hours: 10 },
      { employee_id: B, work_date: '2026-09-16', object_key: WAVE, hours: 12 },
    );
    await enterBoth();

    const fixed = await getBrigadeSalary(req, BRIGADE, '2026-09');
    expect(amounts(fixed.rows)).toEqual({ [A]: '120000.00', [B]: '132000.00', [F]: '60000.00' });
    expect(fixed.rows.find(row => row.employee_id === A)?.objects.find(part => part.object_key === STORIES)?.days)
      .toEqual({ '2026-09-16': 10 });

    // Поздние проходы: А 16.09 будто бы на Wave. Зафиксированный расчёт не меняется.
    fx.entries = fx.entries.map(entry => (entry.employee_id === A && entry.work_date === '2026-09-16'
      ? { ...entry, object_key: WAVE } : entry));
    const again = await getBrigadeSalary(req, BRIGADE, '2026-09');
    expect(again.computed_at).toBe(fixed.computed_at);
    expect(again.rows).toEqual(fixed.rows);
    expect(again.objects).toEqual(fixed.objects);
  });

  it('config_errors снимка — ошибка бригады object_config, долей нет', async () => {
    const full = await addApproval('2026-09-01', '2026-09-30');
    const v = await addVersion(full, 1, payload({ [A]: { '2026-09-01': work(10) } }));
    await addObjects(v, { [A]: { __unknown_object__: { '2026-09-01': 10 } } }, [
      { employee_id: A, code: 'PINNED_OBJECT_MISSING', message: 'Режим «объект» без закреплённого объекта' },
    ]);
    await setOutput('__unknown_object__', '1000.00');

    const result = await getBrigadeSalary(req, BRIGADE, '2026-09');

    expect(result.distribution).toBe('error');
    expect(result.errors).toContainEqual({ employee_id: A, code: 'object_config', date: null });
    expect(result.rows.every(row => row.amount === null)).toBe(true);
  });

  it('правка графика после фиксации сумму не меняет; новый КТУ — пересчитывает', async () => {
    await closeSeptemberInHalves();
    await enterBoth();
    const fixed = await getBrigadeSalary(req, BRIGADE, '2026-09');

    fx.workHours = 8;
    const again = await getBrigadeSalary(req, BRIGADE, '2026-09');
    expect(amounts(again.rows)).toEqual(amounts(fixed.rows));
    expect(again.computed_at).toBe(fixed.computed_at);

    fx.workHours = 10;
    await setBrigadeKtu(BRIGADE, '2026-09-01', B, 15, PROFILE);
    const withKtu = await getBrigadeSalary(req, BRIGADE, '2026-09');
    expect(withKtu.state).toBe('fixed');
    expect(sumCents(withKtu.rows)).toBe(31200000);
    expect(Number(amounts(withKtu.rows)[B])).toBeGreaterThan(132000);
    expect(withKtu.rows.find(row => row.employee_id === B)?.ktu).toBe('1.5');
  });

  it('КТУ 1,0 строку не хранит; выработка нигде не внесена — no_output, сумм нет', async () => {
    await setBrigadeKtu(BRIGADE, '2026-09-01', A, 15, PROFILE);
    await setBrigadeKtu(BRIGADE, '2026-09-01', A, 10, PROFILE);
    expect(await q('SELECT 1 FROM brigade_salary_ktu')).toHaveLength(0);

    await closeSeptemberInHalves();
    const result = await getBrigadeSalary(req, BRIGADE, '2026-09');
    expect(result.distribution).toBe('no_output');
    expect(result.rows.every(row => row.amount === null)).toBe(true);
  });

  it('выработку можно стереть: null удаляет строку', async () => {
    await setOutput(WAVE, '100.00');
    await setOutput(WAVE, null);
    expect(await q('SELECT 1 FROM brigade_salary_object_outputs')).toHaveLength(0);
  });

  // ─── 341: сумма бригаде ────────────────────────────────────────────────────────────────────────────────────
  const setWhole = (amount: string | null, auditFn?: Parameters<typeof setBrigadeOutput>[4]) => (
    setBrigadeOutput(BRIGADE, '2026-09-01', amount, PROFILE, auditFn)
  );

  it('341: CHECK mode и суммы; триггер не даёт обеим выработкам сразу — в обе стороны, даже прямым SQL', async () => {
    await expect(q(`INSERT INTO brigade_salary_brigade_outputs (department_id, month, amount) VALUES ($1, '2026-09-02', 1)`,
      [BRIGADE])).rejects.toThrow(/month_first_day/);
    await expect(q(`INSERT INTO brigade_salary_brigade_outputs (department_id, month, amount) VALUES ($1, '2026-09-01', -1)`,
      [BRIGADE])).rejects.toThrow(/amount_non_negative/);
    await expect(q(`INSERT INTO brigade_salary_results (department_id, month, status, inputs_hash, versions, rows, mode)
      VALUES ($1, '2026-09-01', 'fixed', 'x', '[]', '[]', 'both')`, [BRIGADE])).rejects.toThrow(/results_mode/);

    await q(`INSERT INTO brigade_salary_brigade_outputs (department_id, month, amount) VALUES ($1, '2026-09-01', 5)`, [BRIGADE]);
    await expect(q(`INSERT INTO brigade_salary_object_outputs (department_id, month, object_key, object_name, amount)
      VALUES ($1, '2026-09-01', $2, 'ЖК Wave', 1)`, [BRIGADE, WAVE])).rejects.toThrow(/сотрите её, чтобы вносить по объектам/);
    // Другой месяц и другая бригада — не мешают.
    await q(`INSERT INTO brigade_salary_object_outputs (department_id, month, object_key, object_name, amount)
      VALUES ($1, '2026-10-01', $2, 'ЖК Wave', 1), ($3, '2026-09-01', $2, 'ЖК Wave', 1)`, [BRIGADE, WAVE, KHODZHAKULOV]);
    await expect(q(`INSERT INTO brigade_salary_brigade_outputs (department_id, month, amount) VALUES ($1, '2026-10-01', 5)`,
      [BRIGADE])).rejects.toThrow(/сотрите её, чтобы внести на бригаду/);
  });

  it('341: сервис — 409-ошибка в обе стороны; стереть объекты можно и при сумме бригаде', async () => {
    await setOutput(WAVE, '100.00');
    await expect(setWhole('5.00')).rejects.toBeInstanceOf(BrigadeOutputModeConflictError);
    await setOutput(WAVE, null);
    await setWhole('5.00');
    await expect(setOutput(STORIES, '1.00')).rejects.toBeInstanceOf(BrigadeOutputModeConflictError);
    expect(await setOutput(STORIES, null)).toEqual({ before: null, after: null });
    expect(await q('SELECT 1 FROM brigade_salary_object_outputs')).toHaveLength(0);
  });

  it('341: две транзакции одновременно в разные таблицы — проходит ровно одна', async () => {
    const results = await Promise.allSettled([setWhole('5.00'), setOutput(WAVE, '100.00')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(BrigadeOutputModeConflictError);
    const [whole] = await q<{ n: number }>('SELECT count(*)::int AS n FROM brigade_salary_brigade_outputs');
    const [objects] = await q<{ n: number }>('SELECT count(*)::int AS n FROM brigade_salary_object_outputs');
    expect(whole.n + objects.n).toBe(1);
  });

  it('341: та же сумма ещё раз — ни записи (updated_at прежний), ни аудита; стереть пустую — без изменений', async () => {
    const audited: Array<{ before: string | null; after: string | null }> = [];
    const auditFn = async (_client: unknown, change: { before: string | null; after: string | null }) => {
      audited.push(change);
    };
    expect(await setWhole('1000000', auditFn)).toEqual({ before: null, after: '1000000.00' });
    const [first] = await q<{ updated_at: string }>('SELECT updated_at::text AS updated_at FROM brigade_salary_brigade_outputs');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await setWhole('1000000.00', auditFn)).toEqual({ before: '1000000.00', after: '1000000.00' });
    const [second] = await q<{ updated_at: string }>('SELECT updated_at::text AS updated_at FROM brigade_salary_brigade_outputs');
    expect(second.updated_at).toBe(first.updated_at);
    expect(await setWhole(null, auditFn)).toEqual({ before: '1000000.00', after: null });
    expect(await setWhole(null, auditFn)).toEqual({ before: null, after: null });
    expect(audited).toEqual([{ before: null, after: '1000000.00' }, { before: '1000000.00', after: null }]);

    // У объектов — так же: та же сумма не трогает updated_at.
    await setOutput(WAVE, '100.00');
    const [objectFirst] = await q<{ updated_at: string }>('SELECT updated_at::text AS updated_at FROM brigade_salary_object_outputs');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await setOutput(WAVE, '100.00')).toEqual({ before: '100.00', after: '100.00' });
    const [objectSecond] = await q<{ updated_at: string }>('SELECT updated_at::text AS updated_at FROM brigade_salary_object_outputs');
    expect(objectSecond.updated_at).toBe(objectFirst.updated_at);
  });

  it('341: закрытый месяц с суммой бригаде — доли по КТУ × все минуты, mode = brigade; стёрли — снова по объектам', async () => {
    await closeSeptemberInHalves();
    // Минуты за месяц: А 1200, Б 1320, уволенный 600 → 312 000 = 120 000 / 132 000 / 60 000.
    await setWhole('312000.00');

    const result = await getBrigadeSalary(req, BRIGADE, '2026-09');

    expect(result.state).toBe('fixed');
    expect(result.mode).toBe('brigade');
    expect(result.output_amount).toBe('312000.00');
    expect(result.distribution).toBe('ok');
    expect(amounts(result.rows)).toEqual({ [A]: '120000.00', [B]: '132000.00', [F]: '60000.00' });
    expect(sumCents(result.rows)).toBe(31200000);
    // Объекты — только для показа: без выработки и долей, часы и минуты на месте (общежитие по дням).
    expect(result.objects.map(object => [object.object_name, object.state, object.output])).toEqual([
      ['ЖК Stories', 'by_brigade', null],
      ['ЖК Wave', 'by_brigade', null],
    ]);
    const b = result.rows.find(row => row.employee_id === B)!;
    expect(b.objects.map(part => [OBJECT_NAMES[part.object_key], part.counted_minutes, part.amount])).toEqual([
      ['ЖК Stories', 240, null],
      ['ЖК Wave', 1080, null],
    ]);
    const stored = await q<{ mode: string; output_amount: string }>(
      'SELECT mode, output_amount::text AS output_amount FROM brigade_salary_results',
    );
    expect(stored).toEqual([{ mode: 'brigade', output_amount: '312000.00' }]);
    const shares = await getBrigadeShares(req, BRIGADE, '2026-09');
    expect(shares).toMatchObject({ state: 'fixed', mode: 'brigade', output_amount: '312000.00' });

    // Повторное чтение — без пересчёта; та же сумма — тоже.
    await setWhole('312000');
    await getBrigadeSalary(req, BRIGADE, '2026-09');
    expect(audit.calls).toEqual([]);

    // Стёрли сумму бригаде, внесли по объектам — пересчёт по объектам.
    await setWhole(null);
    await enterBoth();
    const byObjects = await getBrigadeSalary(req, BRIGADE, '2026-09');
    expect(byObjects.mode).toBe('objects');
    expect(amounts(byObjects.rows)).toEqual({ [A]: '120000.00', [B]: '132000.00', [F]: '60000.00' });
    expect((await q<{ mode: string }>('SELECT mode FROM brigade_salary_results'))[0].mode).toBe('objects');
  });

  it('341: сумма бригаде 0,00 — всем 0,00; у кого минут нет — тоже 0,00', async () => {
    const full = await addApproval('2026-09-01', '2026-09-30');
    const v = await addVersion(full, 1, payload({ [A]: { '2026-09-01': work(10) } }));
    await addObjects(v, { [A]: { [WAVE]: { '2026-09-01': 10 } } });
    await setWhole('0.00');
    const result = await getBrigadeSalary(req, BRIGADE, '2026-09');
    expect(result.distribution).toBe('ok');
    expect(amounts(result.rows)).toEqual({ [A]: '0.00', [B]: '0.00', [F]: '0.00' });
  });

  it('341: список «Бригады» — с людьми в месяце (переведённый — в обеих), с выработкой (и неактивная), без отделов', async () => {
    const MOVED_TO = '11111111-2222-4333-8444-555555555555';
    const EMPTY = '22222222-3333-4444-8555-666666666666';
    const ARCHIVED = '33333333-4444-4555-8666-777777777777';
    const OFFICE = '44444444-5555-4666-8777-888888888888';
    try {
      await q(`INSERT INTO org_departments (id, name, kind, is_active) VALUES
        ($1, 'бр.Новая', 'brigade', true), ($2, 'бр.Пустая', 'brigade', true),
        ($3, 'бр.Архив', 'brigade', false), ($4, 'Гарантийный отдел', 'department', true)`, [MOVED_TO, EMPTY, ARCHIVED, OFFICE]);
      // А: в бр.Аюби до 15.09, с 16.09 — в бр.Новая (текущий отдел — новая).
      await q(`INSERT INTO employees (id, full_name, org_department_id) VALUES (9001, 'Переведённый', $1)
        ON CONFLICT (id) DO UPDATE SET org_department_id = EXCLUDED.org_department_id`, [MOVED_TO]);
      await q(`INSERT INTO employee_assignments (employee_id, org_department_id, effective_from, effective_to) VALUES
        (9001, $1, '2026-01-01', '2026-09-15'), (9001, $2, '2026-09-16', NULL)`, [BRIGADE, MOVED_TO]);
      // В бр.Пустая только уволенный в августе — в сентябре её нет.
      await q(`INSERT INTO employees (id, full_name, org_department_id, employment_status, dismissal_date)
        VALUES (9002, 'Уволен в августе', $1, 'fired', '2026-08-20') ON CONFLICT (id) DO NOTHING`, [EMPTY]);
      // В отделе люди есть, но это не бригада.
      await q(`INSERT INTO employees (id, full_name, org_department_id) VALUES (9003, 'Офис', $1) ON CONFLICT (id) DO NOTHING`, [OFFICE]);
      // Неактивная бригада без людей, но с выработкой за сентябрь — в списке, чтобы её стереть.
      await q(`INSERT INTO brigade_salary_brigade_outputs (department_id, month, amount) VALUES ($1, '2026-09-01', 700)`, [ARCHIVED]);
      await setOutput(WAVE, '100.00');
      await setOutput(STORIES, '50.50');

      const list = await listBrigadeOutputs('2026-09', 'all');

      expect(list.map(item => item.name)).toEqual(['бр.Архив', 'бр.Аюби М.С.', 'бр.Новая']);
      expect(list.find(item => item.department_id === BRIGADE)).toEqual({
        department_id: BRIGADE, name: 'бр.Аюби М.С.', is_active: true,
        brigade_output: null, objects_output: '150.50', objects_with_output: 2,
      });
      expect(list.find(item => item.department_id === ARCHIVED)).toMatchObject({ is_active: false, brigade_output: '700.00' });
      // Видимые отделы — только они.
      expect((await listBrigadeOutputs('2026-09', [MOVED_TO])).map(item => item.name)).toEqual(['бр.Новая']);
      expect(await listBrigadeOutputs('2026-09', [])).toEqual([]);
    } finally {
      await q('DELETE FROM employee_assignments WHERE employee_id IN (9001)');
      await q('DELETE FROM employees WHERE id IN (9001, 9002, 9003)');
      await q('DELETE FROM org_departments WHERE id = ANY($1::uuid[])', [[MOVED_TO, EMPTY, ARCHIVED, OFFICE]]);
    }
  });
});
