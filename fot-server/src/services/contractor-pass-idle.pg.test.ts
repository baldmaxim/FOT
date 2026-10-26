import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// «Не ходят больше 5 дней» на настоящем PostgreSQL: границы по МСК, слот прежнего держателя,
// несколько employees на один Sigur-id и порядок «последнего» прохода живут в SQL — мок драйвера
// показал бы ровно то, что ему подложили. Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД.
// Таблицы — в своей схеме contractor_pass_idle_pg_test (search_path). В обычном прогоне пропускается.

const PG_URL = process.env.FOT_TEST_PG_URL;
const SCHEMA = 'contractor_pass_idle_pg_test';

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../config/postgres.js', async () => {
  const { Pool } = await import('pg');
  pg.pool = process.env.FOT_TEST_PG_URL
    ? new Pool({
      connectionString: process.env.FOT_TEST_PG_URL,
      options: '-c search_path=contractor_pass_idle_pg_test',
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

import { countIdlePassesByOrg, fetchIdleContractorPasses } from './contractor-pass-idle.service.js';

/** Сегодня по МСК; порог «больше 5 дней» — проходов нет с 21.10 00:00 МСК. */
const TODAY = '2026-10-26';
const ORG_A = '00000000-0000-0000-0000-0000000000a1';
const ORG_B = '00000000-0000-0000-0000-0000000000b1';

const sql = async (text: string, params?: unknown[]) => { await pg.pool!.query(text, params); };

let passSeq = 0;
/** Пропуск с текущим держателем; approvedAt — МСК-время 'YYYY-MM-DD HH:MI' или null (не одобрен). */
const addPass = async (opts: {
  org?: string; num: string; sigur: number; approvedAt: string | null; active?: boolean; holder?: string;
}): Promise<void> => {
  passSeq += 1;
  const id = `00000000-0000-0000-0000-${String(passSeq).padStart(12, '0')}`;
  await sql(
    `INSERT INTO contractor_passes (id, org_department_id, pass_number, holder_name, sigur_employee_id, is_active)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, opts.org ?? ORG_A, opts.num, `Пропуск ${opts.num}`, opts.sigur, opts.active ?? true],
  );
  // Прежний держатель слота — закрыт, одобрен давно.
  await sql(
    `INSERT INTO contractor_pass_holders (pass_id, holder_name, valid_until, approved_at)
     VALUES ($1, 'Прежний держатель', '2026-08-01', '2026-07-01 10:00'::timestamp AT TIME ZONE 'Europe/Moscow')`,
    [id],
  );
  await sql(
    `INSERT INTO contractor_pass_holders (pass_id, holder_name, valid_until, approved_at)
     VALUES ($1, $2, NULL, $3::timestamp AT TIME ZONE 'Europe/Moscow')`,
    [id, opts.holder ?? `Держатель ${opts.num}`, opts.approvedAt],
  );
};

const addEmployee = async (id: number, sigur: number, archived = false): Promise<void> => {
  await sql('INSERT INTO employees (id, sigur_employee_id, is_archived) VALUES ($1, $2, $3)', [id, sigur, archived]);
};

/** Событие СКУД; at — МСК-время 'YYYY-MM-DD HH:MI'. */
const addEvent = async (employeeId: number, at: string, point = 'КПП-1', direction = 'entry'): Promise<void> => {
  await sql(
    `INSERT INTO skud_events (employee_id, event_at, event_date, direction, access_point)
     VALUES ($1, $2::timestamp AT TIME ZONE 'Europe/Moscow', ($2::timestamp)::date, $3, $4)`,
    [employeeId, at, direction, point],
  );
};

describe.skipIf(!PG_URL)('«Не ходят больше 5 дней» на PostgreSQL', () => {
  beforeAll(async () => {
    await sql(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await sql(`CREATE SCHEMA ${SCHEMA}`);
    await sql(`
      CREATE TABLE org_departments (id uuid PRIMARY KEY, name text NOT NULL);
      CREATE TABLE contractor_passes (
        id uuid PRIMARY KEY, org_department_id uuid NOT NULL, pass_number text NOT NULL,
        holder_name text, sigur_employee_id bigint, is_active boolean NOT NULL DEFAULT false
      );
      CREATE TABLE contractor_pass_holders (
        id serial PRIMARY KEY, pass_id uuid NOT NULL, holder_name text NOT NULL,
        valid_until date, approved_at timestamptz
      );
      CREATE TABLE employees (
        id integer PRIMARY KEY, sigur_employee_id bigint, is_archived boolean NOT NULL DEFAULT false,
        employment_status text NOT NULL DEFAULT 'active'
      );
      CREATE TABLE skud_events (
        id bigserial PRIMARY KEY, employee_id integer, event_at timestamptz NOT NULL, event_date date NOT NULL,
        direction text NOT NULL, access_point text
      );
    `);
    await sql(`INSERT INTO org_departments VALUES ($1, 'АЛЬФА ООО'), ($2, 'БЕТА ООО')`, [ORG_A, ORG_B]);

    // 101: последний проход 20.10 23:59 — 6 дней, в списке.
    await addPass({ num: '101', sigur: 1, approvedAt: '2026-09-01 10:00' });
    await addEmployee(1, 1);
    await addEvent(1, '2026-10-01 08:00');
    await addEvent(1, '2026-10-20 23:59', 'КПП-2', 'exit');
    // 102: проход ровно в 21.10 00:00 — 5 дней, не в списке.
    await addPass({ num: '102', sigur: 2, approvedAt: '2026-09-01 10:00' });
    await addEmployee(2, 2);
    await addEvent(2, '2026-10-21 00:00');
    // 103: проходов после выдачи 01.10 не было — 25 дней от выдачи.
    await addPass({ num: '103', sigur: 3, approvedAt: '2026-10-01 12:00' });
    await addEmployee(3, 3);
    // 104: выдан 3 дня назад, проходов нет — рано.
    await addPass({ num: '104', sigur: 4, approvedAt: '2026-10-23 12:00' });
    await addEmployee(4, 4);
    // 105: выдан 20.10 вечером, проходов нет — 6 дней; 106: выдан 21.10 00:30 — 5 дней, не в списке.
    await addPass({ num: '105', sigur: 5, approvedAt: '2026-10-20 21:00' });
    await addEmployee(5, 5);
    await addPass({ num: '106', sigur: 6, approvedAt: '2026-10-21 00:30' });
    await addEmployee(6, 6);
    // 107: слот выдан 15.10 10:00, проходы 14.10 и 15.10 09:00 — прежнего держателя, не считаются.
    await addPass({ num: '107', sigur: 7, approvedAt: '2026-10-15 10:00' });
    await addEmployee(7, 7);
    await addEvent(7, '2026-10-14 12:00');
    await addEvent(7, '2026-10-15 09:00');
    // 108: свежее событие с посторонним направлением — не проход; последний вход 01.10.
    await addPass({ num: '108', sigur: 8, approvedAt: '2026-09-01 10:00' });
    await addEmployee(8, 8);
    await addEvent(8, '2026-10-01 08:00');
    await addEvent(8, '2026-10-24 08:00', 'КПП-1', 'denied');
    // 109: событие «из будущего» 28.10 не прячет пропуск и не становится последним.
    await addPass({ num: '109', sigur: 9, approvedAt: '2026-09-01 10:00' });
    await addEmployee(9, 9);
    await addEvent(9, '2026-10-05 08:00');
    await addEvent(9, '2026-10-28 08:00');
    // 110: неактивный пропуск — не в списке.
    await addPass({ num: '110', sigur: 10, approvedAt: '2026-09-01 10:00', active: false });
    await addEmployee(10, 10);
    // 111: текущий держатель ещё не одобрен — не в списке.
    await addPass({ num: '111', sigur: 11, approvedAt: null });
    await addEmployee(11, 11);
    // 112: свежий проход у архивной строки employees того же Sigur-id — ходит.
    await addPass({ num: '112', sigur: 12, approvedAt: '2026-09-01 10:00' });
    await addEmployee(12, 12);
    await addEmployee(1012, 12, true);
    await addEvent(12, '2026-10-01 08:00');
    await addEvent(1012, '2026-10-22 08:00');
    // 113: последний проход — у архивной строки (12.10), у активной раньше (10.10).
    await addPass({ num: '113', sigur: 13, approvedAt: '2026-09-01 10:00' });
    await addEmployee(13, 13);
    await addEmployee(1013, 13, true);
    await addEvent(13, '2026-10-10 08:00');
    await addEvent(1013, '2026-10-12 18:00', 'Архивный КПП', 'exit');
    // 114: два события в одну секунду — точка от бо́льшего id.
    await addPass({ num: '114', sigur: 14, approvedAt: '2026-09-01 10:00' });
    await addEmployee(14, 14);
    await addEvent(14, '2026-10-11 08:00', 'КПП-1');
    await addEvent(14, '2026-10-11 08:00', 'КПП-2');
    // Другой подрядчик: один не ходящий.
    await addPass({ org: ORG_B, num: '201', sigur: 21, approvedAt: '2026-09-01 10:00' });
    await addEmployee(21, 21);
    await addEvent(21, '2026-10-02 08:00');
  });

  afterAll(async () => {
    if (pg.pool) {
      await pg.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await pg.pool.end();
    }
  });

  it('список подрядчика: границы по МСК, слот, направления, будущее, архивные строки, порядок', async () => {
    const rows = await fetchIdleContractorPasses([ORG_A], TODAY);
    expect(rows.map(r => ({
      pass_number: r.pass_number,
      last_event_date: r.last_event_date,
      last_access_point: r.last_access_point,
      days_idle: r.days_idle,
    }))).toEqual([
      { pass_number: '103', last_event_date: null, last_access_point: null, days_idle: 25 },
      { pass_number: '108', last_event_date: '2026-10-01', last_access_point: 'КПП-1', days_idle: 25 },
      { pass_number: '109', last_event_date: '2026-10-05', last_access_point: 'КПП-1', days_idle: 21 },
      { pass_number: '114', last_event_date: '2026-10-11', last_access_point: 'КПП-2', days_idle: 15 },
      { pass_number: '113', last_event_date: '2026-10-12', last_access_point: 'Архивный КПП', days_idle: 14 },
      { pass_number: '107', last_event_date: null, last_access_point: null, days_idle: 11 },
      { pass_number: '101', last_event_date: '2026-10-20', last_access_point: 'КПП-2', days_idle: 6 },
      { pass_number: '105', last_event_date: null, last_access_point: null, days_idle: 6 },
    ]);
    expect(rows[0]).toMatchObject({ org_department_id: ORG_A, org_name: 'АЛЬФА ООО', holder_name: 'Держатель 103' });
  });

  it('счётчик по подрядчику совпадает с длиной списка', async () => {
    const counts = await countIdlePassesByOrg([ORG_A, ORG_B], TODAY);
    const list = await fetchIdleContractorPasses([ORG_A, ORG_B], TODAY);
    const byOrg = new Map<string, number>();
    for (const r of list) byOrg.set(r.org_department_id, (byOrg.get(r.org_department_id) ?? 0) + 1);
    expect(Object.fromEntries(counts.map(c => [c.org_department_id, c.idle_new]))).toEqual({ [ORG_A]: 8, [ORG_B]: 1 });
    expect(Object.fromEntries(byOrg)).toEqual({ [ORG_A]: 8, [ORG_B]: 1 });
    // Список «все подрядчики» — по имени подрядчика.
    expect(list.at(-1)).toMatchObject({ org_name: 'БЕТА ООО', pass_number: '201', days_idle: 24 });
  });

  it('пустой список организаций — без запроса', async () => {
    expect(await countIdlePassesByOrg([], TODAY)).toEqual([]);
    expect(await fetchIdleContractorPasses([], TODAY)).toEqual([]);
  });
});
