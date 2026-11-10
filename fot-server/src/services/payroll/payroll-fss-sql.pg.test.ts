import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';

import { buildFssLoadSql, buildFssRollbackSql, type IFssSqlInput } from '../../../scripts/lib/fss-payments-sql.js';

// SQL реестра «Прямые выплаты ФСС» (scripts/lib/fss-payments-sql.ts) на настоящем PostgreSQL, миграция 356: вставка,
// повтор — без изменений, откат, повторная вставка; отказ без записи при части строк, другом содержимом, чужом ФИО
// сотрудника и другом реестре с тем же номером и датой; ROLLBACK оператора ничего не оставляет.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы пересоздаются). Гонять отдельно от
// других *.pg.test.ts: они дропают те же таблицы.

const PG_URL = process.env.FOT_TEST_PG_URL;
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../docs/migrations/', import.meta.url));

const GUID = '41b95081-c17b-11f1-8596-00505686eaee';
const INPUT: IFssSqlInput = {
  header: ['тест'],
  registry: { guid: GUID, docNumber: '000000070', docDate: '2026-09-30', periodMonth: '2026-09-01', contentHash: 'a'.repeat(64) },
  lines: [
    {
      lineNo: 1, fullName: 'Иванишин Сергей', personIdAll: 'd3c9a512-9dc3-11e1-8a6b-000c291d0f69', sickLeaveNumber: '910365045582',
      reason: 'ОбщееЗаболевание', dateFrom: '2026-09-10', dateTo: '2026-09-11', days: 2, grossCents: 365534, ndflCents: 47500,
      amountCents: 318034, employeeId: 1, employeeName: 'Иванишин Сергей (ФОТ)', resolutionReason: 'ФСС 09.2026: по id_all',
    },
    {
      lineNo: 2, fullName: 'Селиванов Олег', personIdAll: null, sickLeaveNumber: null, reason: null, dateFrom: null, dateTo: null,
      days: null, grossCents: 1947126, ndflCents: 253100, amountCents: 1694126, employeeId: null, employeeName: null,
      resolutionReason: 'ФСС 09.2026: нет в ФОТ',
    },
  ],
};

describe.skipIf(!PG_URL)('реестр ФСС: SQL загрузки и отката на PostgreSQL', () => {
  let pool: Pool;
  let database = '';
  const open = () => ({ database, controls: ["\\echo 'КОНТРОЛЬ'", 'SELECT 1;'] });

  /** SQL генератора через node-pg (мета-команды psql вырезаются); finish — что пишет оператор после сверки. */
  const runOpen = async (sql: string, finish: 'COMMIT' | 'ROLLBACK' = 'COMMIT'): Promise<string[]> => {
    const client: PoolClient = await pool.connect();
    const notices: string[] = [];
    const onNotice = (msg: { message?: string }) => notices.push(msg.message ?? '');
    client.on('notice', onNotice);
    try {
      await client.query(sql.replace(/^\\.*$/gm, ''));
      await client.query(finish);
      return notices;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.off('notice', onNotice);
      client.release();
    }
  };

  const state = async () => (await pool.query(
    `SELECT line_no, full_name_1c, amount_gross::text AS gross, ndfl::text AS ndfl, amount::text AS amount, employee_id,
            period_month::text AS month, date_from::text AS date_from, days, resolution_reason
       FROM payroll_fss_payments ORDER BY registry_guid, line_no`,
  )).rows;

  const expectRejected = async (sql: string, message: RegExp) => {
    const before = await state();
    await expect(runOpen(sql)).rejects.toThrow(message);
    expect(await state()).toEqual(before);
  };

  beforeAll(async () => {
    const { Pool: PgPool } = await import('pg');
    pool = new PgPool({ connectionString: PG_URL, max: 4 });
    await pool.query(`
      DROP TABLE IF EXISTS payroll_fss_payments, employees CASCADE;
      CREATE TABLE employees (id integer PRIMARY KEY, full_name text NOT NULL);
      INSERT INTO employees VALUES (1, 'Иванишин Сергей (ФОТ)'), (2, 'Петров Пётр (ФОТ)');
    `);
    await pool.query(readFileSync(`${MIGRATIONS_DIR}356_payroll_fss_payments.sql`, 'utf8'));
    // Повторный запуск миграции безопасен.
    await pool.query(readFileSync(`${MIGRATIONS_DIR}356_payroll_fss_payments.sql`, 'utf8'));
    database = (await pool.query<{ db: string }>('SELECT current_database() AS db')).rows[0].db;
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM payroll_fss_payments');
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('вставка → повтор без изменений → откат → снова вставка; суммы как в 1С, «на руки» не пересчитывается', async () => {
    const load = buildFssLoadSql(INPUT, open());
    expect(load).not.toMatch(/^COMMIT;$/m);
    expect(load).toMatch(/^\\echo 'Транзакция ОТКРЫТА/m);

    expect(await runOpen(load, 'ROLLBACK')).toContain('Вставлено строк ФСС: 2');
    expect(await state()).toEqual([]);

    expect(await runOpen(load)).toContain('Вставлено строк ФСС: 2');
    const saved = await state();
    expect(saved).toEqual([
      {
        line_no: 1, full_name_1c: 'Иванишин Сергей', gross: '3655.34', ndfl: '475.00', amount: '3180.34', employee_id: 1,
        month: '2026-09-01', date_from: '2026-09-10', days: 2, resolution_reason: 'ФСС 09.2026: по id_all',
      },
      {
        line_no: 2, full_name_1c: 'Селиванов Олег', gross: '19471.26', ndfl: '2531.00', amount: '16941.26', employee_id: null,
        month: '2026-09-01', date_from: null, days: null, resolution_reason: 'ФСС 09.2026: нет в ФОТ',
      },
    ]);
    expect(await runOpen(load)).toContain('Без изменений: этот реестр уже загружен');
    expect(await state()).toEqual(saved);

    expect(await runOpen(buildFssRollbackSql(INPUT, open()))).toContain('Удалено строк ФСС: 2');
    expect(await state()).toEqual([]);
    expect(await runOpen(load)).toContain('Вставлено строк ФСС: 2');
  });

  it('отказ без записи: часть строк, другое содержимое, чужое ФИО сотрудника, другой реестр с тем же номером, чужая база', async () => {
    const load = buildFssLoadSql(INPUT, open());
    await runOpen(load);

    // Строку изменили после загрузки — ни повтор, ни откат не проходят.
    await pool.query("UPDATE payroll_fss_payments SET employee_id = 2 WHERE line_no = 1");
    await expectRejected(load, /Состояние не то/);
    await expectRejected(buildFssRollbackSql(INPUT, open()), /Откат невозможен/);
    await pool.query("UPDATE payroll_fss_payments SET employee_id = 1 WHERE line_no = 1");

    // Одной строки нет.
    await pool.query('DELETE FROM payroll_fss_payments WHERE line_no = 2');
    await expectRejected(load, /из 2 строк реестра загружено 1/);
    await pool.query('DELETE FROM payroll_fss_payments');

    // ФИО сотрудника в ФОТ не то, что при сборке.
    const renamed = { ...INPUT, lines: INPUT.lines.map(line => (line.employeeId === 1 ? { ...line, employeeName: 'Другой' } : line)) };
    await expectRejected(buildFssLoadSql(renamed, open()), /id и ФИО сотрудника не совпали: 1 Другой/);

    // Тот же номер и дата под другим ГУИДом.
    await runOpen(buildFssLoadSql({ ...INPUT, registry: { ...INPUT.registry, guid: '41b95081-0000-0000-0000-000000000000' } }, open()));
    await expectRejected(load, /уже загружен другим документом/);
    await pool.query('DELETE FROM payroll_fss_payments');

    await expectRejected(buildFssLoadSql(INPUT, { database: 'FOT_Prod_нет', controls: [] }), /ожидалась FOT_Prod_нет/);
  });
});
