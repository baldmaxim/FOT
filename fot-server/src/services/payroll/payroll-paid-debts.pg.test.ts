import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Долги прошлых месяцев (миграция 332) на настоящем PostgreSQL: повторный запуск, CHECK кода, знака и первого числа,
// CASCADE при удалении сотрудника, выборка по периоду.
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
  return { query: async (sql: string, params?: readonly unknown[]) => (await pool().query(sql, params as unknown[])).rows };
});

import { getPaidDebts, PAYROLL_PAID_DEBT_CODES } from './payroll-paid-debts.service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../docs/migrations/', import.meta.url));
const MIGRATION = readFileSync(`${MIGRATIONS_DIR}332_payroll_paid_debts.sql`, 'utf8');

/** Строки вносит скрипт из ведомостей — в тесте прямой вставкой: [месяц YYYY-MM-DD, код, сумма]. */
const insert = (employeeId: number, rows: Array<[string, string, number]>) => pg.pool!.query(
  `INSERT INTO payroll_paid_debts (employee_id, month, line_code, amount)
   SELECT $1, r.month::date, r.code, r.amount
     FROM unnest($2::text[], $3::text[], $4::numeric[]) AS r(month, code, amount)`,
  [employeeId, rows.map(row => row[0]), rows.map(row => row[1]), rows.map(row => row[2])],
);

describe.skipIf(!PG_URL)('Долги прошлых месяцев на PostgreSQL', () => {
  beforeAll(async () => {
    await pg.pool!.query(`
      DROP TABLE IF EXISTS payroll_paid_debts, employees CASCADE;
      CREATE TABLE employees (id integer PRIMARY KEY, full_name text);
      INSERT INTO employees (id, full_name) VALUES (1, 'Зиякулов К.Э.'), (2, 'Бобоназаров Н.М.');
    `);
    await pg.pool!.query(MIGRATION);
    // Повторный запуск безопасен.
    await pg.pool!.query(MIGRATION);
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('все коды каталога сервера вставляются; выборка по периоду — NUMERIC строкой, по месяцу и коду', async () => {
    await insert(1, PAYROLL_PAID_DEBT_CODES.map(code => ['2026-06-01', code, 1] as [string, string, number]));
    await insert(1, [['2026-05-01', 'debt_day_salary', 4141.9], ['2026-09-01', 'debt_tmc', 5]]);

    const june = await getPaidDebts(1, '2026-06', '2026-06');
    expect(june.map(row => row.line).sort()).toEqual([...PAYROLL_PAID_DEBT_CODES].sort());
    expect(await getPaidDebts(1, '2026-05', '2026-05')).toEqual([{ month: '2026-05', line: 'debt_day_salary', amount: '4141.90' }]);
    expect((await getPaidDebts(1, '2026-05', '2026-08')).map(row => row.month)).not.toContain('2026-09');
    expect(await getPaidDebts(2, '2026-01', '2026-12')).toEqual([]);
  });

  it('CHECK: чужой код, ноль и минус, не первое число — отказ', async () => {
    await expect(insert(2, [['2026-06-01', 'advance', 1]])).rejects.toThrow(/payroll_paid_debts_line_code/);
    await expect(insert(2, [['2026-06-01', 'debt_tmc', 0]])).rejects.toThrow(/payroll_paid_debts_amount_positive/);
    await expect(insert(2, [['2026-06-01', 'debt_tmc', -1]])).rejects.toThrow(/payroll_paid_debts_amount_positive/);
    await expect(insert(2, [['2026-06-15', 'debt_tmc', 1]])).rejects.toThrow(/payroll_paid_debts_month_first_day/);
  });

  it('удаление сотрудника удаляет его строки (CASCADE)', async () => {
    await insert(2, [['2026-06-01', 'debt_tmc', 8000]]);
    await pg.pool!.query('DELETE FROM employees WHERE id = 2');
    expect(await getPaidDebts(2, '2026-01', '2026-12')).toEqual([]);
  });
});
