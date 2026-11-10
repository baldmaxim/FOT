import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { resetPassDocuments } from './contractor-docs.service.js';

// Единый сброс документов держателя (миграция 359) на настоящем PostgreSQL: SQL блокировки
// (FOR UPDATE OF p + подзапрос открытого держателя), снимок в историю с СНИЛС/ИНН/КиГ и
// источником из actor, очистка только строк с документами. Миграции 238 и 359 и их повтор.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы-заглушки пересоздаются).

const PG_URL = process.env.FOT_TEST_PG_URL;
const migration = (n: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../docs/migrations/${n}`, import.meta.url)), 'utf8');

describe.skipIf(!PG_URL)('contractor-docs resetPassDocuments (PG)', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
    await pool.query(`
      DROP TABLE IF EXISTS contractor_pass_document_history, contractor_pass_holders,
                           contractor_passes, user_profiles CASCADE;
      CREATE TABLE user_profiles (id uuid PRIMARY KEY, full_name text);
      CREATE TABLE contractor_passes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        pass_number text NOT NULL, org_department_id uuid, status text NOT NULL, holder_name text,
        passport_series_number text, passport_issue_date date, birth_date date, citizenship text,
        patent_number text, patent_issue_date date, patent_blank_number text,
        has_residence_permit boolean NOT NULL DEFAULT false, residence_permit_number text,
        updated_at timestamptz NOT NULL DEFAULT '2026-01-01'
      );
      CREATE TABLE contractor_pass_holders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        pass_id uuid REFERENCES contractor_passes(id), holder_name text,
        valid_from date NOT NULL, valid_until date, submission_id uuid,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await pool.query(migration('238_contractor_pass_document_history.sql'));
    await pool.query(migration('359_contractor_pass_snils_inn_kig.sql'));
    await pool.query(migration('359_contractor_pass_snils_inn_kig.sql')); // повтор — без ошибок
    await pool.query(`INSERT INTO user_profiles VALUES ('00000000-0000-0000-0000-0000000000aa', 'Админ Тестовый')`);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('снимок с прежним ФИО открытого держателя и новыми полями, очистка только строк с документами', async () => {
    const ins = await pool.query<{ id: string; pass_number: string }>(`
      INSERT INTO contractor_passes (pass_number, status, holder_name, passport_series_number, citizenship,
                                     snils, inn, kig, kig_end_date)
      VALUES ('64', 'applied', 'Устаревшее ФИО', '403934253', 'Таджикистан', '12345678900', '770708328934', 'AB1', '2027-03-01'),
             ('65', 'assigned', NULL, NULL, NULL, NULL, NULL, NULL, NULL)
      RETURNING id, pass_number`);
    const p64 = ins.rows.find(r => r.pass_number === '64')!.id;
    const p65 = ins.rows.find(r => r.pass_number === '65')!.id;
    await pool.query(
      `INSERT INTO contractor_pass_holders (pass_id, holder_name, valid_from) VALUES ($1, 'Иванов Иван', '2026-10-01')`,
      [p64],
    );

    const client = await pool.connect();
    let cleared: string[] = [];
    try {
      await client.query('BEGIN');
      cleared = await resetPassDocuments(client, [p65, p64], {
        userId: '00000000-0000-0000-0000-0000000000aa', source: 'clear_holder',
      });
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    expect(cleared).toEqual([p64]);
    const passes = await pool.query(
      `SELECT pass_number, passport_series_number, citizenship, snils, inn, kig, kig_end_date,
              has_residence_permit, updated_at > '2026-01-01' AS touched
         FROM contractor_passes ORDER BY pass_number`);
    expect(passes.rows[0]).toMatchObject({
      pass_number: '64', passport_series_number: null, citizenship: null, snils: null, inn: null,
      kig: null, kig_end_date: null, has_residence_permit: false, touched: true,
    });
    expect(passes.rows[1]).toMatchObject({ pass_number: '65', touched: false });

    const hist = await pool.query(
      `SELECT holder_name, snils, inn, kig, kig_end_date::text AS kig_end_date, changed_fields,
              changed_source, changed_by_name
         FROM contractor_pass_document_history`);
    expect(hist.rows).toHaveLength(1);
    expect(hist.rows[0]).toMatchObject({
      holder_name: 'Иванов Иван',
      snils: '12345678900', inn: '770708328934', kig: 'AB1', kig_end_date: '2027-03-01',
      changed_source: 'clear_holder', changed_by_name: 'Админ Тестовый',
    });
    expect(hist.rows[0].changed_fields).toEqual(
      expect.arrayContaining(['passport_series_number', 'citizenship', 'snils', 'inn', 'kig', 'kig_end_date']),
    );
  });

  it("CHECK истории принимает 'holder_reset'", async () => {
    await expect(pool.query(
      `INSERT INTO contractor_pass_document_history (pass_number, changed_fields, changed_source)
       VALUES ('1', '{}', 'holder_reset')`,
    )).resolves.toBeTruthy();
    await expect(pool.query(
      `INSERT INTO contractor_pass_document_history (pass_number, changed_fields, changed_source)
       VALUES ('1', '{}', 'unknown')`,
    )).rejects.toThrow(/changed_source_check/);
  });
});
