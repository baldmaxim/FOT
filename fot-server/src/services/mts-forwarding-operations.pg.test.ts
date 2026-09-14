import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

// SQL-семантика операций переадресации на настоящем PostgreSQL: частичный UNIQUE,
// атомарные переходы, аренда. Запускается только при FOT_TEST_PG_URL — пустая
// тестовая БД с применённой миграцией 276 (и заглушками mts_business_accounts /
// mts_business_number_map). В обычном прогоне пропускается.

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../config/postgres.js', async () => {
  const { Pool } = await import('pg');
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 10 }) : null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool.query(sql, params as unknown[]);
  };
  return {
    query: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows[0] ?? null,
    execute: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rowCount ?? 0,
  };
});

import { mtsForwardingOperationsService as ops, type IReserveInput } from './mts-forwarding-operations.service.js';

const MSISDN = '79150000001';
let accountId = '';

const input = (over: Partial<IReserveInput> = {}): IReserveInput => ({
  accountId, msisdn: MSISDN, employeeId: 42, requestedBy: '00000000-0000-0000-0000-000000000001',
  forwardingType: 'CFU', target: '79161234567', noReplyTimer: null,
  initialState: 'service_reserved', deadlineSeconds: 3600, ...over,
});

describe.skipIf(!PG_URL)('mts_forwarding_operations на PostgreSQL', () => {
  beforeAll(async () => {
    const row = await pg.pool!.query<{ id: string }>('INSERT INTO mts_business_accounts DEFAULT VALUES RETURNING id');
    accountId = row.rows[0].id;
  });
  beforeEach(async () => {
    await pg.pool!.query('DELETE FROM mts_forwarding_operations');
  });
  afterAll(async () => {
    await pg.pool?.end();
  });

  it('10 параллельных reserve → ровно одна created=true, все видят одну строку', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => ops.reserve(input())));
    expect(results.filter(r => r.created)).toHaveLength(1);
    expect(new Set(results.map(r => r.operation.id)).size).toBe(1);
    expect(results[0].operation.target).toBe('79161234567');
  });

  it('unconfirmed держит номер; failed/expired — освобождают', async () => {
    const { operation } = await ops.reserve(input());
    await ops.transition(operation.id, ['service_reserved'], { state: 'unconfirmed' });
    expect((await ops.reserve(input())).created).toBe(false);

    await ops.transition(operation.id, ['unconfirmed'], { state: 'expired' });
    const next = await ops.reserve(input());
    expect(next.created).toBe(true);
    expect((await ops.getById(operation.id))?.finishedAt).not.toBeNull();
  });

  it('параллельный claimSend разными владельцами → выигрывает один', async () => {
    const { operation } = await ops.reserve(input());
    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      ops.claimSend(operation.id, 'service_reserved', 'service_sending', `owner-${i}`)));
    const won = claims.filter(Boolean);
    expect(won).toHaveLength(1);
    expect(won[0]?.sendStartedAt).not.toBeNull();
  });

  it('transition с чужим владельцем аренды не проходит', async () => {
    const { operation } = await ops.reserve(input());
    await ops.claimSend(operation.id, 'service_reserved', 'service_sending', 'owner-a');
    expect(await ops.transition(operation.id, ['service_sending'], { state: 'failed' }, 'owner-b')).toBeNull();
    expect((await ops.transition(operation.id, ['service_sending'], { state: 'service_accepted', serviceEventId: 'EV', lease: null }, 'owner-a'))?.state)
      .toBe('service_accepted');
  });

  it('claimDue двух воркеров одновременно не выдаёт одну строку дважды', async () => {
    for (let i = 0; i < 6; i++) {
      await ops.reserve(input({ msisdn: `7915000010${i}` }));
    }
    await pg.pool!.query(`UPDATE mts_forwarding_operations SET next_check_at = NOW() - INTERVAL '1 minute'`);
    const [a, b] = await Promise.all([ops.claimDue('w1', 10, 120), ops.claimDue('w2', 10, 120)]);
    const ids = [...a, ...b].map(o => o.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    // Аренда живая — повторный claimDue ничего не берёт.
    expect(await ops.claimDue('w3', 10, 120)).toHaveLength(0);
  });

  it('recoverStale: зависшая отправка → сверка, живая аренда не трогается', async () => {
    const stale = (await ops.reserve(input())).operation;
    const live = (await ops.reserve(input({ msisdn: '79150000009', initialState: 'rule_ready' }))).operation;
    await ops.claimSend(stale.id, 'service_reserved', 'service_sending', 'dead');
    await ops.claimSend(live.id, 'rule_ready', 'rule_sending', 'alive');
    await pg.pool!.query(`UPDATE mts_forwarding_operations SET lease_until = NOW() - INTERVAL '1 second' WHERE id = $1`, [stale.id]);

    expect(await ops.recoverStale()).toBe(1);
    expect((await ops.getById(stale.id))?.state).toBe('service_unknown');
    expect((await ops.getById(live.id))?.state).toBe('rule_sending');
    expect((await ops.getById(live.id))?.ruleAttempts).toBe(1);
  });

  it('getActiveOrRecent: активная важнее более свежей завершённой', async () => {
    const first = (await ops.reserve(input())).operation;
    await ops.transition(first.id, ['service_reserved'], { state: 'failed', error: { code: '400', message: 'нет' } });
    const second = (await ops.reserve(input())).operation;
    const got = await ops.getActiveOrRecent(MSISDN);
    expect(got?.id).toBe(second.id);
    await ops.transition(second.id, ['service_reserved'], { state: 'rule_confirmed', confirmedRules: [{ forwardingType: 'CFU' }] });
    expect((await ops.getById(second.id))?.confirmedRules).toEqual([{ forwardingType: 'CFU' }]);
  });
});
