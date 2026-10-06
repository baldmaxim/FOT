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

import { withTransaction } from '../../config/postgres.js';
import { getPaidAmounts, savePaidAmounts, type IPayrollPaidCell } from './payroll-paid.service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../docs/migrations/', import.meta.url));
const migration = (name: string): string => readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf8');

const AUTHOR = '00000000-0000-0000-0000-00000000000b';
const OTHER_AUTHOR = '00000000-0000-0000-0000-00000000000c';

const save = (employeeId: number, cells: IPayrollPaidCell[], updatedBy = AUTHOR): Promise<number> =>
  withTransaction(client => savePaidAmounts(client, { employeeId, cells, updatedBy }));

const rows = async (employeeId: number) => (await pg.pool!.query(
  `SELECT month, item_code, amount::text AS amount, updated_by
     FROM payroll_paid_amounts WHERE employee_id = $1 ORDER BY month, item_code`,
  [employeeId],
)).rows;

describe.skipIf(!PG_URL)('«Оплачено» на PostgreSQL', () => {
  beforeAll(async () => {
    await pg.pool!.query(`
      DROP TABLE IF EXISTS payroll_paid_amounts, user_profiles, employees CASCADE;
      CREATE TABLE employees (id integer PRIMARY KEY, full_name text);
      CREATE TABLE user_profiles (id uuid PRIMARY KEY, full_name text);
      INSERT INTO employees (id, full_name) VALUES (1, 'Акимов С.Ю.'), (2, 'Борисов А.А.'), (3, 'Абдужабборов О.А.');
      INSERT INTO user_profiles (id, full_name) VALUES
        ('${AUTHOR}', 'Петрова А.А.'), ('${OTHER_AUTHOR}', 'Сидорова Б.Б.');
    `);
    await pg.pool!.query(migration('295_payroll_paid_amounts.sql'));
    await pg.pool!.query(migration('297_payroll_paid_groups.sql'));
    await pg.pool!.query(migration('298_payroll_paid_drop_payouts.sql'));
    // Повторный запуск безопасен.
    await pg.pool!.query(migration('295_payroll_paid_amounts.sql'));
    await pg.pool!.query(migration('297_payroll_paid_groups.sql'));
    await pg.pool!.query(migration('298_payroll_paid_drop_payouts.sql'));
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('вставляет, заменяет и не перезаписывает неизменённую сумму', async () => {
    expect(await save(1, [
      { month: '2026-08', item: 'contract', amount: 175000 },
      { month: '2026-08', item: 'travel', amount: 2730.5 },
    ])).toBe(2);

    // contract — тот же, travel — новый: меняется одна ячейка, автор contract прежний.
    expect(await save(1, [
      { month: '2026-08', item: 'contract', amount: 175000 },
      { month: '2026-08', item: 'travel', amount: 2730 },
    ], OTHER_AUTHOR)).toBe(1);

    expect(await rows(1)).toEqual([
      { month: '2026-08-01', item_code: 'contract', amount: '175000.00', updated_by: AUTHOR },
      { month: '2026-08-01', item_code: 'travel', amount: '2730.00', updated_by: OTHER_AUTHOR },
    ]);
  });

  it('очистка удаляет строку; очистка пустой ячейки ничего не меняет', async () => {
    expect(await save(1, [{ month: '2026-08', item: 'travel', amount: null }])).toBe(1);
    expect(await save(1, [{ month: '2026-08', item: 'travel', amount: null }])).toBe(0);
    expect((await rows(1)).map(row => row.item_code)).toEqual(['contract']);
  });

  it('минус — только у перерасчёта; ошибка откатывает всю правку', async () => {
    expect(await save(2, [{ month: '2026-07', item: 'recalc_prev', amount: -1500 }])).toBe(1);

    await expect(save(2, [
      { month: '2026-07', item: 'contract', amount: 100000 },
      { month: '2026-07', item: 'vacation', amount: -1 },
    ])).rejects.toThrow(/payroll_paid_amount_sign/);
    expect((await rows(2)).map(row => row.item_code)).toEqual(['recalc_prev']);
  });

  it('статьи удержаний (297) принимаются, чужой код и минус — нет', async () => {
    expect(await save(3, [
      { month: '2026-07', item: 'housing', amount: 160 },
      { month: '2026-07', item: 'meals', amount: 5248 },
      { month: '2026-07', item: 'writ_deduction', amount: 1000 },
    ])).toBe(3);

    await expect(pg.pool!.query(
      `INSERT INTO payroll_paid_amounts (employee_id, month, item_code, amount) VALUES (3, '2026-07-01', 'kpi', 1)`,
    )).rejects.toThrow(/payroll_paid_item_code/);
    await expect(save(3, [{ month: '2026-07', item: 'fines', amount: -1 }])).rejects.toThrow(/payroll_paid_amount_sign/);
  });

  it('298: суммы «Выплачено» и «Моб. телефон» удалены, остальные — на месте; новые не вставить', async () => {
    // CHECK 297 — чтобы вставить строки, которые были на проде до 298.
    await pg.pool!.query(migration('297_payroll_paid_groups.sql'));
    await pg.pool!.query(`
      INSERT INTO payroll_paid_amounts (employee_id, month, item_code, amount) VALUES
        (1, '2026-05-01', 'contract',      68095),
        (1, '2026-05-01', 'meals',          5248),
        (1, '2026-05-01', 'fss',            1000),
        (1, '2026-05-01', 'advance',       13464.19),
        (1, '2026-05-01', 'bank_transfer', 56155.17),
        (1, '2026-05-01', 'bonus_payout',  39903),
        (1, '2026-05-01', 'mobile',          610)
    `);
    await pg.pool!.query(migration('298_payroll_paid_drop_payouts.sql'));

    const left = await pg.pool!.query<{ item_code: string }>(
      `SELECT item_code FROM payroll_paid_amounts WHERE employee_id = 1 AND month = '2026-05-01' ORDER BY item_code`,
    );
    expect(left.rows.map(row => row.item_code)).toEqual(['contract', 'meals']);
    await expect(pg.pool!.query(
      `INSERT INTO payroll_paid_amounts (employee_id, month, item_code, amount) VALUES (1, '2026-05-01', 'advance', 1)`,
    )).rejects.toThrow(/payroll_paid_item_code/);
    await pg.pool!.query(`DELETE FROM payroll_paid_amounts WHERE employee_id = 1 AND month = '2026-05-01'`);
  });

  it('месяц — только первое число', async () => {
    await expect(pg.pool!.query(
      `INSERT INTO payroll_paid_amounts (employee_id, month, item_code, amount) VALUES (2, '2026-07-15', 'loan', 1)`,
    )).rejects.toThrow(/payroll_paid_month_first_day/);
  });

  it('выборка — месяцы периода включительно, суммы текстом', async () => {
    await save(1, [
      { month: '2026-03', item: 'bonus', amount: 1 },
      { month: '2026-04', item: 'bonus', amount: 2 },
      { month: '2026-09', item: 'bonus', amount: 3 },
      { month: '2026-10', item: 'bonus', amount: 4 },
    ]);

    expect(await getPaidAmounts(1, '2026-04', '2026-09')).toEqual([
      { month: '2026-04', item: 'bonus', amount: '2.00' },
      { month: '2026-08', item: 'contract', amount: '175000.00' },
      { month: '2026-09', item: 'bonus', amount: '3.00' },
    ]);
  });
});
