import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

// Отчёт и прогноз KPI объектов на настоящем PostgreSQL: остаток, план и рекурсия прогноза
// живут внутри SQL, мок драйвера показал бы ровно то, что ему подложили. Запускается только
// при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД. Таблицы создаются в своей схеме
// kpi_report_pg_test (search_path), чтобы не задеть заглушки соседних pg-тестов.
// В обычном прогоне пропускается.

const PG_URL = process.env.FOT_TEST_PG_URL;
const SCHEMA = 'kpi_report_pg_test';

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../config/postgres.js', async () => {
  const { Pool } = await import('pg');
  pg.pool = process.env.FOT_TEST_PG_URL
    ? new Pool({
      connectionString: process.env.FOT_TEST_PG_URL,
      options: '-c search_path=kpi_report_pg_test',
      max: 4,
    })
    : null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool.query(sql, params as unknown[]);
  };
  return {
    query: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows[0] ?? null,
    execute: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rowCount ?? 0,
    withTransaction: vi.fn(),
  };
});

import { OBJECT_KPI_REPORT_SQL, type ObjectKpiReportRow } from './object-kpi-report.service.js';
import { fetchObjectKpiForecast } from './object-kpi-forecast.service.js';

const ALIA = '00000000-0000-0000-0000-00000000a11a';
const ALIA_CONTRACT = '00000000-0000-0000-0000-0000000c011a';
const WAVE = '00000000-0000-0000-0000-00000000aa0e';
const WAVE_CONTRACT = '00000000-0000-0000-0000-0000000c0aa0';

const exec = async (sql: string, params?: unknown[]) => {
  await pg.pool!.query(sql, params);
};

const report = async (from: string, to: string, objectId: string) =>
  (await pg.pool!.query<ObjectKpiReportRow>(OBJECT_KPI_REPORT_SQL, [from, to, [objectId]])).rows;

const byMonth = (rows: ObjectKpiReportRow[], month: string) => {
  const row = rows.find((item) => item.period_month === month);
  if (!row) throw new Error(`нет строки ${month}`);
  return row;
};

/** Денежная строка numeric → копейки: сверка тождеств без плавающей точки. */
const cents = (value: string | null): number => Math.round(Number(value) * 100);

const addKs2 = (objectId: string, amount: string, signed: string, status = 'signed') =>
  exec(
    `INSERT INTO object_ks2_entries (skud_object_id, amount, customer_signed_date, status)
     VALUES ($1, $2, $3, $4)`,
    [objectId, amount, signed, status],
  );

/** Снимок месяца ЖК Alia в том виде, в каком его зафиксировали 21.08 и 23.09. */
const fixAliaMonth = (month: string, remainder: string, months: number, plan: string) =>
  exec(
    `INSERT INTO object_kpi_month_plans (
       skud_object_id, period_month, status, contract_total, ks2_cumulative_before, remainder,
       planned_zos_date_used, control_date, months_remaining, calculated_plan_amount)
     VALUES ($1, $2, 'fixed', 15614052545.96, 15614052545.96 - $3::numeric, $3,
             '2027-12-27', '2028-03-27', $4, $5)`,
    [ALIA, month, remainder, months, plan],
  );

describe.skipIf(!PG_URL)('отчёт и прогноз KPI объектов на PostgreSQL', () => {
  beforeAll(async () => {
    await exec(`
      DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
      CREATE SCHEMA ${SCHEMA};
      CREATE TABLE ${SCHEMA}.skud_objects (
        id uuid PRIMARY KEY, name text NOT NULL, is_active boolean NOT NULL DEFAULT true
      );
      CREATE TABLE ${SCHEMA}.object_contracts (
        id uuid PRIMARY KEY, skud_object_id uuid NOT NULL, is_active boolean NOT NULL DEFAULT true,
        contract_number text, customer_name text, contract_date date,
        base_amount numeric(15,2), planned_zos_date date, actual_zos_date date,
        plan_start_month date, opening_remainder numeric(15,2), planned_headcount integer
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
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), skud_object_id uuid NOT NULL,
        period_month date NOT NULL, revision integer NOT NULL DEFAULT 1,
        is_current boolean NOT NULL DEFAULT true, status text NOT NULL,
        contract_total numeric(15,2), ks2_cumulative_before numeric(15,2), remainder numeric(15,2),
        planned_zos_date_used date, control_date date, months_remaining integer,
        calculated_plan_amount numeric(15,2), override_plan_amount numeric(15,2),
        plan_amount numeric(15,2) GENERATED ALWAYS AS (COALESCE(override_plan_amount, calculated_plan_amount)) STORED
      );
      CREATE TABLE ${SCHEMA}.object_kpi_assignments (
        skud_object_id uuid NOT NULL, employee_id integer NOT NULL, role_kind text NOT NULL,
        valid_from date NOT NULL, valid_to date
      );
      CREATE TABLE ${SCHEMA}.employees (id integer PRIMARY KEY, full_name text);
    `);
  });

  // Каждый тест стартует с ЖК Alia в состоянии прода на 24.09.2026 и «Wave» с истёкшей
  // контрольной датой. Текущий месяц во всех прогнозах — сентябрь 2026.
  beforeEach(async () => {
    await exec(`
      TRUNCATE skud_objects, object_contracts, object_contract_addenda, object_ks2_entries,
               object_kpi_month_plans, object_kpi_assignments, employees;
      INSERT INTO employees VALUES (1, 'Руин Артём Владимирович');
      INSERT INTO skud_objects (id, name) VALUES ('${ALIA}', 'ЖК Alia'), ('${WAVE}', 'ЖК Wave');
      INSERT INTO object_kpi_assignments VALUES ('${ALIA}', 1, 'construction_manager', '2025-02-07', NULL);
      INSERT INTO object_contracts (id, skud_object_id, base_amount, planned_zos_date, plan_start_month, opening_remainder)
      VALUES ('${ALIA_CONTRACT}', '${ALIA}', 15614052545.96, '2027-12-27', '2026-07-01', 10151817891.49),
             ('${WAVE_CONTRACT}', '${WAVE}', 1000000000.00, '2026-03-30', '2026-07-01', 900000000.00);
    `);
    await addKs2(ALIA, '357631118.91', '2026-07-31', 'cancelled');
    await addKs2(ALIA, '503287967.98', '2026-07-31');
    await addKs2(ALIA, '463531944.04', '2026-08-31');
    // Снимки сняты со старыми данными — как на проде.
    await fixAliaMonth('2026-07-01', '9901072696.16', 21, '471479652.20');
    await fixAliaMonth('2026-08-01', '9543441577.25', 20, '477172078.86');
    await fixAliaMonth('2026-09-01', '9901072696.16', 19, '521109089.27');
  });

  afterAll(async () => {
    await pg.pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pg.pool?.end();
  });

  it('ЖК Alia: зафиксированные месяцы считаются по текущим актам и ручному остатку', async () => {
    const rows = await report('2026-07-01', '2026-09-01', ALIA);

    const july = byMonth(rows, '2026-07-01');
    expect(july).toMatchObject({
      ks2_cumulative_before: '5462234654.47',
      remainder: '10151817891.49',
      months_remaining: 21,
      plan_amount: '483419899.59',
      fact_amount: '503287967.98',
      completion_pct: '104.11',
      report_status: 'fixed',
      data_quality: 'ok',
    });
    expect(byMonth(rows, '2026-08-01')).toMatchObject({
      ks2_cumulative_before: '5965522622.45',
      remainder: '9648529923.51',
      months_remaining: 20,
      plan_amount: '482426496.18',
      completion_pct: '96.08',
    });
    expect(byMonth(rows, '2026-09-01')).toMatchObject({
      ks2_cumulative_before: '6429054566.49',
      remainder: '9184997979.47',
      months_remaining: 19,
      plan_amount: '483420946.29',
      completion_pct: '0.00',
    });

    // «Договор − КС-6 = Остаток» и «План = Остаток ÷ Мес.» в каждой строке.
    for (const row of rows) {
      expect(cents(row.contract_total) - cents(row.ks2_cumulative_before)).toBe(cents(row.remainder));
      expect(cents(row.plan_amount)).toBe(Math.round(cents(row.remainder) / row.months_remaining!));
    }
  });

  it('перенос ЗОС после фиксации: закрытый месяц держит число месяцев, прогноз идёт по новой дате', async () => {
    await exec(`UPDATE object_contracts SET planned_zos_date = '2028-06-30' WHERE id = $1`, [ALIA_CONTRACT]);

    const rows = await report('2026-09-01', '2026-10-01', ALIA);
    // П. 6.3: сентябрь зафиксирован — 19 месяцев и контрольная дата из снимка.
    expect(byMonth(rows, '2026-09-01')).toMatchObject({ months_remaining: 19, control_date: '2028-03-27' });
    // Октябрь открыт — новая ЗОС: контроль 30.09.2028, 24 месяца.
    expect(byMonth(rows, '2026-10-01')).toMatchObject({ months_remaining: 24, control_date: '2028-09-30' });

    const forecast = await fetchObjectKpiForecast(ALIA, '2026-09');
    expect(forecast).toHaveLength(24);
    expect(forecast[0]).toMatchObject({
      period_month: '2026-10-01',
      months_remaining: 24,
      remainder: '8701577033.18',
      plan_amount: '362565709.72',
    });
    expect(forecast.at(-1)).toMatchObject({ period_month: '2028-09-01', months_remaining: 1 });
  });

  it('очищенная плановая ЗОС не делает закрытый месяц неполным', async () => {
    await exec(`UPDATE object_contracts SET planned_zos_date = NULL WHERE id = $1`, [ALIA_CONTRACT]);

    const rows = await report('2026-07-01', '2026-10-01', ALIA);
    expect(byMonth(rows, '2026-07-01')).toMatchObject({
      data_quality: 'ok',
      report_status: 'fixed',
      planned_zos_date_used: '2027-12-27',
      plan_amount: '483419899.59',
    });
    // Открытый месяц без ЗОС — по-прежнему «нет данных».
    expect(byMonth(rows, '2026-10-01')).toMatchObject({
      data_quality: 'no_planned_zos_date',
      report_status: 'data_incomplete',
      plan_amount: null,
    });
  });

  it('ручной план подменяет сумму и в закрытом, и в открытом месяце', async () => {
    await exec(
      `UPDATE object_kpi_month_plans SET override_plan_amount = 400000000 WHERE period_month = '2026-07-01'`,
    );
    await exec(
      `INSERT INTO object_kpi_month_plans (skud_object_id, period_month, status, override_plan_amount)
       VALUES ($1, '2026-10-01', 'open', 100000000)`,
      [ALIA],
    );

    const rows = await report('2026-07-01', '2026-10-01', ALIA);
    expect(byMonth(rows, '2026-07-01')).toMatchObject({
      plan_amount: '400000000.00',
      plan_amount_calc: '483419899.59',
      plan_overridden: true,
      completion_pct: '125.82',
      remainder: '10151817891.49',
    });
    expect(byMonth(rows, '2026-10-01')).toMatchObject({
      plan_amount: '100000000.00',
      plan_overridden: true,
      report_status: 'open',
    });
  });

  it('прогноз ЖК Alia: план 100 % до марта 2028, остаток закрывается в ноль', async () => {
    const forecast = await fetchObjectKpiForecast(ALIA, '2026-09');

    expect(forecast).toHaveLength(18);
    expect(forecast[0]).toMatchObject({
      period_month: '2026-10-01',
      is_forecast: true,
      ks2_cumulative_before: '6912475512.78',
      remainder: '8701577033.18',
      months_remaining: 18,
      plan_amount: '483420946.29',
      fact_amount: '483420946.29',
      completion_pct: '100.00',
      primary_manager_name: 'Руин Артём Владимирович',
    });
    const last = forecast.at(-1)!;
    expect(last).toMatchObject({ period_month: '2028-03-01', months_remaining: 1 });
    expect(cents(last.plan_amount)).toBe(cents(last.remainder));

    // Весь остаток на начало октября раскладывается по месяцам без потерь копеек.
    const total = forecast.reduce((sum, row) => sum + cents(row.plan_amount), 0);
    expect(total).toBe(cents('8701577033.18'));
    for (const row of forecast) {
      expect(cents(row.contract_total) - cents(row.ks2_cumulative_before)).toBe(cents(row.remainder));
    }
  });

  it('акт текущего месяца сразу пересчитывает прогноз — больше он плана или меньше', async () => {
    await addKs2(ALIA, '500000000.00', '2026-09-20');
    const above = await fetchObjectKpiForecast(ALIA, '2026-09');
    expect(above[0]).toMatchObject({ remainder: '8684997979.47', plan_amount: '482499887.75' });

    await exec(`UPDATE object_ks2_entries SET amount = 300000000 WHERE customer_signed_date = '2026-09-20'`);
    const below = await fetchObjectKpiForecast(ALIA, '2026-09');
    expect(below[0]).toMatchObject({ remainder: '8884997979.47', plan_amount: '493610998.86' });
  });

  it('договор закрыт — прогнозных строк нет', async () => {
    await addKs2(ALIA, '9184997979.47', '2026-09-20');
    expect(await fetchObjectKpiForecast(ALIA, '2026-09')).toEqual([]);
  });

  it('ЗОС получен в текущем месяце — следующего месяца в прогнозе нет', async () => {
    await exec(`UPDATE object_contracts SET actual_zos_date = '2026-09-15' WHERE id = $1`, [ALIA_CONTRACT]);
    expect(await fetchObjectKpiForecast(ALIA, '2026-09')).toEqual([]);
  });

  it('расчёт начинается со следующего месяца — прогноза от текущего нет', async () => {
    await exec(`DELETE FROM object_kpi_month_plans`);
    await exec(`UPDATE object_contracts SET plan_start_month = '2026-10-01' WHERE id = $1`, [ALIA_CONTRACT]);
    expect(await report('2026-09-01', '2026-09-01', ALIA)).toEqual([]);
    expect(await fetchObjectKpiForecast(ALIA, '2026-09')).toEqual([]);
  });

  it('контрольная дата прошла: без актов договор закрывается в текущем месяце', async () => {
    // П. 2.7: мес. = 1, план сентября — весь остаток; при 100 % на октябрь ничего не остаётся.
    const september = byMonth(await report('2026-09-01', '2026-09-01', WAVE), '2026-09-01');
    expect(september).toMatchObject({ months_remaining: 1, plan_amount: '900000000.00', is_overdue: true });
    expect(await fetchObjectKpiForecast(WAVE, '2026-09')).toEqual([]);
  });

  it('контрольная дата прошла: акт меньше остатка даёт одну строку с полным остатком', async () => {
    await addKs2(WAVE, '100000000.00', '2026-09-10');
    const forecast = await fetchObjectKpiForecast(WAVE, '2026-09');
    expect(forecast).toHaveLength(1);
    expect(forecast[0]).toMatchObject({
      period_month: '2026-10-01',
      months_remaining: 1,
      remainder: '800000000.00',
      plan_amount: '800000000.00',
    });
  });
});
