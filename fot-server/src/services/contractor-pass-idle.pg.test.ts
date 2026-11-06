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

import {
  countIdlePassesByOrg,
  fetchIdleBlockCandidates,
  fetchIdleContractorPasses,
  lockIdleBlockCandidate,
  markContractorPassUnblocked,
} from './contractor-pass-idle.service.js';

/** Сегодня по МСК; порог «больше 5 дней» — проходов нет с 21.10 00:00 МСК. */
const TODAY = '2026-10-26';
const ORG_A = '00000000-0000-0000-0000-0000000000a1';
const ORG_B = '00000000-0000-0000-0000-0000000000b1';
/** Автоблокировка: свой подрядчик, чтобы не сдвигать числа по ORG_A и ORG_B. */
const ORG_C = '00000000-0000-0000-0000-0000000000c1';

const sql = async (text: string, params?: unknown[]) => { await pg.pool!.query(text, params); };

let passSeq = 0;
let passAutoBlocked = '';
let passPlain = '';
let passRecheck = '';
/** Пропуск с текущим держателем; approvedAt — МСК-время 'YYYY-MM-DD HH:MI' или null (не одобрен). */
const addPass = async (opts: {
  org?: string; num: string; sigur: number; approvedAt: string | null; active?: boolean; holder?: string;
  status?: string; idleBlockedAt?: string; externalSeenAt?: string; failedAt?: string;
  /** Отметка автоблокировки у ПРЕЖНЕГО держателя слота. */
  previousIdleBlockedAt?: string;
}): Promise<string> => {
  passSeq += 1;
  const id = `00000000-0000-0000-0000-${String(passSeq).padStart(12, '0')}`;
  await sql(
    `INSERT INTO contractor_passes (id, org_department_id, pass_number, holder_name, sigur_employee_id, is_active, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, opts.org ?? ORG_A, opts.num, `Пропуск ${opts.num}`, opts.sigur, opts.active ?? true, opts.status ?? 'applied'],
  );
  // Прежний держатель слота — закрыт, одобрен давно.
  await sql(
    `INSERT INTO contractor_pass_holders (pass_id, holder_name, valid_until, approved_at, idle_blocked_at)
     VALUES ($1, 'Прежний держатель', '2026-08-01', '2026-07-01 10:00'::timestamp AT TIME ZONE 'Europe/Moscow',
             $2::timestamp AT TIME ZONE 'Europe/Moscow')`,
    [id, opts.previousIdleBlockedAt ?? null],
  );
  await sql(
    `INSERT INTO contractor_pass_holders
       (pass_id, holder_name, valid_until, approved_at, idle_blocked_at, external_blocked_seen_at, idle_block_failed_at)
     VALUES ($1, $2, NULL, $3::timestamp AT TIME ZONE 'Europe/Moscow',
             $4::timestamp AT TIME ZONE 'Europe/Moscow',
             $5::timestamp AT TIME ZONE 'Europe/Moscow',
             $6::timestamp AT TIME ZONE 'Europe/Moscow')`,
    [id, opts.holder ?? `Держатель ${opts.num}`, opts.approvedAt,
      opts.idleBlockedAt ?? null, opts.externalSeenAt ?? null, opts.failedAt ?? null],
  );
  return id;
};

/** Запись журнала о блокировке или разблокировке; at — МСК-время. */
const addAudit = async (sigur: number, action: 'block' | 'unblock', at: string): Promise<void> => {
  await sql(
    `INSERT INTO audit_logs (entity_type, entity_id, details, created_at)
     VALUES ('sigur_employee', $1, $2::jsonb, $3::timestamp AT TIME ZONE 'Europe/Moscow')`,
    [String(sigur), JSON.stringify({ action }), at],
  );
};

const holderIdOf = async (passId: string): Promise<string> => {
  const res = await pg.pool!.query(
    'SELECT id::text AS id FROM contractor_pass_holders WHERE pass_id = $1 AND valid_until IS NULL',
    [passId],
  );
  return res.rows[0].id as string;
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
        holder_name text, sigur_employee_id bigint, is_active boolean NOT NULL DEFAULT false,
        status text NOT NULL DEFAULT 'applied', updated_at timestamptz
      );
      CREATE TABLE contractor_pass_holders (
        id serial PRIMARY KEY, pass_id uuid NOT NULL, holder_name text NOT NULL,
        valid_until date, approved_at timestamptz,
        idle_blocked_at timestamptz, external_blocked_seen_at timestamptz, idle_block_failed_at timestamptz
      );
      CREATE TABLE audit_logs (
        id bigserial PRIMARY KEY, entity_type text, entity_id text, details jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
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
    await sql(
      `INSERT INTO org_departments VALUES ($1, 'АЛЬФА ООО'), ($2, 'БЕТА ООО'), ($3, 'ГАММА ООО')`,
      [ORG_A, ORG_B, ORG_C],
    );

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

    // Автоблокировка. 301: уже заблокирован автоматически — в списке, не в очереди.
    passAutoBlocked = await addPass({
      org: ORG_C, num: '301', sigur: 301, approvedAt: '2026-09-01 10:00', active: false, idleBlockedAt: '2026-10-25 01:30',
    });
    await addEmployee(301, 301);
    await addEvent(301, '2026-10-03 08:00');
    // 302: заблокирован вручную, автоблокировка только увидела.
    await addPass({
      org: ORG_C, num: '302', sigur: 302, approvedAt: '2026-09-01 10:00', active: false, externalSeenAt: '2026-10-25 04:10',
    });
    await addEmployee(302, 302);
    await addEvent(302, '2026-10-04 08:00');
    // 303: разблокирован 23.10 (до включения автоблокировки, без отметок) — вне очереди и списка.
    await addPass({ org: ORG_C, num: '303', sigur: 303, approvedAt: '2026-09-01 10:00' });
    await addEmployee(303, 303);
    await addEvent(303, '2026-10-01 08:00');
    await addAudit(303, 'unblock', '2026-10-23 12:00');
    // 304: разблокирован 20.10, шесть дней назад, не ходит с 01.10 — 6 дней, а не 25.
    await addPass({ org: ORG_C, num: '304', sigur: 304, approvedAt: '2026-09-01 10:00' });
    await addEmployee(304, 304);
    await addEvent(304, '2026-10-01 08:00');
    await addAudit(304, 'unblock', '2026-10-20 12:00');
    await addAudit(304, 'block', '2026-10-22 12:00');
    // 305: не ходит с 05.10 — 21 день.
    passPlain = await addPass({ org: ORG_C, num: '305', sigur: 305, approvedAt: '2026-09-01 10:00' });
    await addEmployee(305, 305);
    await addEvent(305, '2026-10-05 08:00');
    // 306: не ходит дольше всех, но прошлый запуск упал на нём — в конце очереди.
    await addPass({ org: ORG_C, num: '306', sigur: 306, approvedAt: '2026-09-01 10:00', failedAt: '2026-10-25 04:10' });
    await addEmployee(306, 306);
    await addEvent(306, '2026-09-02 08:00');
    // 307: у прежнего держателя была автоблокировка, новый начинает с чистого состояния.
    await addPass({
      org: ORG_C, num: '307', sigur: 307, approvedAt: '2026-10-01 10:00', previousIdleBlockedAt: '2026-07-20 04:00',
    });
    await addEmployee(307, 307);
    // 308: держателя сменили, новый не одобрен: пропуск не активен, в списке и очереди нет.
    await addPass({
      org: ORG_C, num: '308', sigur: 308, approvedAt: null, active: false, status: 'blocked', previousIdleBlockedAt: '2026-07-20 04:00',
    });
    await addEmployee(308, 308);
    // 309: для перепроверки под блокировкой.
    passRecheck = await addPass({ org: ORG_C, num: '309', sigur: 309, approvedAt: '2026-09-01 10:00' });
    await addEmployee(309, 309);
    await addEvent(309, '2026-10-06 08:00');
    // 310: без Sigur-профиля — в очередь не идёт.
    await addPass({ org: ORG_C, num: '310', sigur: null as unknown as number, approvedAt: '2026-09-01 10:00' });
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

  describe('автоблокировка', () => {
    const orgCRows = async () => (await fetchIdleContractorPasses([ORG_C], TODAY))
      .map(r => ({
        pass_number: r.pass_number,
        days_idle: r.days_idle,
        last_event_date: r.last_event_date,
        idle_blocked_on: r.idle_blocked_on,
        blocked_manually: r.blocked_manually,
      }));
    const row = async (num: string) => (await orgCRows()).find(r => r.pass_number === num);

    it('заблокированные автоматически и вручную остаются в списке с отметкой', async () => {
      expect(await row('301')).toMatchObject({ idle_blocked_on: '2026-10-25', blocked_manually: false });
      expect(await row('302')).toMatchObject({ idle_blocked_on: null, blocked_manually: true });
      expect(await row('305')).toMatchObject({ idle_blocked_on: null, blocked_manually: false });
    });

    it('разблокировка в окне убирает из списка и очереди, в том числе без отметок', async () => {
      expect(await row('303')).toBeUndefined();
      const queue = await fetchIdleBlockCandidates(TODAY);
      expect(queue.map(r => r.pass_number)).not.toContain('303');
    });

    it('дни считаются от разблокировки, последний проход показывается настоящий', async () => {
      expect(await row('304')).toMatchObject({ days_idle: 6, last_event_date: '2026-10-01' });
    });

    it('очередь: без отметок и без Sigur-id, сортировка по дням, упавший — в конце', async () => {
      const queue = (await fetchIdleBlockCandidates(TODAY)).filter(r => r.org_department_id === ORG_C);
      expect(queue.map(r => ({ num: r.pass_number, days: r.days_idle }))).toEqual([
        { num: '307', days: 25 },
        { num: '305', days: 21 },
        { num: '309', days: 20 },
        { num: '304', days: 6 },
        { num: '306', days: 54 },
      ]);
    });

    it('очередь идёт по всем подрядчикам, сводка совпадает со списком', async () => {
      const queue = await fetchIdleBlockCandidates(TODAY);
      expect(new Set(queue.map(r => r.org_department_id))).toEqual(new Set([ORG_A, ORG_B, ORG_C]));
      const counts = await countIdlePassesByOrg([ORG_C], TODAY);
      expect(counts[0].idle_new).toBe((await fetchIdleContractorPasses([ORG_C], TODAY)).length);
    });

    it('перепроверка: держит тот же держатель и простой, иначе false', async () => {
      const holderId = await holderIdOf(passRecheck);
      const client = await pg.pool!.connect();
      try {
        await client.query('BEGIN');
        const input = { orgDepartmentId: ORG_C, passId: passRecheck, holderId };
        expect(await lockIdleBlockCandidate(client, input, TODAY)).toBe(true);
        expect(await lockIdleBlockCandidate(client, { ...input, holderId: '0' }, TODAY)).toBe(false);

        // Прошёл за время прогона.
        await client.query(
          `INSERT INTO skud_events (employee_id, event_at, event_date, direction)
           VALUES (309, '2026-10-26 07:00'::timestamp AT TIME ZONE 'Europe/Moscow', '2026-10-26', 'entry')`,
        );
        expect(await lockIdleBlockCandidate(client, input, TODAY)).toBe(false);
        await client.query('ROLLBACK');

        await client.query('BEGIN');
        await client.query(
          `INSERT INTO audit_logs (entity_type, entity_id, details)
           VALUES ('sigur_employee', '309', '{"action":"unblock"}')`,
        );
        await client.query(`UPDATE audit_logs SET created_at = '2026-10-26 07:00+03' WHERE entity_id = '309'`);
        expect(await lockIdleBlockCandidate(client, input, TODAY)).toBe(false);
        await client.query('ROLLBACK');

        // Отметка появилась у самого пропуска.
        await client.query('BEGIN');
        await client.query(`UPDATE contractor_pass_holders SET idle_blocked_at = now() WHERE id::text = $1`, [holderId]);
        expect(await lockIdleBlockCandidate(client, input, TODAY)).toBe(false);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('разблокировка возвращает активность и снимает отметки только у заблокированного пропуска', async () => {
      const client = await pg.pool!.connect();
      try {
        await client.query('BEGIN');
        await markContractorPassUnblocked(client, 301);
        await markContractorPassUnblocked(client, 305);
        const res = await client.query(
          `SELECT p.pass_number, p.is_active, h.idle_blocked_at, h.external_blocked_seen_at
             FROM contractor_passes p
             JOIN contractor_pass_holders h ON h.pass_id = p.id AND h.valid_until IS NULL
            WHERE p.id = ANY($1::uuid[])
            ORDER BY p.pass_number`,
          [[passAutoBlocked, passPlain]],
        );
        expect(res.rows).toEqual([
          { pass_number: '301', is_active: true, idle_blocked_at: null, external_blocked_seen_at: null },
          { pass_number: '305', is_active: true, idle_blocked_at: null, external_blocked_seen_at: null },
        ]);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });
  });

  it('пустой список организаций — без запроса', async () => {
    expect(await countIdlePassesByOrg([], TODAY)).toEqual([]);
    expect(await fetchIdleContractorPasses([], TODAY)).toEqual([]);
  });
});
