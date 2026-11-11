import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «Табель» → «По отделу»: «Открыть табель» и «Закрыть табель» отдела на НАСТОЯЩЕМ PostgreSQL.
 *
 * Главное, что мок не докажет: вместе с табелем отдела открываются личные табели, держащие строки его людей; весь
 * месяц — одной транзакцией, у каждой половины своя запись; закрывается только своё; набор совпадает с замками,
 * которые показывает сетка.
 *
 * Запуск: FOT_TEST_PG_URL=postgres://... npx vitest run src/services/timesheet-department-period.pg.test.ts
 * Без переменной PG-набор скипается. БД — пустая тестовая: срез таблиц пересоздаётся.
 */
const PG_URL = process.env.FOT_TEST_PG_URL;
const describeIf = PG_URL ? describe : describe.skip;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));
vi.mock('../config/postgres.js', async () => {
  const { Pool, types } = await import('pg');
  types.setTypeParser(1082, (val: string) => val);
  types.setTypeParser(20, (val: string) => Number.parseInt(val, 10));
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 6 }) : null;
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
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  };
});
vi.mock('./skud-shared.service.js', async (importActual) => ({
  ...(await importActual<typeof import('./skud-shared.service.js')>()),
  collectDeptIds: vi.fn(async (departmentId: string) => [departmentId]),
}));

const {
  getDepartmentPeriodState,
  listDepartmentPeriodCloseTargets,
  openDepartmentPeriod,
  previewDepartmentPeriod,
  resolveDepartmentPeriodRange,
} = await import('./timesheet-department-period.service.js');
const { WeekendPeriodConflictError, listActiveUnlocks } = await import('./staff-weekends-periods.service.js');
const { loadApprovalLocksForEmployeesInPeriod } = await import('./timesheet-lock.service.js');

const LINE = '00000000-0000-4000-8000-0000000000a1';
const GENERAL = '00000000-0000-4000-8000-0000000000a2';
const ECONOMY = '00000000-0000-4000-8000-0000000000a3';
const USER = '00000000-0000-4000-8000-0000000000e1';
const OP_1 = '11111111-1111-4111-8111-111111111111';
const OP_2 = '22222222-2222-4222-8222-222222222222';
const OP_3 = '33333333-3333-4333-8333-333333333333';
const OP_4 = '44444444-4444-4444-8444-444444444444';

// Люди ЛИНИИ: рабочий, руководитель с личным табелем на себя (Иванишин), руководитель с личным табелем на месяц
// и подчинённым из Экономического сектора (Баранский). Переведённый из ЛИНИИ в Общестрой 20.10.
const WORKER = 1;
const IVANISHIN = 2;
const BARANSKY = 3;
const ECONOMIST = 4;
const MOVED = 5;
const GENERAL_WORKER = 6;

const allowAll = async (): Promise<boolean> => true;

const q = async <T extends import('pg').QueryResultRow>(sql: string, params?: unknown[]) =>
  (await pg.pool!.query<T>(sql, params)).rows;

const addApproval = async (fields: {
  departmentId?: string | null;
  managerEmployeeId?: number | null;
  status?: string;
  start?: string;
  end?: string;
  employees: number[];
}): Promise<number> => {
  const [row] = await q<{ id: number }>(
    `INSERT INTO timesheet_approvals (department_id, manager_employee_id, start_date, end_date, status)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [fields.departmentId ?? null, fields.managerEmployeeId ?? null, fields.start ?? '2026-10-01', fields.end ?? '2026-10-15', fields.status ?? 'approved'],
  );
  for (const employeeId of fields.employees) {
    await q('INSERT INTO timesheet_approval_employees (approval_id, employee_id) VALUES ($1, $2)', [row!.id, employeeId]);
  }
  return Number(row!.id);
};

const range = (start: string, end: string) => {
  const resolved = resolveDepartmentPeriodRange(start, end);
  if (!resolved) throw new Error(`bad range ${start}..${end}`);
  return resolved;
};
const FULL = () => range('2026-10-01', '2026-10-31');
const H1 = () => range('2026-10-01', '2026-10-15');
const H2 = () => range('2026-10-16', '2026-10-31');

const unlockedIds = async (): Promise<number[]> => (await q<{ id: number }>(
  'SELECT id FROM timesheet_approvals WHERE unlocked_at IS NOT NULL ORDER BY id',
)).map(row => Number(row.id));

const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);

describe('диапазон кнопки', () => {
  it('1–15, 16–последний и весь месяц', () => {
    expect(resolveDepartmentPeriodRange('2026-10-01', '2026-10-15')?.halves.map(h => h.half)).toEqual([1]);
    expect(resolveDepartmentPeriodRange('2026-10-16', '2026-10-31')?.halves.map(h => h.half)).toEqual([2]);
    expect(resolveDepartmentPeriodRange('2026-10-01', '2026-10-31')?.halves).toEqual([
      { half: 1, startDate: '2026-10-01', endDate: '2026-10-15' },
      { half: 2, startDate: '2026-10-16', endDate: '2026-10-31' },
    ]);
  });

  it('февраль и 30-дневные месяцы — по своему последнему дню', () => {
    expect(resolveDepartmentPeriodRange('2026-02-01', '2026-02-28')?.halves.map(h => h.endDate)).toEqual(['2026-02-15', '2026-02-28']);
    expect(resolveDepartmentPeriodRange('2028-02-16', '2028-02-29')?.halves.map(h => h.half)).toEqual([2]);
    expect(resolveDepartmentPeriodRange('2026-11-01', '2026-11-30')?.halves).toHaveLength(2);
    expect(resolveDepartmentPeriodRange('2026-11-01', '2026-11-31')).toBeNull();
  });

  it('прочие диапазоны не принимаются', () => {
    expect(resolveDepartmentPeriodRange('2026-10-02', '2026-10-15')).toBeNull();
    expect(resolveDepartmentPeriodRange('2026-10-01', '2026-10-30')).toBeNull();
    expect(resolveDepartmentPeriodRange('2026-10-16', '2026-11-15')).toBeNull();
    expect(resolveDepartmentPeriodRange('2026-10-1', '2026-10-15')).toBeNull();
  });
});

describeIf('кнопки отдела в «Табеле» на настоящей БД', () => {
  beforeAll(async () => {
    await pg.pool!.query(`
      CREATE SCHEMA IF NOT EXISTS app_auth;
      DROP TABLE IF EXISTS staff_weekend_unlocks, timesheet_approval_employees, timesheet_approvals,
        employee_dismissal_events, employee_assignments, employee_department_access,
        user_profiles, system_roles, employees, org_departments, system_settings, app_auth.users CASCADE;
      CREATE TABLE system_settings (key text PRIMARY KEY, value text NULL);
      CREATE TABLE org_departments (id uuid PRIMARY KEY, name text NOT NULL, parent_id uuid NULL, is_active boolean NOT NULL DEFAULT true);
      CREATE TABLE employees (
        id integer PRIMARY KEY, full_name text NULL, org_department_id uuid NULL,
        is_archived boolean NOT NULL DEFAULT false, employment_status text NOT NULL DEFAULT 'active', dismissal_date date,
        excluded_from_timesheet boolean NOT NULL DEFAULT false, excluded_from_timesheet_date date
      );
      CREATE TABLE system_roles (id uuid PRIMARY KEY, code text NOT NULL UNIQUE, is_admin boolean NOT NULL DEFAULT false, is_active boolean NOT NULL DEFAULT true);
      CREATE TABLE user_profiles (id uuid PRIMARY KEY, employee_id integer NULL, system_role_id uuid NULL, is_approved boolean NOT NULL DEFAULT true);
      CREATE TABLE app_auth.users (id uuid PRIMARY KEY, is_disabled boolean NOT NULL DEFAULT false);
      CREATE TABLE employee_department_access (
        id serial PRIMARY KEY, employee_id integer NOT NULL, department_id uuid NOT NULL,
        access_level text NOT NULL DEFAULT 'full', source text NOT NULL DEFAULT 'manual_admin_ui', is_active boolean NOT NULL DEFAULT true
      );
      CREATE TABLE employee_assignments (
        id serial PRIMARY KEY, employee_id integer NOT NULL, org_department_id uuid NULL,
        effective_from date NOT NULL, effective_to date NULL
      );
      CREATE TABLE employee_dismissal_events (
        id bigserial PRIMARY KEY, employee_id integer NOT NULL, from_department_id uuid,
        dismissal_date date, cancelled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE timesheet_approvals (
        id bigserial PRIMARY KEY, department_id uuid, manager_employee_id integer,
        start_date date NOT NULL, end_date date NOT NULL, status text NOT NULL,
        unlocked_at timestamptz, unlocked_by uuid, unlock_reason text, updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE timesheet_approval_employees (approval_id bigint NOT NULL, employee_id integer NOT NULL);
    `);
    // Таблица учёта — строго из файла миграции, а не копией здесь.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    await pg.pool!.query(readFileSync(resolve(process.cwd(), '../docs/migrations/350_staff_weekend_unlocks.sql'), 'utf8'));
  });

  beforeEach(async () => {
    await pg.pool!.query(`TRUNCATE staff_weekend_unlocks, timesheet_approval_employees, timesheet_approvals,
      employee_assignments, employee_dismissal_events, employees, org_departments RESTART IDENTITY CASCADE`);
    await q(
      `INSERT INTO org_departments (id, name) VALUES ($1, 'ЛИНИЯ'), ($2, 'ЛИНИЯ-Общестрой'), ($3, 'Экономический сектор')`,
      [LINE, GENERAL, ECONOMY],
    );
    await q(`INSERT INTO employees (id, full_name, org_department_id) VALUES
      (1, 'Рабочий Иван', $1), (2, 'Иванишин Сергей', $1), (3, 'Баранский Сергей', $1),
      (4, 'Экономист Анна', $3), (5, 'Переведённый Пётр', $2), (6, 'Общестрой Олег', $2)`, [LINE, GENERAL, ECONOMY]);
    const assignments: Array<[number, string, string, string | null]> = [
      [WORKER, LINE, '2026-01-01', null],
      [IVANISHIN, LINE, '2026-01-01', null],
      [BARANSKY, LINE, '2026-01-01', null],
      [ECONOMIST, ECONOMY, '2026-01-01', null],
      [MOVED, LINE, '2026-01-01', '2026-10-19'],
      [MOVED, GENERAL, '2026-10-20', null],
      [GENERAL_WORKER, GENERAL, '2026-01-01', null],
    ];
    for (const [employeeId, departmentId, from, to] of assignments) {
      await q(
        'INSERT INTO employee_assignments (employee_id, org_department_id, effective_from, effective_to) VALUES ($1, $2, $3, $4)',
        [employeeId, departmentId, from, to],
      );
    }
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  /** Октябрь ЛИНИИ как на проде: две половины отдела, личные табели Иванишина (1–15) и Баранского (1–31). */
  const seedLineOctober = async () => ({
    lineH1: await addApproval({ departmentId: LINE, employees: [WORKER, IVANISHIN, BARANSKY, MOVED] }),
    lineH2: await addApproval({ departmentId: LINE, start: '2026-10-16', end: '2026-10-31', employees: [WORKER, IVANISHIN, BARANSKY, MOVED] }),
    ivanishin: await addApproval({ managerEmployeeId: IVANISHIN, status: 'submitted', employees: [IVANISHIN] }),
    baransky: await addApproval({
      managerEmployeeId: BARANSKY, status: 'submitted', start: '2026-10-01', end: '2026-10-31', employees: [BARANSKY, ECONOMIST],
    }),
    generalH2: await addApproval({ departmentId: GENERAL, start: '2026-10-16', end: '2026-10-31', employees: [MOVED, GENERAL_WORKER] }),
  });

  describe('что откроет кнопка', () => {
    it('весь месяц: обе половины отдела и личные табели его людей, по своим половинам', async () => {
      const ids = await seedLineOctober();

      const state = await getDepartmentPeriodState(LINE, FULL(), allowAll);

      expect(state.halves.map(half => half.open_ids)).toEqual([
        sorted([ids.lineH1, ids.ivanishin, ids.baransky]),
        sorted([ids.lineH2, ids.baransky]),
      ]);
      expect(state.halves.every(half => half.close_ids.length === 0)).toBe(true);
    });

    it('табель другого отдела, где переведённый с 20.10, в кнопку ЛИНИИ не попадает', async () => {
      const ids = await seedLineOctober();
      const state = await getDepartmentPeriodState(LINE, H2(), allowAll);
      expect(state.halves[0]?.open_ids).not.toContain(ids.generalH2);
    });

    it('набор — ровно те подачи, что сетка показывает замком', async () => {
      await seedLineOctober();
      const opened = await openDepartmentPeriod({
        departmentId: LINE,
        range: FULL(),
        operationIds: { 1: OP_1, 2: OP_2 },
        expectedIds: (await previewDepartmentPeriod(LINE, FULL(), allowAll)).expected_approval_ids,
        userId: USER,
        reason: null,
        canAccess: allowAll,
      });
      expect(opened.length).toBe(4);

      // После открытия у людей ЛИНИИ в их днях ЛИНИИ замков нет.
      const locks = await loadApprovalLocksForEmployeesInPeriod([WORKER, IVANISHIN, BARANSKY], '2026-10-01', '2026-10-31');
      expect(locks).toEqual([]);
      const moved = await loadApprovalLocksForEmployeesInPeriod([MOVED], '2026-10-01', '2026-10-19');
      expect(moved).toEqual([]);
    });

    it('недоступная пользователю подача не открывается и не показывается', async () => {
      const ids = await seedLineOctober();
      const departmentOnly = async (approval: { department_id: string | null }) => approval.department_id != null;

      const state = await getDepartmentPeriodState(LINE, FULL(), departmentOnly);

      expect(state.halves.map(half => half.open_ids)).toEqual([[ids.lineH1], [ids.lineH2]]);
      expect(state.approvals.map(item => item.id)).toEqual([ids.lineH1, ids.lineH2]);
    });
  });

  describe('окно подтверждения', () => {
    it('состав — табель отдела по половинам и личные табели его людей, без списков', async () => {
      const ids = await seedLineOctober();

      const preview = await previewDepartmentPeriod(LINE, FULL(), allowAll);

      expect(preview.expected_approval_ids).toEqual(sorted([ids.lineH1, ids.lineH2, ids.ivanishin, ids.baransky]));
      expect(preview).not.toHaveProperty('others');
      expect(preview).not.toHaveProperty('open_approvals');
    });
  });

  describe('открыть', () => {
    it('весь месяц одной транзакцией: статусы прежние, у каждой половины своя запись', async () => {
      const ids = await seedLineOctober();
      const expected = (await previewDepartmentPeriod(LINE, FULL(), allowAll)).expected_approval_ids;

      await openDepartmentPeriod({
        departmentId: LINE, range: FULL(), operationIds: { 1: OP_1, 2: OP_2 }, expectedIds: expected, userId: USER,
        reason: 'правка октября', canAccess: allowAll,
      });

      expect(await unlockedIds()).toEqual(sorted([ids.lineH1, ids.lineH2, ids.ivanishin, ids.baransky]));
      const statuses = await q<{ id: number; status: string; unlock_reason: string | null }>(
        'SELECT id, status, unlock_reason FROM timesheet_approvals WHERE unlocked_at IS NOT NULL ORDER BY id',
      );
      expect(statuses.every(row => row.unlock_reason === 'правка октября')).toBe(true);
      expect(statuses.find(row => Number(row.id) === ids.ivanishin)?.status).toBe('submitted');

      const records = await q<{ operation_id: string; period_start: string; approval_id: number }>(
        'SELECT operation_id, period_start::text AS period_start, approval_id FROM staff_weekend_unlocks ORDER BY operation_id, approval_id',
      );
      expect(records.filter(row => row.operation_id === OP_1).map(row => Number(row.approval_id)))
        .toEqual(sorted([ids.lineH1, ids.ivanishin, ids.baransky]));
      expect(records.filter(row => row.operation_id === OP_2).map(row => Number(row.approval_id)))
        .toEqual(sorted([ids.lineH2, ids.baransky]));
      expect(new Set(records.map(row => row.period_start))).toEqual(new Set(['2026-10-01', '2026-10-16']));
    });

    it('состав разошёлся с окном — ничего не открыто', async () => {
      const ids = await seedLineOctober();

      await expect(openDepartmentPeriod({
        departmentId: LINE, range: FULL(), operationIds: { 1: OP_1, 2: OP_2 }, expectedIds: [ids.lineH1, ids.lineH2],
        userId: USER, reason: null, canAccess: allowAll,
      })).rejects.toBeInstanceOf(WeekendPeriodConflictError);

      expect(await unlockedIds()).toEqual([]);
      expect(await q('SELECT 1 FROM staff_weekend_unlocks')).toHaveLength(0);
    });

    it('повтор после успеха: открывать нечего — конфликт, ничего не меняется', async () => {
      await seedLineOctober();
      const expected = (await previewDepartmentPeriod(LINE, FULL(), allowAll)).expected_approval_ids;
      const params = {
        departmentId: LINE, range: FULL(), operationIds: { 1: OP_1, 2: OP_2 }, expectedIds: expected, userId: USER,
        reason: null, canAccess: allowAll,
      };
      await openDepartmentPeriod(params);
      const before = await q('SELECT * FROM staff_weekend_unlocks ORDER BY operation_id, approval_id');

      await expect(openDepartmentPeriod(params)).rejects.toBeInstanceOf(WeekendPeriodConflictError);

      expect(await q('SELECT * FROM staff_weekend_unlocks ORDER BY operation_id, approval_id')).toEqual(before);
    });

    it('две вкладки одновременно: открывает одна, вторая ничего не пишет', async () => {
      await seedLineOctober();
      const expected = (await previewDepartmentPeriod(LINE, FULL(), allowAll)).expected_approval_ids;
      const run = (first: string, second: string) => openDepartmentPeriod({
        departmentId: LINE, range: FULL(), operationIds: { 1: first, 2: second }, expectedIds: expected, userId: USER,
        reason: null, canAccess: allowAll,
      });

      const results = await Promise.allSettled([run(OP_1, OP_2), run(OP_3, OP_4)]);

      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const operations = await q<{ operation_id: string }>('SELECT DISTINCT operation_id FROM staff_weekend_unlocks');
      expect(operations).toHaveLength(2);
    });

    it('половина 1–15 открывает только свою половину', async () => {
      const ids = await seedLineOctober();
      const expected = (await previewDepartmentPeriod(LINE, H1(), allowAll)).expected_approval_ids;

      await openDepartmentPeriod({
        departmentId: LINE, range: H1(), operationIds: { 1: OP_1 }, expectedIds: expected, userId: USER, reason: null,
        canAccess: allowAll,
      });

      // Личный табель Баранского — на весь месяц: открыт целиком, это видно в окне (1–31).
      expect(await unlockedIds()).toEqual(sorted([ids.lineH1, ids.ivanishin, ids.baransky]));
      const state = await getDepartmentPeriodState(LINE, FULL(), allowAll);
      expect(state.halves.map(half => half.open_ids)).toEqual([[], [ids.lineH2]]);
      expect(state.halves[0]?.close_ids).toEqual(sorted([ids.lineH1, ids.ivanishin, ids.baransky]));
      // Открытый из «1–15» личный табель на месяц закрывается и из «16–31».
      expect(state.halves[1]?.close_ids).toEqual([ids.baransky]);
    });
  });

  describe('закрыть', () => {
    it('закрывает свои подачи отдела и открытое кнопкой, личный табель, открытый вручную, — нет', async () => {
      const ids = await seedLineOctober();
      const foreign = await addApproval({ managerEmployeeId: ECONOMIST, status: 'approved', employees: [ECONOMIST, WORKER] });
      const expected = (await previewDepartmentPeriod(LINE, FULL(), allowAll)).expected_approval_ids;
      expect(expected).toContain(foreign);
      // Личный табель экономиста открыли вручную раньше кнопки — в её состав он уже не входит.
      await q('UPDATE timesheet_approvals SET unlocked_at = now() WHERE id = $1', [foreign]);
      const fresh = (await previewDepartmentPeriod(LINE, FULL(), allowAll)).expected_approval_ids;
      await openDepartmentPeriod({
        departmentId: LINE, range: FULL(), operationIds: { 1: OP_1, 2: OP_2 }, expectedIds: fresh, userId: USER,
        reason: null, canAccess: allowAll,
      });

      const targets = (await listDepartmentPeriodCloseTargets(LINE, FULL(), allowAll)).map(row => Number(row.id));

      expect(sorted(targets)).toEqual(sorted([ids.lineH1, ids.lineH2, ids.ivanishin, ids.baransky]));
      expect(targets).not.toContain(foreign);
    });

    it('подачу отдела, открытую вручную по старой кнопке, закрывает', async () => {
      const ids = await seedLineOctober();
      await q('UPDATE timesheet_approvals SET unlocked_at = now() WHERE id = $1', [ids.lineH2]);

      const targets = (await listDepartmentPeriodCloseTargets(LINE, H2(), allowAll)).map(row => Number(row.id));

      expect(targets).toEqual([ids.lineH2]);
    });

    it('открыто из «Табеля» — видно и «Выходным» того же отдела (общий учёт)', async () => {
      const ids = await seedLineOctober();
      const expected = (await previewDepartmentPeriod(LINE, H1(), allowAll)).expected_approval_ids;
      await openDepartmentPeriod({
        departmentId: LINE, range: H1(), operationIds: { 1: OP_1 }, expectedIds: expected, userId: USER, reason: null,
        canAccess: allowAll,
      });

      const weekends = (await listActiveUnlocks([LINE], ['2026-10-01'])).map(row => Number(row.id));
      expect(sorted(weekends)).toEqual(sorted([ids.lineH1, ids.ivanishin, ids.baransky]));
    });
  });
});
