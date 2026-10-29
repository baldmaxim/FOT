import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';

import {
  buildRegisterLoadSql,
  buildRegisterReplaceSql,
  type IRegisterSqlDocument,
  type IRegisterSqlInput,
  type IRegisterSqlLine,
} from '../../../scripts/lib/payouts-register-sql.js';

// SQL регистра выплат ЗУП (scripts/lib/payouts-register-sql.ts) на настоящем PostgreSQL, миграция 328: замена
// месяца from → to, повтор — без изменений, откат — обратная замена; отказ без записи при лишнем документе месяца,
// revision 2, журнале, испорченном наборе; параллельная запись ждёт; сбой после удаления откатывает всё.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы пересоздаются). Гонять отдельно от
// других *.pg.test.ts: они дропают те же таблицы.

const PG_URL = process.env.FOT_TEST_PG_URL;
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../docs/migrations/', import.meta.url));

const MONTH = '2026-09-01';

const part = (guid: string, docNumber: string, method: string, rows: Array<[string, number, number | null]>,
  periodMonth = MONTH): { doc: IRegisterSqlDocument; lines: IRegisterSqlLine[] } => ({
  doc: {
    guid, docNumber, docDate: '2026-10-05', periodMonth, paymentMethod: method,
    totalCents: rows.reduce((sum, [, cents]) => sum + cents, 0), contentHash: guid.slice(0, 1).repeat(64),
    lineCount: rows.length, lockKey: `payroll_1c_payout_no:${docNumber}|2026-10-05`,
  },
  lines: rows.map(([name, cents, employeeId], index) => ({
    guid, lineNo: index + 1, lineKey: `${name.toLowerCase()}|${cents}|1`, fullName: name, department: 'ИТР',
    amountCents: cents, employeeId, employeeName: employeeId === null ? null : `${name} (ФОТ)`,
    resolution: employeeId === null ? 'unmatched' : 'confirmed', reason: 'Регистр выплат ЗУП 09.2026: тест',
  })),
});
const set = (...parts: Array<ReturnType<typeof part>>): IRegisterSqlInput => ({
  header: ['тест'], documents: parts.map(p => p.doc), lines: parts.flatMap(p => p.lines),
});

const A = part('a0000000-0000-5000-8000-000000000001', '0000-000001', 'Аванс', [['Иванов Иван', 10000, 1], ['Товбин Михаил', 20000, null]]);
const B = part('b0000000-0000-5000-8000-000000000002', '0000-000002', 'Премии', [['Петров Пётр', 5050, 2]]);
const C = part('c0000000-0000-5000-8000-000000000003', '0000-000788', 'Премии', [['Петров Пётр', 7000, 2], ['Иванов Иван', 100, 1]]);
const EXTRA = part('e0000000-0000-5000-8000-000000000005', '0000-000005', 'Аванс', [['Иванов Иван', 1, 1]]);
const AUG = part('d0000000-0000-5000-8000-000000000004', '0000-000003', 'Аванс', [['Иванов Иван', 999, 1]], '2026-08-01');
const FROM = set(A, B);
const TO = set(A, C);
const REPLACE = buildRegisterReplaceSql(['замена'], FROM, TO, MONTH);
const ROLLBACK = buildRegisterReplaceSql(['откат'], TO, FROM, MONTH);

describe.skipIf(!PG_URL)('регистр выплат ЗУП: SQL замены месяца на PostgreSQL', () => {
  let pool: Pool;

  /** SQL генератора через node-pg (без мета-команды psql): NOTICE наружу; ошибка — ROLLBACK и исключение. */
  const runScript = async (sql: string, own?: PoolClient): Promise<string[]> => {
    const client = own ?? await pool.connect();
    const notices: string[] = [];
    const onNotice = (msg: { message?: string }) => notices.push(msg.message ?? '');
    client.on('notice', onNotice);
    try {
      await client.query(sql.replace(/^\\set ON_ERROR_STOP on$/m, ''));
      return notices;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.off('notice', onNotice);
      if (!own) client.release();
    }
  };

  /** Документы и строки по ГУИДу — всё, что сравнивает экран, плюс id/created_at (не пересоздан ли). */
  const state = async () => (await pool.query(
    `SELECT d.doc_guid::text AS guid, d.id::text AS id, d.created_at::text AS created_at, d.period_month::text AS month,
            d.revision, d.total_amount::text AS total,
            json_agg(json_build_object('no', l.line_no, 'name', l.full_name_1c, 'brigade', l.brigade_1c,
              'amount', l.amount::text, 'employee', l.employee_id, 'resolution', l.resolution) ORDER BY l.line_no) AS lines
       FROM payroll_1c_payout_documents d JOIN payroll_1c_payout_lines l ON l.document_id = d.id
      GROUP BY d.id ORDER BY d.doc_guid`,
  )).rows;
  const guids = async () => (await state()).map(row => row.guid);
  const withoutIds = (rows: Awaited<ReturnType<typeof state>>) => rows.map(({ id: _id, created_at: _at, ...rest }) => rest);

  const expectRejected = async (sql: string, message: RegExp) => {
    const before = await state();
    await expect(runScript(sql)).rejects.toThrow(message);
    expect(await state()).toEqual(before);
  };

  beforeAll(async () => {
    const { Pool: PgPool } = await import('pg');
    pool = new PgPool({ connectionString: PG_URL, max: 4 });
    await pool.query(`
      DROP TABLE IF EXISTS payroll_1c_payout_imports, payroll_1c_payout_lines, payroll_1c_payout_documents,
        employee_hr_profiles, employees, user_profiles CASCADE;
      CREATE TABLE user_profiles (id uuid PRIMARY KEY);
      CREATE TABLE employees (id integer PRIMARY KEY, full_name text NOT NULL);
      CREATE TABLE employee_hr_profiles (employee_id integer PRIMARY KEY, passdesk_id_all uuid);
      INSERT INTO employees VALUES (1, 'Иванов Иван (ФОТ)'), (2, 'Петров Пётр (ФОТ)');
    `);
    await pool.query(readFileSync(`${MIGRATIONS_DIR}328_payroll_1c_payouts.sql`, 'utf8'));
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM payroll_1c_payout_documents');
    await runScript(buildRegisterLoadSql(FROM));
    await runScript(buildRegisterLoadSql(set(AUG)));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('точное from → замена: оставленный и другой месяц не тронуты; повтор — без изменений', async () => {
    const before = await state();
    const notices = await runScript(REPLACE);
    expect(notices).toContain('Оставлено документов: 1, удалено: 1, добавлено: 1 (строк 2)');
    const after = await state();
    expect(after.map(row => row.guid)).toEqual([A.doc.guid, C.doc.guid, AUG.doc.guid]);
    // Оставленный и августовский — те же строки БД (id и created_at), новый — строки набора.
    expect(after[0]).toEqual(before.find(row => row.guid === A.doc.guid));
    expect(after[2]).toEqual(before.find(row => row.guid === AUG.doc.guid));
    expect(after[1].lines.map((line: { employee: number }) => line.employee)).toEqual([2, 1]);
    expect(after[1].total).toBe('71.00');

    expect(await runScript(REPLACE)).toContain('Без изменений: документы месяца уже ровно этот набор');
    expect(await state()).toEqual(after);
  });

  it('откат — обратная замена: месяц снова ровно from, загрузка from видит «без изменений»; замена снова', async () => {
    const initial = withoutIds(await state());
    await runScript(REPLACE);
    expect(await runScript(ROLLBACK)).toContain('Оставлено документов: 1, удалено: 1, добавлено: 1 (строк 1)');
    expect(withoutIds(await state())).toEqual(initial);
    expect(await runScript(buildRegisterLoadSql(FROM))).toContain('Без изменений: этот набор уже загружен');
    await runScript(REPLACE);
    expect(await guids()).toEqual([A.doc.guid, C.doc.guid, AUG.doc.guid]);
  });

  it('отказ без записи: лишний документ месяца, revision 2, журнал, испорченный набор from', async () => {
    await runScript(buildRegisterLoadSql(set(EXTRA)));
    await expectRejected(REPLACE, /Состояние месяца не то/);
    await pool.query('DELETE FROM payroll_1c_payout_documents WHERE doc_guid = $1', [EXTRA.doc.guid]);

    await pool.query('UPDATE payroll_1c_payout_documents SET revision = 2 WHERE doc_guid = $1', [B.doc.guid]);
    await expectRejected(REPLACE, /Состояние месяца не то/);
    await pool.query('UPDATE payroll_1c_payout_documents SET revision = 1 WHERE doc_guid = $1', [B.doc.guid]);

    await pool.query(
      `INSERT INTO payroll_1c_payout_imports (document_id, action, revision_before, revision_after, content_hash_after,
         previous_lines, source_format, file_sha256, lines_matched, lines_unmatched, amount_matched, amount_unmatched)
       SELECT id, 'relink', 1, 2, content_hash, '[]', 'zup2', content_hash, 0, 0, 0, 0
         FROM payroll_1c_payout_documents WHERE doc_guid = $1`,
      [A.doc.guid],
    );
    await expectRejected(REPLACE, /Состояние месяца не то/);
    await pool.query('DELETE FROM payroll_1c_payout_imports');

    // Копейка перенесена между шапками: итоги набора те же, строки с ведомостями не сходятся.
    const spoiled = set(
      { ...A, doc: { ...A.doc, totalCents: A.doc.totalCents - 1 } }, { ...B, doc: { ...B.doc, totalCents: B.doc.totalCents + 1 } },
    );
    await expectRejected(buildRegisterReplaceSql(['замена'], spoiled, TO, MONTH), /reg_from не сходятся с ведомостями/);
    const short = set(A, { ...B, doc: { ...B.doc, totalCents: B.doc.totalCents + 1 } });
    await expectRejected(buildRegisterReplaceSql(['замена'], short, TO, MONTH), /Строки набора reg_from не те/);
    await runScript(REPLACE);
  });

  it('параллельная запись в месяц: замена ждёт её конца, видит лишний документ и ничего не пишет', async () => {
    const writer = await pool.connect();
    const replacer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(
        `INSERT INTO payroll_1c_payout_documents (doc_guid, doc_number, doc_date, period_month, payment_method,
           organization_inn, total_amount, content_hash, revision)
         VALUES ($1, '0000-000009', '2026-10-05', $2, 'Аванс', '7736255508', 1, $3, 1)`,
        ['f0000000-0000-5000-8000-000000000009', MONTH, 'f'.repeat(64)],
      );
      const pid = (await replacer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const pending = runScript(REPLACE, replacer).then(() => 'ok', (err: Error) => err.message);
      let waiting = false;
      for (let i = 0; i < 50 && !waiting; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
        const row = (await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid])).rows[0];
        waiting = row?.wait_event_type === 'Lock';
      }
      expect(waiting).toBe(true);
      await writer.query('COMMIT');
      expect(await pending).toMatch(/Состояние месяца не то/);
      expect(await guids()).toEqual([A.doc.guid, B.doc.guid, AUG.doc.guid]);
    } finally {
      writer.release();
      replacer.release();
      await pool.query('DELETE FROM payroll_1c_payout_documents WHERE doc_guid = $1', ['f0000000-0000-5000-8000-000000000009']);
    }
  });

  it('сбой после удаления (строки вставились не такими) — откатывается вся транзакция', async () => {
    await pool.query(`
      CREATE FUNCTION test_spoil_line() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.brigade_1c := 'испорчено'; RETURN NEW; END $$;
      CREATE TRIGGER test_spoil_line BEFORE INSERT ON payroll_1c_payout_lines FOR EACH ROW EXECUTE FUNCTION test_spoil_line();
    `);
    try {
      await expectRejected(REPLACE, /После замены документы месяца не совпали/);
    } finally {
      await pool.query('DROP TRIGGER test_spoil_line ON payroll_1c_payout_lines; DROP FUNCTION test_spoil_line()');
    }
  });
});
