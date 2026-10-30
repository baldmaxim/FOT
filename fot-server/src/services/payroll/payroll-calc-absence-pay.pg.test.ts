import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Отпускные и больничные из 1С для расчёта ФОТ на настоящем PostgreSQL: статьи «Оплачено» и ведомости выплаты
// месяца начисления (по документу). Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы-заглушки
// пересоздаются).

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../../config/postgres.js', async () => {
  const { Pool } = await import('pg');
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 2 }) : null;
  return {
    getPool: () => pg.pool,
    query: async (sql: string, params?: readonly unknown[]) => {
      if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
      return (await pg.pool.query(sql, params as unknown[])).rows;
    },
    queryOne: vi.fn(),
    execute: vi.fn(),
    withTransaction: vi.fn(),
  };
});

import { loadAbsencePay1c } from './payroll-calc.service.js';

const q = async (sql: string, params?: unknown[]) => (await pg.pool!.query(sql, params)).rows;

/** Ведомость с одной или несколькими строками: [сотрудник | null, сумма]. */
const payout = async (
  docNumber: string,
  docDate: string,
  periodMonth: string,
  method: string,
  lines: Array<[number | null, string]>,
): Promise<void> => {
  const [doc] = await q(
    `INSERT INTO payroll_1c_payout_documents (doc_number, doc_date, period_month, payment_method)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [docNumber, docDate, periodMonth, method],
  );
  for (const [index, [employeeId, amount]] of lines.entries()) {
    await q(
      'INSERT INTO payroll_1c_payout_lines (document_id, line_no, employee_id, amount) VALUES ($1, $2, $3, $4)',
      [doc.id, index + 1, employeeId, amount],
    );
  }
};

describe.skipIf(!PG_URL)('отпускные и больничные из 1С на PostgreSQL', () => {
  beforeAll(async () => {
    await q('DROP TABLE IF EXISTS payroll_1c_payout_lines, payroll_1c_payout_documents, payroll_paid_amounts CASCADE');
    await q(`CREATE TABLE payroll_paid_amounts (
               employee_id int NOT NULL, month date NOT NULL, item_code text NOT NULL, amount numeric(12,2) NOT NULL,
               PRIMARY KEY (employee_id, month, item_code))`);
    await q(`CREATE TABLE payroll_1c_payout_documents (
               id bigserial PRIMARY KEY, doc_number text NOT NULL, doc_date date NOT NULL, period_month date NOT NULL,
               payment_method text NOT NULL)`);
    await q(`CREATE TABLE payroll_1c_payout_lines (
               document_id bigint NOT NULL REFERENCES payroll_1c_payout_documents(id), line_no int NOT NULL,
               amount numeric(12,2) NOT NULL, employee_id int, PRIMARY KEY (document_id, line_no))`);

    // Гринёв (477): отпуск по ведомости, две строки в одном документе + второй документ с тем же номером.
    await payout('0000-002319', '2026-09-02', '2026-09-01', 'Отпуска', [[477, '59000.00'], [477, '709.13'], [null, '100.00']]);
    await payout('0000-002319', '2026-09-20', '2026-09-01', 'Отпуска', [[477, '1000.50']]);
    // Не попадают: другой способ, другой месяц начисления, сотрудник вне списка.
    await payout('0000-002520', '2026-10-12', '2026-09-01', 'Аванс', [[477, '31636.64']]);
    await payout('0000-002100', '2026-08-05', '2026-08-01', 'Отпуска', [[477, '5000.00']]);
    await payout('0000-002321', '2026-09-03', '2026-09-01', 'Отпуска', [[500, '7000.00']]);
    // Лепский (999): «Оплачено» 0 по отпуску и ведомость — обе приходят, выбор в правилах; больничный — ведомостью.
    await q(`INSERT INTO payroll_paid_amounts (employee_id, month, item_code, amount) VALUES
               (999, '2026-09-01', 'vacation', 0), (999, '2026-09-01', 'contract', 100000),
               (999, '2026-08-01', 'sick_leave', 3000)`);
    await payout('0000-002330', '2026-09-04', '2026-09-01', 'Отпуска', [[999, '12000.00']]);
    await payout('0000-002400', '2026-09-25', '2026-09-01', 'Больничные листы', [[999, '1740.00']]);
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('ведомости месяца — по документу, сумма строк сотрудника; чужие способ, месяц и сотрудник не попадают', async () => {
    const result = await loadAbsencePay1c([477, 999], '2026-09');

    expect(result.get(477)).toEqual([{
      code: 'vacation',
      paid: null,
      payouts: [
        { doc_number: '0000-002319', doc_date: '2026-09-02', amount: '59709.13' },
        { doc_number: '0000-002319', doc_date: '2026-09-20', amount: '1000.50' },
      ],
    }]);
    expect(result.has(500)).toBe(false);
  });

  it('«Оплачено» с нулём и ведомость сводятся в одну запись; прочие статьи и другой месяц — нет', async () => {
    const result = await loadAbsencePay1c([999], '2026-09');

    expect(result.get(999)).toEqual(expect.arrayContaining([
      { code: 'vacation', paid: '0.00', payouts: [{ doc_number: '0000-002330', doc_date: '2026-09-04', amount: '12000.00' }] },
      { code: 'sick_leave', paid: null, payouts: [{ doc_number: '0000-002400', doc_date: '2026-09-25', amount: '1740.00' }] },
    ]));
    expect(result.get(999)).toHaveLength(2);
  });

  it('пустой список сотрудников — без запросов, пустой результат', async () => {
    expect((await loadAbsencePay1c([], '2026-09')).size).toBe(0);
  });
});
