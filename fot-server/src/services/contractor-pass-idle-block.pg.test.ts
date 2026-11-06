import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// Автоблокировка целиком на настоящем PostgreSQL, замокан только Sigur: журнал, отметки, причина для
// карточки, откат и дыры в событиях живут в SQL. Запускается только при FOT_TEST_PG_URL — ПУСТАЯ БД.
// Таблицы — в своей схеме (search_path). В обычном прогоне пропускается.

const PG_URL = process.env.FOT_TEST_PG_URL;
const SCHEMA = 'contractor_pass_idle_block_pg_test';

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));
const sigur = vi.hoisted(() => ({
  blocked: new Map<number, boolean>(),
  blockCalls: [] as number[],
  unblockCalls: [] as number[],
}));

vi.mock('../config/postgres.js', async () => {
  const { Pool } = await import('pg');
  pg.pool = process.env.FOT_TEST_PG_URL
    ? new Pool({
      connectionString: process.env.FOT_TEST_PG_URL,
      options: '-c search_path=contractor_pass_idle_block_pg_test',
      max: 4,
    })
    : null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool.query(sql, params as unknown[]);
  };
  const withTransaction = async <T>(fn: (client: unknown) => Promise<T>): Promise<T> => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    const client = await pg.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await fn(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
  return {
    query: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows[0] ?? null,
    execute: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rowCount ?? 0,
    withTransaction,
  };
});
vi.mock('./sigur.service.js', () => ({
  sigurService: {
    getBackgroundConnectionType: async () => 'internal',
    getEmployeeById: async (id: number) => ({ isBlocked: sigur.blocked.get(id) ?? false }),
    blockEmployee: async (id: number) => { sigur.blocked.set(id, true); sigur.blockCalls.push(id); },
    unblockEmployee: async (id: number) => { sigur.blocked.set(id, false); sigur.unblockCalls.push(id); },
    invalidateEmployeeCache: () => undefined,
  },
}));
vi.mock('./sigur-live-admin.service.js', () => ({
  invalidateSigurDirectoryCaches: () => undefined,
}));
vi.mock('./contractor-pool.service.js', () => ({ isSigurNotFound: () => false }));
vi.mock('./blacklist.service.js', async () => {
  const { withTransaction } = await import('../config/postgres.js');
  return {
    BlacklistBlockedError: class extends Error {},
    withSigurProfileGuard: (_id: number, action: (client: never) => Promise<unknown>) => withTransaction(action),
  };
});

import { moscowTodayIso } from '../utils/date.utils.js';
import {
  isIdleBlockNightlyEnabled,
  runContractorPassIdleBlock,
  setIdleBlockNightlyEnabled,
} from './contractor-pass-idle-block.service.js';
import { rollbackContractorPassIdleRun } from './contractor-pass-idle-rollback.service.js';
import { countIdlePassesByOrg, fetchIdleContractorPasses } from './contractor-pass-idle.service.js';
import { getSigurEmployeeBlockInfo } from './sigur-employee-block.service.js';

const ORG = '00000000-0000-0000-0000-0000000000a1';
const TODAY = moscowTodayIso();

const sql = async (text: string, params?: unknown[]) => { await pg.pool!.query(text, params); };
const rows = async <T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> =>
  (await pg.pool!.query(text, params)).rows as T[];

/** МСК-дата n дней назад, YYYY-MM-DD. */
const daysAgo = (n: number): string => {
  const date = new Date(`${TODAY}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - n);
  return date.toISOString().slice(0, 10);
};

let seq = 0;
/** Пропуск с одобренным держателем и строкой сотрудника; последний проход — n дней назад. */
const addPass = async (lastEventDaysAgo: number | null, approvedDaysAgo = 200): Promise<{ id: string; sigurId: number; num: string }> => {
  seq += 1;
  const id = `00000000-0000-0000-0000-${String(seq).padStart(12, '0')}`;
  const sigurId = 1000 + seq;
  const num = String(seq);
  await sql(
    `INSERT INTO contractor_passes (id, org_department_id, pass_number, holder_name, sigur_employee_id, is_active, status)
     VALUES ($1, $2, $3, $4, $5, true, 'applied')`,
    [id, ORG, num, `Пропуск ${num}`, sigurId],
  );
  await sql(
    `INSERT INTO contractor_pass_holders (pass_id, holder_name, valid_until, approved_at)
     VALUES ($1, $2, NULL, ($3::date + time '10:00')::timestamp AT TIME ZONE 'Europe/Moscow')`,
    [id, `Держатель ${num}`, daysAgo(approvedDaysAgo)],
  );
  await sql('INSERT INTO employees (id, sigur_employee_id) VALUES ($1, $2)', [sigurId, sigurId]);
  if (lastEventDaysAgo != null) await addEvent(sigurId, daysAgo(lastEventDaysAgo));
  return { id, sigurId, num };
};

const addEvent = async (employeeId: number, day: string, time = '08:00'): Promise<void> => {
  await sql(
    `INSERT INTO skud_events (employee_id, event_at, event_date, direction)
     VALUES ($1, ($2::date + $3::time)::timestamp AT TIME ZONE 'Europe/Moscow', $2::date, 'entry')`,
    [employeeId, day, time],
  );
};

const passState = async (id: string) => (await rows<{
  is_active: boolean; idle_blocked_at: Date | null; external_blocked_seen_at: Date | null; idle_block_failed_at: Date | null;
}>(
  `SELECT p.is_active, h.idle_blocked_at, h.external_blocked_seen_at, h.idle_block_failed_at
     FROM contractor_passes p
     JOIN contractor_pass_holders h ON h.pass_id = p.id AND h.valid_until IS NULL
    WHERE p.id = $1`,
  [id],
))[0];

const auditFor = (sigurId: number) => rows<{ details: Record<string, unknown>; user_id: string | null }>(
  `SELECT details, user_id FROM audit_logs WHERE entity_type = 'sigur_employee' AND entity_id = $1 ORDER BY id`,
  [String(sigurId)],
);

describe.skipIf(!PG_URL)('автоблокировка на PostgreSQL', () => {
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
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pass_id uuid NOT NULL, holder_name text NOT NULL,
        valid_until date, approved_at timestamptz
      );
      CREATE TABLE employees (id integer PRIMARY KEY, sigur_employee_id bigint);
      CREATE TABLE skud_events (
        id bigserial PRIMARY KEY, employee_id integer, event_at timestamptz NOT NULL, event_date date NOT NULL,
        direction text NOT NULL, access_point text
      );
      CREATE TABLE audit_logs (
        id bigserial PRIMARY KEY, user_id uuid, action text, entity_type text, entity_id text, details jsonb,
        ip_address text, user_agent text, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE user_profiles (id uuid PRIMARY KEY, full_name text);
      CREATE TABLE system_settings (
        key text PRIMARY KEY, value text, description text, is_secret boolean NOT NULL DEFAULT false, updated_at timestamptz
      );
    `);
    // Настоящий файл миграции, дважды: идемпотентность.
    const { readFileSync } = await import('node:fs');
    const migration = readFileSync(new URL('../../../docs/migrations/349_contractor_pass_idle_block.sql', import.meta.url), 'utf-8');
    await pg.pool!.query(migration.replaceAll('public.', ''));
    await pg.pool!.query(migration.replaceAll('public.', ''));
    await sql(`INSERT INTO org_departments VALUES ($1, 'АЛЬЯНС ООО')`, [ORG]);
    // Фон событий: по 100 проходов за каждый из 5 дней у постороннего сотрудника.
    for (let day = 1; day <= 5; day += 1) {
      await sql(
        `INSERT INTO skud_events (employee_id, event_at, event_date, direction)
         SELECT 999, ($1::date + time '09:00')::timestamp AT TIME ZONE 'Europe/Moscow', $1::date, 'entry'
           FROM generate_series(1, 100)`,
        [daysAgo(day)],
      );
    }
  });

  afterAll(async () => {
    if (pg.pool) {
      await pg.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await pg.pool.end();
    }
  });

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    sigur.blocked.clear();
    sigur.blockCalls.length = 0;
    sigur.unblockCalls.length = 0;
    // Каждый тест — своя очередь.
    await sql('DELETE FROM contractor_pass_holders');
    await sql('DELETE FROM contractor_passes');
    await sql('DELETE FROM audit_logs');
    await sql('DELETE FROM employees');
    await sql('DELETE FROM skud_events WHERE employee_id <> 999');
  });

  it('миграция: выключатель по умолчанию выключен, включение и выключение пишут журнал', async () => {
    expect(await isIdleBlockNightlyEnabled()).toBe(false);
    await setIdleBlockNightlyEnabled(true);
    expect(await isIdleBlockNightlyEnabled()).toBe(true);
    await setIdleBlockNightlyEnabled(false);
    expect(await isIdleBlockNightlyEnabled()).toBe(false);
    const log = await rows<{ details: { value: boolean } }>(
      `SELECT details FROM audit_logs WHERE entity_type = 'system_setting' ORDER BY id`,
    );
    expect(log.map(row => row.details.value)).toEqual([true, false]);
  });

  it('полный цикл: причина для карточки, неактивен, в списке с отметкой, повторно не обрабатывается', async () => {
    const pass = await addPass(147);

    const first = await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'cli' });

    expect(first).toMatchObject({ status: 'completed', totalCandidates: 1, selected: 1, blocked: 1 });
    expect(sigur.blockCalls).toEqual([pass.sigurId]);
    const state = await passState(pass.id);
    expect(state.is_active).toBe(false);
    expect(state.idle_blocked_at).not.toBeNull();
    const info = await getSigurEmployeeBlockInfo(pass.sigurId);
    expect(info?.blockedByName).toBeNull();
    expect(info?.reason).toBe(
      `Автоблокировка: не ходит больше 5 дней (последний проход ${daysAgo(147).split('-').reverse().join('.')})`,
    );
    const [row] = await fetchIdleContractorPasses([ORG], TODAY);
    expect(row).toMatchObject({ pass_number: pass.num, idle_blocked_on: TODAY, blocked_manually: false, days_idle: 147 });
    expect(await countIdlePassesByOrg([ORG], TODAY)).toEqual([{ org_department_id: ORG, idle_new: 1 }]);

    const second = await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'cli' });
    expect(second).toMatchObject({ totalCandidates: 0, blocked: 0 });
    expect(sigur.blockCalls).toHaveLength(1);
  });

  it('ни разу не ходил: причина от даты выдачи', async () => {
    const pass = await addPass(null, 148);

    await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'cli' });

    expect((await getSigurEmployeeBlockInfo(pass.sigurId))?.reason).toBe(
      `Автоблокировка: не ходит больше 5 дней (проходов не было, выдан ${daysAgo(148).split('-').reverse().join('.')})`,
    );
  });

  it('ручная причина остаётся, автоблокировкой не считается', async () => {
    const pass = await addPass(30);
    sigur.blocked.set(pass.sigurId, true);
    await sql(
      `INSERT INTO audit_logs (entity_type, entity_id, details, created_at)
       VALUES ('sigur_employee', $1, '{"action":"block","reason":"отсутствие более 5 дней"}', now() - interval '20 days')`,
      [String(pass.sigurId)],
    );

    const result = await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'cli' });

    expect(result).toMatchObject({ alreadyManual: 1, blocked: 0, reasonAdded: 0 });
    expect(sigur.blockCalls).toEqual([]);
    expect((await getSigurEmployeeBlockInfo(pass.sigurId))?.reason).toBe('отсутствие более 5 дней');
    const state = await passState(pass.id);
    expect(state.is_active).toBe(false);
    expect(state.idle_blocked_at).toBeNull();
    expect(state.external_blocked_seen_at).not.toBeNull();
    const [row] = await fetchIdleContractorPasses([ORG], TODAY);
    expect(row).toMatchObject({ idle_blocked_on: null, blocked_manually: true });
  });

  it('сбой Sigur откатывает журнал и отметки, у пропуска остаётся метка ошибки', async () => {
    const pass = await addPass(30);
    const { sigurService } = await import('./sigur.service.js');
    const spy = vi.spyOn(sigurService, 'blockEmployee').mockRejectedValueOnce(new Error('Sigur down'));

    const result = await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'cli' });

    expect(result.failed).toHaveLength(1);
    expect(await auditFor(pass.sigurId)).toEqual([]);
    const state = await passState(pass.id);
    expect(state.is_active).toBe(true);
    expect(state.idle_blocked_at).toBeNull();
    expect(state.idle_block_failed_at).not.toBeNull();
    spy.mockRestore();

    const retried = await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'cli' });
    expect(retried.blocked).toBe(1);
    expect((await passState(pass.id)).idle_block_failed_at).toBeNull();
  });

  it('сверка: разблокирован в Sigur и прошёл — снова активен, запись в журнале, в очередь не попадает', async () => {
    const pass = await addPass(30);
    await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'cli' });

    // Разблокировали мимо портала, человек сегодня прошёл. Запрос сверки ищет проход после отметки.
    sigur.blocked.set(pass.sigurId, false);
    await sql(
      `UPDATE contractor_pass_holders SET idle_blocked_at = now() - interval '2 hours' WHERE pass_id = $1`,
      [pass.id],
    );
    await sql(
      `INSERT INTO skud_events (employee_id, event_at, event_date, direction)
       VALUES ($1, now() - interval '1 hour', (now() - interval '1 hour') AT TIME ZONE 'Europe/Moscow', 'entry')`,
      [pass.sigurId],
    );
    await sql(
      `UPDATE audit_logs SET created_at = now() - interval '3 hours' WHERE entity_id = $1`,
      [String(pass.sigurId)],
    );

    const result = await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'scheduler' });

    expect(result).toMatchObject({ restored: 1, totalCandidates: 0, blocked: 0 });
    const state = await passState(pass.id);
    expect(state.is_active).toBe(true);
    expect(state.idle_blocked_at).toBeNull();
    expect((await auditFor(pass.sigurId)).at(-1)?.details).toMatchObject({ action: 'unblock', source: 'sigur_direct' });
  });

  it('заблокирован и не ходит: сверка ничего не меняет, запрос не трогает Sigur', async () => {
    const pass = await addPass(30);
    await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'cli' });

    const result = await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'scheduler' });

    expect(result.restored).toBe(0);
    expect((await passState(pass.id)).is_active).toBe(false);
  });

  it('откат: снимает только свой run_id, новые 5 дней, повтор безопасен', async () => {
    const own = await addPass(30);
    const firstRun = await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'cli' });
    const other = await addPass(40);
    await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'cli' });

    const dry = await rollbackContractorPassIdleRun({ runId: firstRun.runId, dryRun: true });
    expect(dry).toMatchObject({ total: 1, unblocked: 1 });
    expect(sigur.unblockCalls).toEqual([]);
    expect((await passState(own.id)).is_active).toBe(false);

    const rolledBack = await rollbackContractorPassIdleRun({ runId: firstRun.runId, dryRun: false });
    expect(rolledBack).toMatchObject({ total: 1, unblocked: 1 });
    expect(sigur.unblockCalls).toEqual([own.sigurId]);
    expect((await passState(own.id)).is_active).toBe(true);
    expect((await passState(other.id)).is_active).toBe(false);
    expect((await auditFor(own.sigurId)).at(-1)?.details).toMatchObject({
      action: 'unblock', source: 'contractor_pass_idle_rollback', run_id: firstRun.runId,
    });

    // Снятый не становится кандидатом: разблокировка в окне 5 дней.
    expect((await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'cli' })).totalCandidates).toBe(0);

    const again = await rollbackContractorPassIdleRun({ runId: firstRun.runId, dryRun: false });
    expect(again.unblocked).toBe(0);
    expect(again.skipped.later_action).toEqual([own.num]);
    expect(sigur.unblockCalls).toHaveLength(1);
  });

  it('откат: ручная разблокировка и смена держателя после партии — не трогаем', async () => {
    const manual = await addPass(30);
    const moved = await addPass(40);
    const run = await runContractorPassIdleBlock({ dryRun: false, triggeredBy: 'cli' });
    await sql(
      `INSERT INTO audit_logs (entity_type, entity_id, details, created_at)
       VALUES ('sigur_employee', $1, '{"action":"unblock"}', now() + interval '1 second')`,
      [String(manual.sigurId)],
    );
    await sql(
      `UPDATE contractor_pass_holders SET valid_until = $2::date WHERE pass_id = $1`,
      [moved.id, TODAY],
    );

    const result = await rollbackContractorPassIdleRun({ runId: run.runId, dryRun: false });

    expect(result.unblocked).toBe(0);
    expect(result.skipped.later_action).toEqual([manual.num]);
    expect(result.skipped.holder_changed).toEqual([moved.num]);
    expect(sigur.unblockCalls).toEqual([]);
  });

  it('день без единой строки: стоп, force не снимает', async () => {
    await addPass(30);
    const gapDay = daysAgo(3);
    const saved = await rows('SELECT event_at, event_date, direction FROM skud_events WHERE event_date = $1', [gapDay]);
    await sql('DELETE FROM skud_events WHERE event_date = $1', [gapDay]);

    const result = await runContractorPassIdleBlock({ dryRun: false, force: true, triggeredBy: 'cli' });

    expect(result.status).toBe('events_gap');
    expect(result.eventGaps).toEqual([{ day: gapDay, events: 0 }]);
    expect(sigur.blockCalls).toEqual([]);

    // Вернуть фон для остальных тестов.
    for (let i = 0; i < saved.length; i += 1) {
      await sql(
        `INSERT INTO skud_events (employee_id, event_at, event_date, direction) VALUES (999, $1, $2, 'entry')`,
        [saved[i].event_at, saved[i].event_date],
      );
    }
  });
});
