import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

// SQL-семантика операций переадресации на настоящем PostgreSQL: частичный UNIQUE,
// атомарные переходы, аренда, поколение/действие, квота, транзакционная фиксация
// результата. Запускается только при FOT_TEST_PG_URL — пустая тестовая БД с
// миграциями 276 и 278 и заглушками mts_business_accounts, mts_business_number_map,
// audit_logs, mts_business_metric_snapshot. В обычном прогоне пропускается.

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../config/postgres.js', async () => {
  const { Pool } = await import('pg');
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 20 }) : null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool.query(sql, params as unknown[]);
  };
  return {
    query: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows[0] ?? null,
    execute: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rowCount ?? 0,
    withTransaction: async <T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> => {
      if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
      const client = await pg.pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
});

import { mtsForwardingOperationsService as ops, type IReserveInput } from './mts-forwarding-operations.service.js';
import { mtsBusinessMetricsStoreService } from './mts-business-metrics-store.service.js';
import { auditService } from './audit.service.js';

const MSISDN = '79150000001';
const USER = '00000000-0000-0000-0000-000000000001';
let accountId = '';

const input = (over: Partial<IReserveInput> = {}): IReserveInput => ({
  kind: 'set', accountId, msisdn: MSISDN, employeeId: 42, requestedBy: USER,
  forwardingType: 'CFU', target: '79161234567', noReplyTimer: null,
  initialState: 'service_reserved', deadlineSeconds: 3600, ...over,
});

const count = async (table: string): Promise<number> =>
  Number((await pg.pool!.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${table}`)).rows[0].n);

describe.skipIf(!PG_URL)('mts_forwarding_operations на PostgreSQL', () => {
  beforeAll(async () => {
    const row = await pg.pool!.query<{ id: string }>('INSERT INTO mts_business_accounts DEFAULT VALUES RETURNING id');
    accountId = row.rows[0].id;
  });
  beforeEach(async () => {
    await pg.pool!.query('DELETE FROM mts_forwarding_operations');
    await pg.pool!.query('DELETE FROM audit_logs');
    await pg.pool!.query('DELETE FROM mts_business_metric_snapshot');
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

  it('включение и отключение одновременно по номеру → создаётся ровно одна операция', async () => {
    const [a, b] = await Promise.all([
      ops.reserve(input({ initialState: 'rule_ready' })),
      ops.reserve(input({ kind: 'remove', target: null, initialState: 'rule_ready' })),
    ]);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(a.operation.id).toBe(b.operation.id);
  });

  it('remove без номера назначения допустим, set без номера — CHECK отклоняет', async () => {
    const remove = await ops.reserve(input({ kind: 'remove', target: null, initialState: 'rule_ready' }));
    expect(remove.operation).toMatchObject({ kind: 'remove', target: null });
    await pg.pool!.query('DELETE FROM mts_forwarding_operations');
    await expect(ops.reserve(input({ target: null }))).rejects.toThrow(/mts_forwarding_operations_kind_chk/);
  });

  it('CHECK пропускает новые состояния снятия и отклоняет неизвестное действие', async () => {
    const { operation } = await ops.reserve(input({ initialState: 'rule_ready' }));
    const claimed = await ops.claimSend(operation.id, 'rule_ready', 'rule_clear_sending', 'w', 'delete:CFU');
    expect(claimed).toMatchObject({ state: 'rule_clear_sending', ruleAction: 'delete:CFU', sendGeneration: 1, ruleAttempts: 1 });
    await expect(pg.pool!.query(`UPDATE mts_forwarding_operations SET rule_action = 'delete:CFB' WHERE id = $1`, [operation.id]))
      .rejects.toThrow(/rule_action_chk/);
  });

  it('unconfirmed держит номер; failed/expired — освобождают', async () => {
    const { operation } = await ops.reserve(input());
    await ops.transition(operation.id, ['service_reserved'], { state: 'unconfirmed', unconfirmedFrom: 'service_unknown' });
    expect((await ops.reserve(input())).created).toBe(false);
    expect((await ops.getById(operation.id))?.unconfirmedFrom).toBe('service_unknown');

    await ops.transition(operation.id, ['unconfirmed'], { state: 'expired' });
    expect((await ops.reserve(input())).created).toBe(true);
    expect((await ops.getById(operation.id))?.finishedAt).not.toBeNull();
  });

  it('параллельный claimSend разными владельцами → выигрывает один, поколение +1', async () => {
    const { operation } = await ops.reserve(input());
    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      ops.claimSend(operation.id, 'service_reserved', 'service_sending', `owner-${i}`)));
    const won = claims.filter(Boolean);
    expect(won).toHaveLength(1);
    expect(won[0]).toMatchObject({ sendGeneration: 1, ruleAttempts: 0 });
    expect(won[0]?.sendStartedAt).not.toBeNull();
  });

  it('transition с guard: чужой владелец, другое поколение или действие — не проходит', async () => {
    const { operation } = await ops.reserve(input({ initialState: 'rule_ready' }));
    const claimed = (await ops.claimSend(operation.id, 'rule_ready', 'rule_clear_sending', 'owner-a', 'delete:CFU'))!;
    const patch = { state: 'rule_clear_verifying' as const, lease: null };

    expect(await ops.transition(operation.id, ['rule_clear_sending'], patch, { owner: 'owner-b' })).toBeNull();
    expect(await ops.transition(operation.id, ['rule_clear_sending'], patch, { expect: { generation: 0, action: 'delete:CFU' } })).toBeNull();
    expect(await ops.transition(operation.id, ['rule_clear_sending'], patch, { expect: { generation: 1, action: null } })).toBeNull();
    const ok = await ops.transition(operation.id, ['rule_clear_sending'], patch,
      { owner: 'owner-a', expect: { generation: claimed.sendGeneration, action: 'delete:CFU' } });
    expect(ok?.state).toBe('rule_clear_verifying');
  });

  it('commit со старым поколением: ни перехода, ни снимка, ни аудита; с актуальным — ровно по одной записи', async () => {
    const { operation } = await ops.reserve(input({ initialState: 'rule_ready' }));
    await ops.claimSend(operation.id, 'rule_ready', 'rule_clear_sending', 'w', 'delete:CFU');
    await ops.transition(operation.id, ['rule_clear_sending'], { state: 'rule_clear_verifying', lease: null });
    const writes = async (client: import('pg').PoolClient) => {
      await mtsBusinessMetricsStoreService.upsertSnapshotWithClient(client, {
        accountId, scope: 'msisdn', msisdn: MSISDN, metric: 'forwarding', payload: [],
      });
      await auditService.logWithClient(client, { user_id: USER, action: 'MTS_BUSINESS_FORWARDING_REMOVE_REQUESTED', details: { type: 'CFU' } });
    };
    const patch = { state: 'rule_ready' as const, ruleAction: null, resetRuleAttempts: true };

    const stale = await ops.commit(operation.id, ['rule_clear_verifying'], patch, { expect: { generation: 0, action: 'delete:CFU' } }, writes);
    expect(stale).toBeNull();
    expect(await count('mts_business_metric_snapshot')).toBe(0);
    expect(await count('audit_logs')).toBe(0);
    expect((await ops.getById(operation.id))?.state).toBe('rule_clear_verifying');

    const fresh = await ops.commit(operation.id, ['rule_clear_verifying'], patch, { expect: { generation: 1, action: 'delete:CFU' } }, writes);
    expect(fresh).toMatchObject({ state: 'rule_ready', ruleAction: null, ruleAttempts: 0 });
    expect(await count('mts_business_metric_snapshot')).toBe(1);
    expect(await count('audit_logs')).toBe(1);
  });

  it('commit: упали записи → переход откатывается', async () => {
    const { operation } = await ops.reserve(input({ initialState: 'rule_ready' }));
    await expect(ops.commit(operation.id, ['rule_ready'], { state: 'done' }, {}, async client => {
      await client.query('SELECT 1/0');
    })).rejects.toThrow();
    expect((await ops.getById(operation.id))?.state).toBe('rule_ready');
  });

  it('квота: 10 параллельных операций одного пользователя при max=5 → засчитано ровно 5; повтор той же не расходует', async () => {
    const created = [];
    for (let i = 0; i < 10; i++) created.push((await ops.reserve(input({ msisdn: `791500001${String(i).padStart(2, '0')}` }))).operation);
    const results = await Promise.all(created.map(op => ops.consumeQuota(op.id, USER, 5, 3600)));
    expect(results.filter(Boolean)).toHaveLength(5);

    const counted = created.find((_, i) => results[i])!;
    expect(await ops.consumeQuota(counted.id, USER, 5, 3600)).toBe(true);
    const rows = await pg.pool!.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM mts_forwarding_operations WHERE quota_counted_at IS NOT NULL`);
    expect(Number(rows.rows[0].n)).toBe(5);
  });

  it('квота общая для включения и отключения', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const kind = i % 2 === 0 ? 'set' : 'remove';
      const { operation } = await ops.reserve(input({
        kind, target: kind === 'set' ? '79161234567' : null, msisdn: `791500002${i}`, initialState: 'rule_ready',
      }));
      ids.push(operation.id);
    }
    const results = [];
    for (const id of ids) results.push(await ops.consumeQuota(id, USER, 5, 3600));
    expect(results).toEqual([true, true, true, true, true, false]);
  });

  it('claimDue двух воркеров одновременно не выдаёт одну строку дважды; берёт rule_clear_verifying', async () => {
    for (let i = 0; i < 6; i++) await ops.reserve(input({ msisdn: `7915000010${i}` }));
    await pg.pool!.query(`UPDATE mts_forwarding_operations SET next_check_at = NOW() - INTERVAL '1 minute'`);
    await pg.pool!.query(`UPDATE mts_forwarding_operations SET state = 'rule_clear_verifying' WHERE ctid IN (SELECT ctid FROM mts_forwarding_operations LIMIT 1)`);
    const [a, b] = await Promise.all([ops.claimDue('w1', 10, 120), ops.claimDue('w2', 10, 120)]);
    const ids = [...a, ...b].map(o => o.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    expect([...a, ...b].some(o => o.state === 'rule_clear_verifying')).toBe(true);
    expect(await ops.claimDue('w3', 10, 120)).toHaveLength(0);
  });

  it('recoverStale: зависшие отправки → сверка (включая снятие), живая аренда не трогается', async () => {
    const stale = (await ops.reserve(input())).operation;
    const clear = (await ops.reserve(input({ msisdn: '79150000008', initialState: 'rule_ready' }))).operation;
    const live = (await ops.reserve(input({ msisdn: '79150000009', initialState: 'rule_ready' }))).operation;
    await ops.claimSend(stale.id, 'service_reserved', 'service_sending', 'dead');
    await ops.claimSend(clear.id, 'rule_ready', 'rule_clear_sending', 'dead', 'delete:CFU');
    await ops.claimSend(live.id, 'rule_ready', 'rule_sending', 'alive');
    await pg.pool!.query(`UPDATE mts_forwarding_operations SET lease_until = NOW() - INTERVAL '1 second' WHERE id = ANY($1)`, [[stale.id, clear.id]]);

    expect(await ops.recoverStale()).toBe(2);
    expect((await ops.getById(stale.id))?.state).toBe('service_unknown');
    expect(await ops.getById(clear.id)).toMatchObject({ state: 'rule_clear_verifying', ruleAction: 'delete:CFU', sendGeneration: 1 });
    expect((await ops.getById(live.id))?.state).toBe('rule_sending');
  });

  it('getActiveOrRecent: активная важнее более свежей завершённой', async () => {
    const first = (await ops.reserve(input())).operation;
    await ops.transition(first.id, ['service_reserved'], { state: 'failed', error: { code: '400', message: 'нет' } });
    const second = (await ops.reserve(input())).operation;
    expect((await ops.getActiveOrRecent(MSISDN))?.id).toBe(second.id);
    await ops.transition(second.id, ['service_reserved'], { state: 'rule_confirmed', confirmedRules: [{ forwardingType: 'CFU' }] });
    expect((await ops.getById(second.id))?.confirmedRules).toEqual([{ forwardingType: 'CFU' }]);
  });
});
