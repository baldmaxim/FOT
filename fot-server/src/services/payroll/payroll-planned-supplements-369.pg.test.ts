import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Миграция 369 на настоящем PostgreSQL: нормализация старого журнала плановых доплат (293/337) в «каждая неархивная
// строка с суммой — действующая доплата», история старых строк, повторный запуск, триггер против кода до 369.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы пересоздаются). Запускать отдельно от других
// PG-тестов плановых доплат: они пересоздают ту же таблицу.

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../../config/postgres.js', async () => {
  const { Pool, types } = await import('pg');
  types.setTypeParser(1082, (val: string) => val);
  types.setTypeParser(20, (val: string) => Number.parseInt(val, 10));
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 3 }) : null;
  const pool = () => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool;
  };
  return {
    pool,
    query: async (sql: string, params?: readonly unknown[]) => (await pool().query(sql, params as unknown[])).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) =>
      (await pool().query(sql, params as unknown[])).rows[0] ?? null,
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

import { getPlannedSupplementChanges } from './payroll-terms.service.js';
import { savePlannedSupplement } from './payroll-supplements.service.js';
import { PLANNED_SUPPLEMENT_PERIODS_SQL } from './payroll-planned-supplement-rows.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../docs/migrations/', import.meta.url));
const migration = (name: string): string => readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf8');

const AUTHOR = '00000000-0000-0000-0000-00000000000b';

/** Действующие периоды по правилу до 369 — то, что видел расчёт ФОТ на проде. */
const LEGACY_PERIODS_SQL = `
  SELECT v.id::int AS id, v.employee_id, v.amount::text AS amount,
         to_char(v.date_from, 'YYYY-MM-DD') AS date_from, to_char(v.date_to, 'YYYY-MM-DD') AS date_to
    FROM (
      SELECT x.id, x.employee_id, x.amount, x.date_from, x.date_to,
             x.id = max(x.id) OVER (PARTITION BY x.employee_id) AS is_current,
             lead(x.amount IS NULL) OVER (PARTITION BY x.employee_id ORDER BY x.id) AS next_removed
        FROM payroll_planned_supplements x
       WHERE x.archived_at IS NULL
    ) v
   WHERE v.amount IS NOT NULL
     AND (v.is_current OR (
           v.next_removed IS NOT TRUE
           AND NOT EXISTS (
             SELECT 1 FROM payroll_planned_supplements y
              WHERE y.employee_id = v.employee_id AND y.archived_at IS NULL AND y.id > v.id AND y.amount IS NOT NULL
                AND daterange(y.date_from, y.date_to, '[]') && daterange(v.date_from, v.date_to, '[]'))))
   ORDER BY v.employee_id, v.date_from, v.id`;

const currentPeriods = async () => (await pg.pool!.query(
  `SELECT p.id::int AS id, p.employee_id, p.amount::text AS amount,
          to_char(p.date_from, 'YYYY-MM-DD') AS date_from, to_char(p.date_to, 'YYYY-MM-DD') AS date_to
     FROM (${PLANNED_SUPPLEMENT_PERIODS_SQL}) p
    ORDER BY p.employee_id, p.date_from, p.id`,
)).rows;

const historyOf = async (employeeId: number) => (await getPlannedSupplementChanges(employeeId))
  .map(change => [change.action, change.amount, change.prev_amount]);

describe.skipIf(!PG_URL)('миграция 369: несколько плановых доплат на одни даты', () => {
  let legacyPeriods: unknown[] = [];

  beforeAll(async () => {
    await pg.pool!.query(`
      DROP TABLE IF EXISTS payroll_planned_supplements, user_profiles, employees CASCADE;
      DROP FUNCTION IF EXISTS payroll_planned_supplements_block_legacy();
      CREATE TABLE employees (id integer PRIMARY KEY, full_name text);
      CREATE TABLE user_profiles (id uuid PRIMARY KEY, full_name text);
      INSERT INTO employees (id, full_name) VALUES (1, 'Корж И.С.'), (2, 'Белякова Н.В.'), (3, 'Власов А.Н.'), (4, 'Пахомова В.В.');
      INSERT INTO user_profiles (id, full_name) VALUES ('${AUTHOR}', 'Петрова А.А.');
    `);
    for (const name of [
      '293_payroll_planned_supplements.sql', '322_payroll_planned_supplement_open_end.sql',
      '337_payroll_planned_supplement_rewrite.sql', '364_payroll_planned_supplement_comment.sql',
    ]) await pg.pool!.query(migration(name));

    // Старый журнал, как писал код до 369 (дописывание версий, «снята», переписывание 337).
    await pg.pool!.query(`
      INSERT INTO payroll_planned_supplements (id, employee_id, amount, date_from, date_to, created_by, archived_at, replaces_id, comment) VALUES
        -- Корж: бессрочная 20 000 → закрыта 30.09 (перекрытая версия), 30 000 окт–янв, 20 000 с февраля.
        (1, 1, 20000, '2023-03-01', NULL,         '${AUTHOR}', NULL, NULL, NULL),
        (2, 1, 20000, '2023-03-01', '2026-09-30', '${AUTHOR}', NULL, NULL, NULL),
        (3, 1, 30000, '2026-10-01', '2027-01-31', '${AUTHOR}', NULL, NULL, 'Совмещение'),
        (4, 1, 20000, '2027-02-01', NULL,         '${AUTHOR}', NULL, NULL, NULL),
        -- Белякова: 25 000, затем «снята».
        (5, 2, 25000, '2023-09-01', NULL,         '${AUTHOR}', NULL, NULL, NULL),
        (6, 2, NULL,  NULL,         NULL,         '${AUTHOR}', NULL, NULL, NULL),
        -- Власов: правка суммы на тех же датах (прежняя версия перекрыта).
        (7, 3, 10000, '2026-01-01', '2026-12-31', '${AUTHOR}', NULL, NULL, NULL),
        (8, 3, 12000, '2026-01-01', '2026-12-31', '${AUTHOR}', NULL, NULL, NULL),
        -- Пахомова: переписанное расписание 337 — архив и копия.
        (9, 4, 30000, '2025-06-30', NULL,         '${AUTHOR}', now(), NULL, NULL),
        (10, 4, 30000, '2025-06-30', NULL,        '${AUTHOR}', NULL, 9, NULL);
      SELECT setval(pg_get_serial_sequence('payroll_planned_supplements', 'id'), 10);
    `);
    legacyPeriods = (await pg.pool!.query(LEGACY_PERIODS_SQL)).rows;

    await pg.pool!.query(migration('369_payroll_planned_supplements_concurrent.sql'));
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('действующие периоды — те же, что по прежнему правилу; перекрытые и «снята» — в архиве', async () => {
    expect(legacyPeriods).toEqual([
      { id: 2, employee_id: 1, amount: '20000.00', date_from: '2023-03-01', date_to: '2026-09-30' },
      { id: 3, employee_id: 1, amount: '30000.00', date_from: '2026-10-01', date_to: '2027-01-31' },
      { id: 4, employee_id: 1, amount: '20000.00', date_from: '2027-02-01', date_to: null },
      { id: 8, employee_id: 3, amount: '12000.00', date_from: '2026-01-01', date_to: '2026-12-31' },
      { id: 10, employee_id: 4, amount: '30000.00', date_from: '2025-06-30', date_to: null },
    ]);
    expect(await currentPeriods()).toEqual(legacyPeriods);
    const archived = (await pg.pool!.query(
      'SELECT id::int AS id FROM payroll_planned_supplements WHERE archived_at IS NOT NULL ORDER BY id',
    )).rows.map(row => row.id);
    expect(archived).toEqual([1, 5, 6, 7, 9]);
    // Все старые строки — legacy_journal.
    expect((await pg.pool!.query(
      'SELECT count(*)::int AS n FROM payroll_planned_supplements WHERE NOT legacy_journal',
    )).rows[0].n).toBe(0);
  });

  it('история старых строк — как до 369: «было» из предыдущей строки журнала, копии 337 скрыты', async () => {
    expect(await historyOf(1)).toEqual([
      ['changed', '20000.00', '30000.00'],
      ['changed', '30000.00', '20000.00'],
      ['changed', '20000.00', '20000.00'],
      ['assigned', '20000.00', null],
    ]);
    expect(await historyOf(2)).toEqual([['removed', null, '25000.00'], ['assigned', '25000.00', null]]);
    expect(await historyOf(3)).toEqual([['changed', '12000.00', '10000.00'], ['assigned', '10000.00', null]]);
    expect(await historyOf(4)).toEqual([['assigned', '30000.00', null]]);
  });

  it('новая доплата на те же даты — рядом; повторный запуск 369 её не архивирует', async () => {
    expect(await savePlannedSupplement({
      employeeId: 1, value: { amount: 10000, dateFrom: '2026-10-01', dateTo: '2027-01-31', comment: 'Руководство' },
      createdBy: AUTHOR, onlyIfNone: true,
    })).toEqual({ status: 'saved', previous: null });
    const before = await currentPeriods();
    expect(before.filter(row => row.employee_id === 1 && row.date_from === '2026-10-01').map(row => row.amount))
      .toEqual(['30000.00', '10000.00']);

    await pg.pool!.query(migration('369_payroll_planned_supplements_concurrent.sql'));
    expect(await currentPeriods()).toEqual(before);
    // В истории — «назначена», а не «замена» последней строки журнала.
    expect((await historyOf(1))[0]).toEqual(['assigned', '10000.00', null]);
  });

  it('вставка кодом до 369 (без legacy_journal) отклоняется триггером', async () => {
    await expect(pg.pool!.query(
      `INSERT INTO payroll_planned_supplements (employee_id, amount, date_from, date_to)
       VALUES (2, 5000, '2026-11-01', NULL)`,
    )).rejects.toThrow(/Плановые доплаты обновляются/);
    // Сохранение условий без правки доплаты прежним кодом — INSERT … SELECT без строк — триггер не трогает.
    await expect(pg.pool!.query(
      `INSERT INTO payroll_planned_supplements (employee_id, amount, date_from, date_to)
       SELECT 2, 5000, '2026-11-01'::date, NULL WHERE false`,
    )).resolves.toMatchObject({ rowCount: 0 });
  });
});
