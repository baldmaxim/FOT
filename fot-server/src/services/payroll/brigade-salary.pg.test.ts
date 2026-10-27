import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// «Табель → Зарплата» (миграция 330) на настоящем PostgreSQL: миграция и её повтор, CHECK, фиксация по
// редакциям закрытых подач (две половины и одна подача на месяц), «Требует перерасчёта» при открытой
// подаче, пересчёт при новой редакции и новом КТУ, неизменность при правке графика после фиксации,
// уволенный в месяце увольнения — по живому табелю, начальник участка — вне дележа.
// Состав, живой табель и графики подменены: их SQL проверяют свои тесты.
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
    };
  }),
}));

const audit = vi.hoisted(() => ({ calls: [] as Array<{ action: string; details: Record<string, unknown> }> }));
vi.mock('../audit.service.js', () => ({
  auditService: {
    logFromRequestWithClient: vi.fn(async (_client: unknown, _req: unknown, _user: unknown, action: string, options: { details: Record<string, unknown> }) => {
      audit.calls.push({ action, details: options.details });
    }),
  },
}));

import { getBrigadeSalary } from './brigade-salary.service.js';
import { setBrigadeKtu, setBrigadeOutput } from './brigade-salary-inputs.service.js';
import type { AuthenticatedRequest } from '../../types/index.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../docs/migrations/', import.meta.url));
const MIGRATION = readFileSync(`${MIGRATIONS_DIR}330_brigade_salary.sql`, 'utf8');

const BRIGADE = '5049c2c9-1334-49e6-8d55-7a04bebcaa8c';
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

const amounts = (rows: Array<{ employee_id: number; amount: string | null }>) => (
  Object.fromEntries(rows.map(row => [row.employee_id, row.amount]))
);

const sumCents = (rows: Array<{ amount: string | null }>) => rows.reduce(
  (sum, row) => sum + Math.round(Number(row.amount ?? 0) * 100), 0,
);

describe.skipIf(!PG_URL)('brigade salary (PostgreSQL, миграция 330)', () => {
  beforeAll(async () => {
    await q(`
      DROP TABLE IF EXISTS brigade_salary_results, brigade_salary_ktu, brigade_salary_outputs,
        timesheet_versions, timesheet_approvals, employees, org_departments, user_profiles CASCADE;
      CREATE TABLE user_profiles (id uuid PRIMARY KEY);
      CREATE TABLE org_departments (id uuid PRIMARY KEY, name text, kind text);
      CREATE TABLE employees (id bigint PRIMARY KEY, full_name text);
      CREATE TABLE timesheet_approvals (
        id bigserial PRIMARY KEY, department_id uuid, manager_employee_id bigint, status text,
        start_date date, end_date date, unlocked_at timestamptz);
      CREATE TABLE timesheet_versions (
        id bigserial PRIMARY KEY, approval_id bigint REFERENCES timesheet_approvals(id) ON DELETE CASCADE,
        revision int, payload jsonb);
    `);
    await q(MIGRATION);
    await q(MIGRATION);
    await q('INSERT INTO user_profiles (id) VALUES ($1)', [PROFILE]);
    await q(`INSERT INTO org_departments (id, name, kind) VALUES ($1, 'бр.Аюби М.С.', 'brigade')`, [BRIGADE]);
    await q(`INSERT INTO employees (id, full_name) VALUES (${A}, 'А'), (${B}, 'Б'), (${F}, 'Уволенный'), (${S}, 'Начальник')`);
  });

  beforeEach(async () => {
    await q('TRUNCATE brigade_salary_results, brigade_salary_ktu, brigade_salary_outputs, timesheet_versions, timesheet_approvals');
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
    fx.cutoff = new Map([[F, '2026-09-05']]);
    fx.workHours = 10;
    fx.liveCalls = [];
    audit.calls = [];
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('CHECK: месяц с 1-го, КТУ 0,5…2,0, выработка не отрицательная', async () => {
    await expect(q(`INSERT INTO brigade_salary_outputs (department_id, month, amount) VALUES ($1, '2026-09-02', 1)`, [BRIGADE]))
      .rejects.toThrow(/month_first_day/);
    await expect(q(`INSERT INTO brigade_salary_outputs (department_id, month, amount) VALUES ($1, '2026-09-01', -1)`, [BRIGADE]))
      .rejects.toThrow(/amount_non_negative/);
    await expect(q(`INSERT INTO brigade_salary_ktu (department_id, month, employee_id, ktu) VALUES ($1, '2026-09-01', ${A}, 0.4)`, [BRIGADE]))
      .rejects.toThrow(/ktu_range/);
    await expect(q(`INSERT INTO brigade_salary_ktu (department_id, month, employee_id, ktu) VALUES ($1, '2026-09-01', ${A}, 2.1)`, [BRIGADE]))
      .rejects.toThrow(/ktu_range/);
  });

  const closeSeptemberInHalves = async () => {
    const h1 = await addApproval('2026-09-01', '2026-09-15');
    const h2 = await addApproval('2026-09-16', '2026-09-30');
    // А: 12 ч при графике 10 → 10; Б: 10 ч; начальник участка в редакции есть.
    await addVersion(h1, 1, payload({
      [A]: { '2026-09-01': work(12) },
      [B]: { '2026-09-01': work(10) },
      [S]: { '2026-09-01': work(10) },
    }));
    // Б: корректировка 12 ч — целиком.
    await addVersion(h2, 1, payload({
      [A]: { '2026-09-16': work(10) },
      [B]: { '2026-09-16': work(12, { corrected: true, hours_overridden: true }) },
    }));
    return { h1, h2 };
  };

  it('две закрытые половины → фиксируется; уволенный — по живому табелю до увольнения; начальник участка вне дележа', async () => {
    await closeSeptemberInHalves();
    await setBrigadeOutput(BRIGADE, '2026-09-01', '312000.00', PROFILE);

    const result = await getBrigadeSalary(req, BRIGADE, '2026-09');

    expect(result.state).toBe('fixed');
    expect(result.distribution).toBe('ok');
    // Минуты: А 600 + 600, Б 600 + 720, уволенный 600 (07.09 — после увольнения) → 1200 : 1320 : 600.
    expect(amounts(result.rows)).toEqual({ [A]: '120000.00', [B]: '132000.00', [F]: '60000.00' });
    expect(result.rows.find(row => row.employee_id === F)?.source).toBe('live');
    expect(result.rows.find(row => row.employee_id === A)?.source).toBe('version');
    expect(result.rows.some(row => row.employee_id === S)).toBe(false);
    expect(fx.liveCalls).toEqual([[F]]);

    const stored = await q<{ status: string; versions: unknown }>('SELECT status, versions FROM brigade_salary_results');
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe('fixed');
    expect(audit.calls).toEqual([]);
  });

  it('одна подача на месяц тоже закрывает месяц', async () => {
    const full = await addApproval('2026-09-01', '2026-09-30');
    await addVersion(full, 1, payload({ [A]: { '2026-09-01': work(10) }, [B]: { '2026-09-01': work(10) } }));
    await setBrigadeOutput(BRIGADE, '2026-09-01', '0.00', PROFILE);

    const result = await getBrigadeSalary(req, BRIGADE, '2026-09');

    expect(result.state).toBe('fixed');
    expect(amounts(result.rows)).toEqual({ [A]: '0.00', [B]: '0.00', [F]: '0.00' });
  });

  it('половина не закрыта и результата не было → «Предварительно» по живому табелю, ничего не сохраняется', async () => {
    const h1 = await addApproval('2026-09-01', '2026-09-15');
    await addVersion(h1, 1, payload({ [A]: { '2026-09-01': work(10) } }));
    await addApproval('2026-09-16', '2026-09-30', 'draft');
    fx.live.set(A, new Map([['2026-09-01', { status: 'work', hours: 10, corrected: false, hoursOverridden: false }]]));
    await setBrigadeOutput(BRIGADE, '2026-09-01', '1000.00', PROFILE);

    const result = await getBrigadeSalary(req, BRIGADE, '2026-09');

    expect(result.state).toBe('preliminary');
    expect(result.as_of).toBe('2026-09-30');
    expect(result.open_ranges).toEqual([{ start_date: '2026-09-16', end_date: '2026-09-30' }]);
    // А 600 мин, уволенный 600 мин, Б без дней.
    expect(amounts(result.rows)).toEqual({ [A]: '500.00', [B]: '0.00', [F]: '500.00' });
    expect(await q('SELECT 1 FROM brigade_salary_results')).toHaveLength(0);
  });

  it('открыли подачу → «Требует перерасчёта» с прежними суммами; новая редакция после закрытия → пересчёт и аудит', async () => {
    const { h2 } = await closeSeptemberInHalves();
    await setBrigadeOutput(BRIGADE, '2026-09-01', '312000.00', PROFILE);
    await getBrigadeSalary(req, BRIGADE, '2026-09');

    await q('UPDATE timesheet_approvals SET unlocked_at = now() WHERE id = $1', [h2]);
    const stale = await getBrigadeSalary(req, BRIGADE, '2026-09');
    expect(stale.state).toBe('stale');
    expect(amounts(stale.rows)[A]).toBe('120000.00');
    expect(stale.open_ranges).toEqual([{ start_date: '2026-09-16', end_date: '2026-09-30' }]);

    // Закрыли снова: у А добавился день.
    await addVersion(h2, 2, payload({
      [A]: { '2026-09-16': work(10), '2026-09-17': work(10) },
      [B]: { '2026-09-16': work(12, { corrected: true, hours_overridden: true }) },
    }));
    await q('UPDATE timesheet_approvals SET unlocked_at = NULL WHERE id = $1', [h2]);
    const recalculated = await getBrigadeSalary(req, BRIGADE, '2026-09');

    expect(recalculated.state).toBe('fixed');
    expect(sumCents(recalculated.rows)).toBe(31200000);
    expect(Number(amounts(recalculated.rows)[A])).toBeGreaterThan(120000);
    expect(audit.calls.map(call => call.action)).toEqual(['BRIGADE_SALARY_RECALCULATED']);
    expect(audit.calls[0].details.total).toEqual({ from: '312000.00', to: '312000.00' });
  });

  it('правка графика после фиксации сумму не меняет; новый КТУ — пересчитывает', async () => {
    await closeSeptemberInHalves();
    await setBrigadeOutput(BRIGADE, '2026-09-01', '312000.00', PROFILE);
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

  it('КТУ 1,0 строку не хранит, выработка null — «не введена»', async () => {
    await setBrigadeKtu(BRIGADE, '2026-09-01', A, 15, PROFILE);
    await setBrigadeKtu(BRIGADE, '2026-09-01', A, 10, PROFILE);
    expect(await q('SELECT 1 FROM brigade_salary_ktu')).toHaveLength(0);

    await closeSeptemberInHalves();
    const result = await getBrigadeSalary(req, BRIGADE, '2026-09');
    expect(result.distribution).toBe('no_output');
    expect(result.rows.every(row => row.amount === null)).toBe(true);
  });
});
