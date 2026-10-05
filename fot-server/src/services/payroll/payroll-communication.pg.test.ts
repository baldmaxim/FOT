import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// «Связь» в карточке зарплаты на настоящем PostgreSQL: JOIN номеров сотрудника с выпиской МТС,
// сумма за месяц, «нет SIM» / «нет данных», пополнения не в счёт, владелец — текущий.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы пересоздаются).
// В обычном прогоне пропускается.

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../../config/postgres.js', async () => {
  const { Pool, types } = await import('pg');
  // Как в config/postgres.ts: DATE — строкой YYYY-MM-DD, INT8 — числом.
  types.setTypeParser(1082, (val: string) => val);
  types.setTypeParser(20, (val: string) => Number.parseInt(val, 10));
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 5 }) : null;
  const pool = () => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool;
  };
  return {
    queryOne: async (sql: string, params?: readonly unknown[]) => (await pool().query(sql, params as unknown[])).rows[0] ?? null,
  };
});

import { getCommunicationExpense } from './payroll-communication.service.js';

describe.skipIf(!PG_URL)('«Связь» из МТС на PostgreSQL', () => {
  beforeAll(async () => {
    // Колонки, которые читает запрос; полные схемы — миграции 197 и 217.
    await pg.pool!.query(`
      DROP TABLE IF EXISTS mts_business_statement_rows, mts_business_number_map CASCADE;
      CREATE TABLE mts_business_number_map (
        msisdn_hash TEXT PRIMARY KEY,
        employee_id INTEGER
      );
      CREATE TABLE mts_business_statement_rows (
        msisdn_hash TEXT NOT NULL,
        usage_date  DATE NOT NULL,
        category    TEXT NOT NULL,
        amount      NUMERIC(14,2)
      );
      INSERT INTO mts_business_number_map (msisdn_hash, employee_id) VALUES
        ('sim-a', 1), ('sim-b', 1),  -- две SIM у сотрудника 1
        ('sim-c', 2),                -- SIM без строк в октябре
        ('sim-free', NULL);
      INSERT INTO mts_business_statement_rows (msisdn_hash, usage_date, category, amount) VALUES
        ('sim-a', '2026-10-01', 'calls',    10.00),
        ('sim-a', '2026-10-31', 'internet',  0.00),
        ('sim-a', '2026-10-15', 'topups', 500.00),   -- пополнение — не расход
        ('sim-a', '2026-09-30', 'periodic', 460.00), -- соседний месяц
        ('sim-a', '2026-11-01', 'calls',    99.00),
        ('sim-b', '2026-10-05', 'periodic', 460.00),
        ('sim-b', '2026-10-06', 'calls',    14.00),
        ('sim-c', '2026-09-10', 'periodic', 460.00);
    `);
  });

  afterAll(async () => {
    await pg.pool?.query('DROP TABLE IF EXISTS mts_business_statement_rows, mts_business_number_map CASCADE');
    await pg.pool?.end();
  });

  it('две SIM складываются, границы месяца включительно, пополнения не в счёт', async () => {
    expect(await getCommunicationExpense(1, '2026-10')).toEqual({ month: '2026-10', sims: 2, amount: '484.00' });
    expect(await getCommunicationExpense(1, '2026-09')).toEqual({ month: '2026-09', sims: 2, amount: '460.00' });
  });

  it('SIM без строк за месяц — «нет данных» (null), не 0', async () => {
    expect(await getCommunicationExpense(2, '2026-10')).toEqual({ month: '2026-10', sims: 1, amount: null });
    expect(await getCommunicationExpense(2, '2026-09')).toEqual({ month: '2026-09', sims: 1, amount: '460.00' });
  });

  it('нет SIM — sims 0', async () => {
    expect(await getCommunicationExpense(3, '2026-10')).toEqual({ month: '2026-10', sims: 0, amount: null });
  });

  it('после перепривязки номера весь месяц — новому владельцу', async () => {
    await pg.pool!.query(`UPDATE mts_business_number_map SET employee_id = 3 WHERE msisdn_hash = 'sim-b'`);

    expect(await getCommunicationExpense(3, '2026-10')).toEqual({ month: '2026-10', sims: 1, amount: '474.00' });
    expect(await getCommunicationExpense(1, '2026-10')).toEqual({ month: '2026-10', sims: 1, amount: '10.00' });
  });
});
