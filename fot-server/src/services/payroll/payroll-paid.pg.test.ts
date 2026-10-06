import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// «Оплачено» на настоящем PostgreSQL (миграции 295, 297): вставка, замена, неизменённая сумма,
// очистка, CHECK статьи, минуса и первого числа, выборка по периоду.
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
    query: async (sql: string, params?: readonly unknown[]) => (await pool().query(sql, params as unknown[])).rows,
    withTransaction: async <T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> => {
      const client = await pool().connect();
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

import { getPaidAmounts } from './payroll-paid.service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../docs/migrations/', import.meta.url));
const migration = (name: string): string => readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf8');

const AUTHOR = '00000000-0000-0000-0000-00000000000b';

/** Суммы вносит 1С (API или выгрузка) — в тесте прямой вставкой: [месяц YYYY-MM, статья, сумма]. */
const insert = (employeeId: number, cells: Array<[string, string, number]>) => pg.pool!.query(
  `INSERT INTO payroll_paid_amounts (employee_id, month, item_code, amount)
   SELECT $1, (c.month || '-01')::date, c.item, c.amount
     FROM unnest($2::text[], $3::text[], $4::numeric[]) AS c(month, item, amount)`,
  [employeeId, cells.map(cell => cell[0]), cells.map(cell => cell[1]), cells.map(cell => cell[2])],
);

const MIGRATIONS = [
  '295_payroll_paid_amounts.sql',
  '297_payroll_paid_groups.sql',
  '298_payroll_paid_drop_payouts.sql',
  '299_payroll_deduction_kinds.sql',
  '300_payroll_employee_deductions.sql',
  '301_payroll_paid_order_kinds.sql',
];

describe.skipIf(!PG_URL)('«Оплачено» на PostgreSQL', () => {
  beforeAll(async () => {
    await pg.pool!.query(`
      DROP TABLE IF EXISTS payroll_paid_amounts, payroll_employee_deductions, payroll_deduction_kinds,
        payroll_compensation_terms, user_profiles, employees CASCADE;
      CREATE TABLE employees (id integer PRIMARY KEY, full_name text);
      CREATE TABLE user_profiles (id uuid PRIMARY KEY, full_name text);
      -- Заготовка условий оплаты: миграциям 299–301 нужны только эти колонки.
      CREATE TABLE payroll_compensation_terms (id serial PRIMARY KEY, deduction_amount numeric(12,2));
      INSERT INTO employees (id, full_name) VALUES (1, 'Акимов С.Ю.'), (2, 'Борисов А.А.'), (3, 'Абдужабборов О.А.');
      INSERT INTO user_profiles (id, full_name) VALUES ('${AUTHOR}', 'Петрова А.А.');
    `);
    for (const name of MIGRATIONS) await pg.pool!.query(migration(name));
    // Повторный запуск безопасен.
    for (const name of MIGRATIONS) await pg.pool!.query(migration(name));
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  // Первым: CHECK 297 ставится на таблицу без статей, появившихся в 301.
  it('298: суммы «Выплачено» и «Моб. телефон» удалены, остальные — на месте; новые не вставить', async () => {
    // CHECK 297 — чтобы вставить строки, которые были на проде до 298.
    await pg.pool!.query(migration('297_payroll_paid_groups.sql'));
    await insert(1, [
      ['2026-05', 'contract', 68095],
      ['2026-05', 'meals', 5248],
      ['2026-05', 'fss', 1000],
      ['2026-05', 'advance', 13464.19],
      ['2026-05', 'bank_transfer', 56155.17],
      ['2026-05', 'bonus_payout', 39903],
      ['2026-05', 'mobile', 610],
    ]);
    await pg.pool!.query(migration('298_payroll_paid_drop_payouts.sql'));
    // Состав статей — снова как после 301.
    await pg.pool!.query(migration('301_payroll_paid_order_kinds.sql'));

    const left = await pg.pool!.query<{ item_code: string }>(
      `SELECT item_code FROM payroll_paid_amounts WHERE employee_id = 1 AND month = '2026-05-01' ORDER BY item_code`,
    );
    expect(left.rows.map(row => row.item_code)).toEqual(['contract', 'meals']);
    await expect(insert(1, [['2026-05', 'advance', 1]])).rejects.toThrow(/payroll_paid_item_code/);
    await pg.pool!.query(`DELETE FROM payroll_paid_amounts WHERE employee_id = 1 AND month = '2026-05-01'`);
  });

  it('301: статьи в новом составе — плановая доплата есть, удалённые и чужие коды — нет', async () => {
    await insert(3, [
      ['2026-07', 'vacation', 59245],
      ['2026-07', 'housing', 160],
      ['2026-07', 'supplement', 5000],
      ['2026-07', 'planned_supplement', 10000],
      ['2026-07', 'meals', 5248],
      ['2026-07', 'writ_deduction', 1000],
    ]);
    for (const code of ['kpi', 'advance', 'mobile']) {
      await expect(insert(3, [['2026-06', code, 1]])).rejects.toThrow(/payroll_paid_item_code/);
    }
  });

  it('301: удержания «Оплачено» — в справочнике видов, без дублей; вид в условиях оплаты удалён', async () => {
    const kinds = await pg.pool!.query<{ name: string }>(`SELECT name FROM payroll_deduction_kinds ORDER BY sort_order, id`);
    expect(kinds.rows.map(row => row.name)).toEqual([
      'Корректировка удержаний', 'ТМЦ', 'Штраф за мусор', 'Спецодежда', 'Питание', 'Штрафы',
      'Нарушение техники безопасности', 'Удержание по исп. листу',
    ]);
    const column = await pg.pool!.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'payroll_compensation_terms' AND column_name = 'deduction_kind_id'`,
    );
    expect(column.rowCount).toBe(0);
  });

  it('минус — только у перерасчёта', async () => {
    await insert(2, [['2026-07', 'recalc_prev', -1500]]);
    await expect(insert(2, [['2026-07', 'vacation', -1]])).rejects.toThrow(/payroll_paid_amount_sign/);
    await expect(insert(2, [['2026-07', 'fines', -1]])).rejects.toThrow(/payroll_paid_amount_sign/);
  });

  it('месяц — только первое число', async () => {
    await expect(pg.pool!.query(
      `INSERT INTO payroll_paid_amounts (employee_id, month, item_code, amount) VALUES (2, '2026-07-15', 'loan', 1)`,
    )).rejects.toThrow(/payroll_paid_month_first_day/);
  });

  it('выборка — месяцы периода включительно, суммы текстом', async () => {
    await insert(1, [
      ['2026-03', 'bonus', 1],
      ['2026-04', 'bonus', 2],
      ['2026-08', 'contract', 175000],
      ['2026-09', 'bonus', 3],
      ['2026-10', 'bonus', 4],
    ]);

    expect(await getPaidAmounts(1, '2026-04', '2026-09')).toEqual([
      { month: '2026-04', item: 'bonus', amount: '2.00' },
      { month: '2026-08', item: 'contract', amount: '175000.00' },
      { month: '2026-09', item: 'bonus', amount: '3.00' },
    ]);
  });
});
