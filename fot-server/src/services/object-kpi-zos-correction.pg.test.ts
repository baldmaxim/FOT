import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { PoolClient } from 'pg';

// Исправление плановой ЗОС на настоящем PostgreSQL: снимки, отчёт и премия считаются в SQL, мок
// драйвера показал бы ровно то, что ему подложили. Данные — реальные остатки, акты и ДС четырёх
// объектов прода (июль–ноябрь 2026), снимки ставит настоящая фиксация. Запускается только при
// FOT_TEST_PG_URL — ПУСТАЯ тестовая БД. Таблицы — в своей схеме (search_path), app_auth.users
// пересоздаётся, как в соседних pg-тестах. В обычном прогоне пропускается.

const PG_URL = process.env.FOT_TEST_PG_URL;
const SCHEMA = 'kpi_zos_fix_pg_test';

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../config/postgres.js', async () => {
  const { Pool } = await import('pg');
  pg.pool = process.env.FOT_TEST_PG_URL
    ? new Pool({
      connectionString: process.env.FOT_TEST_PG_URL,
      options: '-c search_path=kpi_zos_fix_pg_test',
      max: 6,
    })
    : null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool.query(sql, params as unknown[]);
  };
  const withTransaction = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
    const client = await pg.pool!.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
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
    withTransaction,
  };
});

import { computeManagerPremium, fetchManagerPremium } from './object-kpi-premium.service.js';
import { fixMonthPlan, revisePlan } from './object-kpi-plan.service.js';
import { OBJECT_KPI_REPORT_SQL, type ObjectKpiReportRow } from './object-kpi-report.service.js';
import { updateContract } from './object-kpi.service.js';
import {
  addMonthsClamped,
  buildRevertTargets,
  correctPlannedZos,
  resolveCorrectionActor,
  type IZosCorrectionTarget,
} from './object-kpi-zos-correction.service.js';

const ADMIN = '00000000-0000-0000-0000-0000000ad111';
const USER = '00000000-0000-0000-0000-0000000ad222';
const ACTOR = { userId: ADMIN, userName: 'Админ Тестовый' };
const SYSTEM = { userId: null, userName: null };

interface IObjectFixture {
  id: string;
  contractId: string;
  name: string;
  number: string;
  manager: { id: number; name: string };
  base: string;
  opening: string;
  start: string;
  fromDate: string;
  toDate: string;
  acts: Array<[string, string]>;
  addenda?: Array<[string, string]>;
}

const OBJECTS: IObjectFixture[] = [
  {
    id: '00000000-0000-0000-0000-00000000001a', contractId: '00000000-0000-0000-0000-0000000c001a',
    name: 'ЖК Инжой', number: 'ИРД-240626-3', manager: { id: 1, name: 'Родак Валерий' },
    base: '16895363164.81', opening: '7737039471.84', start: '2026-07-01',
    fromDate: '2027-07-31', toDate: '2026-12-26',
    acts: [['2026-07-20', '625720365.91'], ['2026-08-20', '973839789.95'], ['2026-09-20', '641406359.56']],
  },
  {
    id: '00000000-0000-0000-0000-00000000002b', contractId: '00000000-0000-0000-0000-0000000c002b',
    name: 'ЖК Марк (лот 33)', number: 'ЗИЛ-33-РД-0527/24', manager: { id: 2, name: 'Кривов Алексей Сергеевич' },
    base: '7418018464.72', opening: '3449574880.31', start: '2026-07-01',
    fromDate: '2026-04-30', toDate: '2026-11-30',
    acts: [['2026-07-20', '234579410.16'], ['2026-08-20', '492485246.82']],
  },
  {
    id: '00000000-0000-0000-0000-00000000003c', contractId: '00000000-0000-0000-0000-0000000c003c',
    name: 'ЖК Примавера К14', number: 'К14', manager: { id: 3, name: 'Савченко Максим' },
    base: '15722967302.48', opening: '11096576146.40', start: '2026-07-01',
    fromDate: '2028-02-01', toDate: '2028-03-01',
    acts: [['2026-07-20', '421193613.00'], ['2026-08-20', '375768497.15'], ['2026-09-20', '428211558.44'], ['2026-10-31', '461320351.31']],
    addenda: [['2026-10-01', '-42621269.31']],
  },
  {
    id: '00000000-0000-0000-0000-00000000004d', contractId: '00000000-0000-0000-0000-0000000c004d',
    name: 'ЖК King and Sons', number: '05/2024-КС', manager: { id: 4, name: 'Баранский Сергей Сергеевич' },
    base: '3736029593.01', opening: '2042231622.76', start: '2026-08-01',
    fromDate: '2026-11-15', toDate: '2026-04-01',
    acts: [['2026-08-20', '105177515.06'], ['2026-09-20', '64245438.93']],
  },
];
const [INJOY, MARK, PRIMAVERA, KING] = OBJECTS;
const FIXED_MONTHS = ['2026-09-01', '2026-10-01', '2026-11-01'];
const PREMIUM_MONTHS = ['2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01'];

const exec = async (sql: string, params?: unknown[]) => (await pg.pool!.query(sql, params)).rows;

const inTransaction = async <T>(fn: (client: PoolClient) => Promise<T>, commit = true): Promise<T> => {
  const client = await pg.pool!.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

/** Цели — по текущему состоянию БД, как зашиты в скрипт по состоянию прода. */
const targetsFromDb = async (objects = OBJECTS): Promise<IZosCorrectionTarget[]> => {
  const result: IZosCorrectionTarget[] = [];
  for (const object of objects) {
    const [contract] = await exec('SELECT version FROM object_contracts WHERE id = $1', [object.contractId]);
    const plans = await exec(
      `SELECT to_char(period_month, 'YYYY-MM-DD') AS month, id, revision
         FROM object_kpi_month_plans WHERE skud_object_id = $1 AND is_current ORDER BY period_month`,
      [object.id],
    );
    result.push({
      objectId: object.id,
      objectName: object.name,
      contractId: object.contractId,
      contractNumber: object.number,
      contractVersion: Number(contract.version),
      fromDate: object.fromDate,
      toDate: object.toDate,
      fixedMonths: plans.map(row => ({ month: row.month, planId: row.id, revision: row.revision })),
      reason: `Сверка: ${object.number}`,
    });
  }
  return result;
};

const premiums = async (object: IObjectFixture, client?: PoolClient): Promise<Array<string | null>> => {
  const params = { employeeId: object.manager.id, objectIds: [object.id], monthFrom: '2026-07-01', monthTo: '2026-11-01' };
  const result = client ? await computeManagerPremium(client, params) : await fetchManagerPremium(params);
  const byMonth = new Map(result.premium.map(month => [month.period_month, month.premium_amount]));
  return PREMIUM_MONTHS.map(month => byMonth.get(month) ?? null);
};

const reportRow = async (object: IObjectFixture, month: string): Promise<ObjectKpiReportRow> => {
  const [row] = await exec(OBJECT_KPI_REPORT_SQL, [month, month, [object.id]]);
  return row as ObjectKpiReportRow;
};

const currentPlans = (object: IObjectFixture) => exec(
  `SELECT to_char(period_month, 'YYYY-MM-DD') AS month, revision, status, fixed_source, correction_reason,
          to_char(control_date, 'YYYY-MM-DD') AS control_date, months_remaining, remainder, plan_amount
     FROM object_kpi_month_plans WHERE skud_object_id = $1 AND is_current ORDER BY period_month`,
  [object.id],
);

const counts = async () => {
  const [row] = await exec(
    `SELECT (SELECT count(*) FROM object_kpi_history)::int AS history,
            (SELECT count(*) FROM audit_logs)::int AS audit,
            (SELECT count(*) FROM object_kpi_month_plans)::int AS plans,
            (SELECT string_agg(planned_zos_date::text || ':' || version, ',' ORDER BY id) FROM object_contracts) AS contracts`,
  );
  return row;
};

const BEFORE = {
  [INJOY.manager.name]: ['300000', '300000', '300000', '0', '0'],
  [MARK.manager.name]: ['0', '0', '0', '0', '0'],
  [PRIMAVERA.manager.name]: ['74000', '0', '74000', '146000', '0'],
  [KING.manager.name]: [null, '0', '0', '0', '0'],
};
const AFTER = {
  [INJOY.manager.name]: ['0', '296000', '0', '0', '0'],
  [MARK.manager.name]: ['0', '272000', '0', '0', '0'],
  [PRIMAVERA.manager.name]: ['114000', '10000', '118000', '188000', '0'],
  [KING.manager.name]: [null, '0', '0', '0', '0'],
};

describe('addMonthsClamped — как date + interval в PostgreSQL', () => {
  it('конец месяца и високосный год', () => {
    expect(addMonthsClamped('2026-11-30', 3)).toBe('2027-02-28');
    expect(addMonthsClamped('2027-11-30', 3)).toBe('2028-02-29');
    expect(addMonthsClamped('2027-07-31', 3)).toBe('2027-10-31');
    expect(addMonthsClamped('2026-12-26', 3)).toBe('2027-03-26');
    expect(addMonthsClamped('2026-04-01', 3)).toBe('2026-07-01');
  });
});

// Подготовка — 12 настоящих фиксаций и пересчёты отчёта: несколько секунд на тест.
describe.skipIf(!PG_URL)('исправление плановой ЗОС на PostgreSQL', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await exec(`
      DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
      CREATE SCHEMA ${SCHEMA};
      CREATE SCHEMA IF NOT EXISTS app_auth;
      DROP TABLE IF EXISTS app_auth.users CASCADE;
      CREATE TABLE app_auth.users (
        id uuid PRIMARY KEY, email text NOT NULL, is_disabled boolean NOT NULL DEFAULT false, banned_until timestamptz
      );
      CREATE TABLE ${SCHEMA}.skud_objects (id uuid PRIMARY KEY, name text NOT NULL, is_active boolean NOT NULL DEFAULT true);
      CREATE TABLE ${SCHEMA}.employees (id integer PRIMARY KEY, full_name text);
      CREATE TABLE ${SCHEMA}.system_roles (id uuid PRIMARY KEY, code text NOT NULL, is_admin boolean NOT NULL DEFAULT false);
      CREATE TABLE ${SCHEMA}.user_profiles (
        id uuid PRIMARY KEY, full_name text, is_approved boolean NOT NULL DEFAULT true, system_role_id uuid
      );
      CREATE TABLE ${SCHEMA}.object_contracts (
        id uuid PRIMARY KEY, skud_object_id uuid NOT NULL UNIQUE, contract_number text, contract_date date,
        customer_name text, base_amount numeric(15,2) NOT NULL, planned_zos_date date, actual_zos_date date,
        plan_start_month date, opening_remainder numeric(15,2), planned_headcount integer,
        is_active boolean NOT NULL DEFAULT true, notes text, version bigint NOT NULL DEFAULT 1,
        created_by uuid, updated_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE ${SCHEMA}.object_contract_addenda (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contract_id uuid NOT NULL,
        status text NOT NULL, amount_delta numeric(15,2) NOT NULL, effective_date date NOT NULL
      );
      CREATE TABLE ${SCHEMA}.object_ks2_entries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), skud_object_id uuid NOT NULL,
        status text NOT NULL, entry_kind text NOT NULL DEFAULT 'act',
        amount numeric(15,2) NOT NULL, customer_signed_date date NOT NULL,
        period_month date GENERATED ALWAYS AS (date_trunc('month', customer_signed_date::timestamp)::date) STORED
      );
      CREATE TABLE ${SCHEMA}.object_kpi_month_plans (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        skud_object_id uuid NOT NULL,
        period_month date NOT NULL CHECK (EXTRACT(DAY FROM period_month) = 1),
        revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
        is_current boolean NOT NULL DEFAULT true,
        contract_total numeric(15,2), ks2_cumulative_before numeric(15,2), remainder numeric(15,2),
        planned_zos_date_used date, control_date date, months_remaining integer CHECK (months_remaining >= 1),
        calculated_plan_amount numeric(15,2) CHECK (calculated_plan_amount >= 0),
        override_plan_amount numeric(15,2) CHECK (override_plan_amount >= 0),
        plan_amount numeric(15,2) GENERATED ALWAYS AS (COALESCE(override_plan_amount, calculated_plan_amount)) STORED,
        status text NOT NULL CHECK (status IN ('open','fixed','corrected','data_incomplete')),
        fixed_at timestamptz, fixed_by uuid,
        fixed_source text CHECK (fixed_source IN ('auto','manual','economics_head_override')),
        correction_reason text, superseded_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        CHECK (status <> 'data_incomplete' OR calculated_plan_amount IS NULL),
        CHECK (override_plan_amount IS NULL OR btrim(COALESCE(correction_reason, '')) <> ''),
        UNIQUE (skud_object_id, period_month, revision)
      );
      CREATE UNIQUE INDEX ON ${SCHEMA}.object_kpi_month_plans (skud_object_id, period_month) WHERE is_current;
      CREATE TABLE ${SCHEMA}.object_kpi_assignments (
        skud_object_id uuid NOT NULL, employee_id integer NOT NULL, role_kind text NOT NULL,
        valid_from date NOT NULL, valid_to date
      );
      CREATE TABLE ${SCHEMA}.object_kpi_history (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), skud_object_id uuid, entity_kind text NOT NULL,
        entity_id uuid, action text NOT NULL, changed_fields text[] NOT NULL DEFAULT '{}',
        before_data jsonb, after_data jsonb, reason text, changed_by uuid, changed_by_name text,
        changed_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE ${SCHEMA}.audit_logs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, action text NOT NULL,
        entity_type text, entity_id text, details jsonb, ip_address text, user_agent text,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE TABLE ${SCHEMA}.kpi_premium_scale_versions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), valid_from date NOT NULL UNIQUE,
        base_amount numeric(15,2) NOT NULL, order_reference text, order_url text
      );
      CREATE TABLE ${SCHEMA}.kpi_premium_scale_points (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), version_id uuid NOT NULL,
        completion_pct numeric(6,2) NOT NULL, coefficient numeric(4,2) NOT NULL
      );
    `);
  }, 60_000);

  beforeEach(async () => {
    await exec(`
      TRUNCATE skud_objects, employees, system_roles, user_profiles, object_contracts, object_contract_addenda,
               object_ks2_entries, object_kpi_month_plans, object_kpi_assignments, object_kpi_history, audit_logs,
               kpi_premium_scale_versions, kpi_premium_scale_points;
      TRUNCATE app_auth.users;
      INSERT INTO system_roles VALUES ('00000000-0000-0000-0000-0000000001a0', 'admin', true),
                                      ('00000000-0000-0000-0000-0000000001b0', 'manager', false);
      INSERT INTO user_profiles VALUES ('${ADMIN}', 'Админ Тестовый', true, '00000000-0000-0000-0000-0000000001a0'),
                                       ('${USER}', 'Пользователь Тестовый', true, '00000000-0000-0000-0000-0000000001b0');
      INSERT INTO app_auth.users (id, email) VALUES ('${ADMIN}', 'Admin@Example.test'), ('${USER}', 'user@example.test');
      WITH v AS (
        INSERT INTO kpi_premium_scale_versions (valid_from, base_amount) VALUES ('2020-01-01', 200000) RETURNING id
      )
      INSERT INTO kpi_premium_scale_points (version_id, completion_pct, coefficient)
      SELECT v.id, p.pct, p.k FROM v,
        (VALUES (80, 0), (85, 0.25), (90, 0.5), (95, 0.8), (100, 1), (105, 1.25), (110, 1.5)) AS p(pct, k);
    `);
    for (const object of OBJECTS) {
      await exec('INSERT INTO skud_objects (id, name) VALUES ($1, $2)', [object.id, object.name]);
      await exec('INSERT INTO employees VALUES ($1, $2)', [object.manager.id, object.manager.name]);
      await exec(
        `INSERT INTO object_kpi_assignments VALUES ($1, $2, 'construction_manager', '2026-01-01', NULL)`,
        [object.id, object.manager.id],
      );
      await exec(
        `INSERT INTO object_contracts (id, skud_object_id, contract_number, base_amount, planned_zos_date,
                                       plan_start_month, opening_remainder)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [object.contractId, object.id, object.number, object.base, object.fromDate, object.start, object.opening],
      );
      for (const [signed, amount] of object.acts) {
        await exec(
          `INSERT INTO object_ks2_entries (skud_object_id, status, amount, customer_signed_date) VALUES ($1, 'signed', $2, $3)`,
          [object.id, amount, signed],
        );
      }
      for (const [effective, delta] of object.addenda ?? []) {
        await exec(
          `INSERT INTO object_contract_addenda (contract_id, status, amount_delta, effective_date) VALUES ($1, 'signed', $2, $3)`,
          [object.contractId, delta, effective],
        );
      }
      // Снимки ставит настоящая фиксация — как автофиксация прода в сентябре–ноябре.
      for (const month of FIXED_MONTHS) {
        await inTransaction(client => fixMonthPlan(client, SYSTEM, object.id, month, 'auto'));
      }
    }
  }, 60_000);

  afterAll(async () => {
    await pg.pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pg.pool?.query('DROP TABLE IF EXISTS app_auth.users');
    await pg.pool?.end();
  });

  it('данные теста — как прод: премии до исправления совпадают с порталом', async () => {
    for (const object of OBJECTS) {
      expect(await premiums(object)).toEqual(BEFORE[object.manager.name]);
    }
    expect(await currentPlans(MARK)).toEqual(FIXED_MONTHS.map(month => expect.objectContaining({
      month, revision: 1, status: 'fixed', control_date: '2026-07-30', months_remaining: 1,
    })));
  });

  it('исправление: договор, ревизии закрытых месяцев, открытые месяцы, история, аудит и премии как в плане', async () => {
    const operationId = '11111111-1111-4111-8111-111111111111';
    const targets = await targetsFromDb();
    await inTransaction(client => correctPlannedZos(client, ACTOR, targets, { operationId }));

    const contracts = await exec('SELECT id, to_char(planned_zos_date, \'YYYY-MM-DD\') AS d, version FROM object_contracts');
    for (const object of OBJECTS) {
      expect(contracts.find(row => row.id === object.contractId)).toMatchObject({ d: object.toDate, version: '2' });
    }

    const expectedMonths: Record<string, [string, number[]]> = {
      [INJOY.id]: ['2027-03-26', [7, 6, 5]],
      [MARK.id]: ['2027-02-28', [6, 5, 4]],
      [PRIMAVERA.id]: ['2028-06-01', [22, 21, 20]],
      [KING.id]: ['2026-07-01', [1, 1, 1]],
    };
    for (const object of OBJECTS) {
      const [control, months] = expectedMonths[object.id];
      const rows = await currentPlans(object);
      expect(rows).toEqual(FIXED_MONTHS.map((month, index) => expect.objectContaining({
        month, revision: 2, status: 'corrected', fixed_source: 'economics_head_override',
        control_date: control, months_remaining: months[index],
        correction_reason: expect.stringContaining(`операция ${operationId}`),
      })));
      for (const row of rows) {
        expect(Math.round(Number(row.plan_amount) * 100))
          .toBe(Math.round((Number(row.remainder) / row.months_remaining) * 100));
      }
      // Старые ревизии на месте, не текущие.
      const old = await exec(
        'SELECT count(*)::int AS n FROM object_kpi_month_plans WHERE skud_object_id = $1 AND revision = 1 AND NOT is_current AND superseded_at IS NOT NULL',
        [object.id],
      );
      expect(old[0].n).toBe(3);
    }

    // Открытые июль и август пересчитались по договору сами.
    expect(await reportRow(INJOY, '2026-07-01')).toMatchObject({ control_date: '2027-03-26', months_remaining: 9 });
    expect(await reportRow(MARK, '2026-08-01')).toMatchObject({ control_date: '2027-02-28', months_remaining: 7 });
    expect(await reportRow(KING, '2026-08-01')).toMatchObject({ months_remaining: 1, is_overdue: true });
    expect(await reportRow(KING, '2026-10-01')).toMatchObject({ control_date: '2026-07-01', months_remaining: 1, is_overdue: true });

    for (const object of OBJECTS) {
      expect(await premiums(object)).toEqual(AFTER[object.manager.name]);
    }

    const history = await exec(
      `SELECT entity_kind, count(*)::int AS n FROM object_kpi_history
        WHERE reason LIKE '%операция ${operationId}%' AND changed_by = $1 GROUP BY entity_kind ORDER BY 1`,
      [ADMIN],
    );
    expect(history).toEqual([{ entity_kind: 'contract', n: 4 }, { entity_kind: 'plan', n: 12 }]);
    const audit = await exec(
      `SELECT action, count(*)::int AS n FROM audit_logs
        WHERE details->>'operation_id' = $1 AND details->>'kind' = 'zos_correction' GROUP BY action ORDER BY 1`,
      [operationId],
    );
    expect(audit).toEqual([
      { action: 'OBJECT_KPI_CONTRACT_SAVED', n: 4 },
      { action: 'OBJECT_KPI_PLAN_REVISED', n: 12 },
    ]);
  });

  it('пробный прогон: премия на том же клиенте видит правку, после ROLLBACK база прежняя', async () => {
    const before = await counts();
    const targets = await targetsFromDb();
    const seen = await inTransaction(async (client) => {
      await correctPlannedZos(client, ACTOR, targets, { operationId: '22222222-2222-4222-8222-222222222222' });
      return premiums(INJOY, client);
    }, false);
    expect(seen).toEqual(AFTER[INJOY.manager.name]);
    expect(await counts()).toEqual(before);
    expect(await premiums(INJOY)).toEqual(BEFORE[INJOY.manager.name]);
  });

  it('текущая ревизия уже больше 1 — новая идёт следующим номером', async () => {
    await inTransaction(client => revisePlan(client, ACTOR, null, true, INJOY.id, '2026-10', { reason: 'Пересмотр' }));
    const targets = await targetsFromDb([INJOY]);
    expect(targets[0].fixedMonths.map(item => item.revision)).toEqual([1, 2, 1]);
    await inTransaction(client => correctPlannedZos(client, ACTOR, targets, { operationId: '33333333-3333-4333-8333-333333333333' }));
    expect((await currentPlans(INJOY)).map(row => row.revision)).toEqual([2, 3, 2]);
  });

  describe('отказ до первой записи', () => {
    const expectRefused = async (targets: IZosCorrectionTarget[], message: RegExp) => {
      const before = await counts();
      await expect(inTransaction(client => correctPlannedZos(client, ACTOR, targets, {
        operationId: '44444444-4444-4444-8444-444444444444',
      }))).rejects.toThrow(message);
      expect(await counts()).toEqual(before);
    };

    it('повторный запуск: дата уже исправлена', async () => {
      const targets = await targetsFromDb();
      await inTransaction(client => correctPlannedZos(client, ACTOR, targets, { operationId: '55555555-5555-4555-8555-555555555555' }));
      await expectRefused(targets, /плановая ЗОС 2026-12-26, ожидалась 2027-07-31|версия договора/);
    });

    it('версия договора другая', async () => {
      const targets = await targetsFromDb();
      await expectRefused(targets.map(target => ({ ...target, contractVersion: 7 })), /версия договора 1, ожидалась 7/);
    });

    it('номер договора другой', async () => {
      const targets = await targetsFromDb();
      await expectRefused(targets.map(target => ({ ...target, contractNumber: 'ЗИЛ-33-0669/24' })), /номер договора/);
    });

    it('неожиданный набор месяцев: снимка ноября нет в ожидаемых', async () => {
      const targets = await targetsFromDb();
      await expectRefused(
        targets.map(target => ({ ...target, fixedMonths: target.fixedMonths.slice(0, 2) })),
        /текущие снимки .*ожидались/,
      );
    });

    it('ручной план в закрытом месяце', async () => {
      await exec(
        `UPDATE object_kpi_month_plans SET override_plan_amount = 1000, correction_reason = 'ручной'
          WHERE skud_object_id = $1 AND period_month = '2026-10-01' AND is_current`,
        [PRIMAVERA.id],
      );
      await expectRefused(await targetsFromDb(), /2026-10 задан ручной план/);
    });

    it('ручной план в открытом месяце', async () => {
      await inTransaction(client => revisePlan(client, ACTOR, null, true, MARK.id, '2026-08', {
        reason: 'ручной', override_plan_amount: 1000,
      }));
      // Открытая строка августа — лишняя для ожидаемого набора, но отказ раньше: из-за ручного плана.
      await expectRefused(await targetsFromDb(), /2026-08 задан ручной план/);
    });

    it('внесён фактический ЗОС', async () => {
      await exec(`UPDATE object_contracts SET actual_zos_date = '2026-10-20' WHERE id = $1`, [KING.contractId]);
      await expectRefused(await targetsFromDb(), /фактический ЗОС/);
    });
  });

  it('параллельный пересмотр ждёт блокировку и второй текущей ревизии не создаёт', async () => {
    const targets = await targetsFromDb([INJOY]);
    const first = await pg.pool!.connect();
    const second = await pg.pool!.connect();
    try {
      await first.query('BEGIN');
      await correctPlannedZos(first, ACTOR, targets, { operationId: '66666666-6666-4666-8666-666666666666' });

      await second.query('BEGIN');
      let settled = false;
      const competing = revisePlan(second, ACTOR, null, true, INJOY.id, '2026-10', { reason: 'Параллельно' })
        .finally(() => { settled = true; });
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(settled).toBe(false);

      await first.query('COMMIT');
      await expect(competing).rejects.toThrow();
      await second.query('ROLLBACK');
    } finally {
      first.release();
      second.release();
    }
    const october = (await currentPlans(INJOY)).filter(row => row.month === '2026-10-01');
    expect(october).toEqual([expect.objectContaining({ revision: 2, control_date: '2027-03-26' })]);
  });

  describe('откат — компенсирующая ревизия', () => {
    const operationId = '77777777-7777-4777-8777-777777777777';
    const apply = async () => {
      const targets = await targetsFromDb();
      await inTransaction(client => correctPlannedZos(client, ACTOR, targets, { operationId }));
    };

    it('возвращает старые даты и премии, строки не удаляются', async () => {
      await apply();
      const plansBefore = (await counts()).plans;
      await inTransaction(async (client) => {
        const targets = await buildRevertTargets(client, operationId);
        return correctPlannedZos(client, ACTOR, targets, {
          operationId: '88888888-8888-4888-8888-888888888888',
          revertsOperationId: operationId,
        });
      });

      const contracts = await exec('SELECT id, to_char(planned_zos_date, \'YYYY-MM-DD\') AS d, version FROM object_contracts');
      for (const object of OBJECTS) {
        expect(contracts.find(row => row.id === object.contractId)).toMatchObject({ d: object.fromDate, version: '3' });
        expect(await premiums(object)).toEqual(BEFORE[object.manager.name]);
      }
      expect(await currentPlans(MARK)).toEqual(FIXED_MONTHS.map(month => expect.objectContaining({
        month, revision: 3, status: 'corrected', control_date: '2026-07-30', months_remaining: 1,
      })));
      expect((await counts()).plans).toBe(plansBefore + 12);
    });

    it('повторный откат и откат отката — отказ', async () => {
      await apply();
      const revertId = '99999999-9999-4999-8999-999999999999';
      await inTransaction(async client => correctPlannedZos(client, ACTOR, await buildRevertTargets(client, operationId), {
        operationId: revertId, revertsOperationId: operationId,
      }));
      await expect(inTransaction(client => buildRevertTargets(client, operationId))).rejects.toThrow(/уже откатывалась/);
      await expect(inTransaction(client => buildRevertTargets(client, revertId))).rejects.toThrow(/не исправление ЗОС/);
    });

    it('после новой правки договора — отказ без изменений', async () => {
      await apply();
      await inTransaction(client => updateContract(client, ACTOR, KING.contractId, 2, { notes: 'правка' }, 'правка'));
      const before = await counts();
      await expect(inTransaction(async client => correctPlannedZos(client, ACTOR, await buildRevertTargets(client, operationId), {
        operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', revertsOperationId: operationId,
      }))).rejects.toThrow(/версия договора 3, ожидалась 2/);
      expect(await counts()).toEqual(before);
    });

    it('после пересмотра месяца — отказ', async () => {
      await apply();
      await inTransaction(client => revisePlan(client, ACTOR, null, true, INJOY.id, '2026-10', { reason: 'Пересмотр' }));
      await expect(inTransaction(async client => correctPlannedZos(client, ACTOR, await buildRevertTargets(client, operationId), {
        operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', revertsOperationId: operationId,
      }))).rejects.toThrow(/текущие снимки/);
    });
  });

  describe('ответственный', () => {
    it('администратор — по почте без учёта регистра', async () => {
      await expect(inTransaction(client => resolveCorrectionActor(client, ' admin@example.TEST ')))
        .resolves.toEqual({ userId: ADMIN, userName: 'Админ Тестовый' });
    });

    it('не администратор, отключён, заблокирован, не найден — отказ', async () => {
      await expect(inTransaction(client => resolveCorrectionActor(client, 'user@example.test'))).rejects.toThrow(/нет роли администратора/);
      await expect(inTransaction(client => resolveCorrectionActor(client, 'nobody@example.test'))).rejects.toThrow(/не найдена/);
      await exec(`UPDATE app_auth.users SET banned_until = now() + interval '1 day' WHERE id = $1`, [ADMIN]);
      await expect(inTransaction(client => resolveCorrectionActor(client, 'admin@example.test'))).rejects.toThrow(/заблокирована/);
      await exec(`UPDATE app_auth.users SET banned_until = NULL, is_disabled = true WHERE id = $1`, [ADMIN]);
      await expect(inTransaction(client => resolveCorrectionActor(client, 'admin@example.test'))).rejects.toThrow(/отключена/);
    });
  });
});
