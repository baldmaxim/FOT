import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pgQuery, pgQueryOne, pgExecute, pgTx } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  pgExecute: vi.fn(),
  pgTx: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: pgExecute,
  withTransaction: pgTx,
}));

import {
  dataApiKeyService,
  generateRawToken,
  hashSecret,
  parseToken,
} from './data-api-key.service.js';

beforeEach(() => {
  pgQuery.mockReset();
  pgQueryOne.mockReset();
  pgExecute.mockReset();
  pgTx.mockReset();
});

describe('token format & hashing', () => {
  it('генерирует токен в формате fot_<16-hex>_<48-hex>', () => {
    const { plaintext_token, prefix, secret } = generateRawToken();
    expect(plaintext_token).toMatch(/^fot_[0-9a-f]{16}_[0-9a-f]{48}$/);
    expect(prefix).toHaveLength(16);
    expect(secret).toHaveLength(48);
  });

  it('parseToken возвращает prefix+secret для валидного токена', () => {
    const { plaintext_token, prefix, secret } = generateRawToken();
    expect(parseToken(plaintext_token)).toEqual({ prefix, secret });
  });

  it('parseToken отдаёт null на мусоре', () => {
    expect(parseToken('not-a-token')).toBeNull();
    expect(parseToken('fot_short_x')).toBeNull();
  });

  it('hashSecret использует SHA-256, не bcrypt', () => {
    const secret = 'a'.repeat(48);
    const expected = crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
    const hash = hashSecret(secret);
    expect(hash).toBe(expected);
    expect(hash).toHaveLength(64); // 32 bytes -> 64 hex chars
    expect(hash).not.toMatch(/^\$2[aby]\$/); // не bcrypt
  });
});

describe('createKey', () => {
  it('пишет sha256(key_hash) и 16-hex key_prefix в БД', async () => {
    pgQueryOne.mockResolvedValueOnce({ id: 'key-id-1' });
    const result = await dataApiKeyService.createKey({
      name: 'test',
      created_by: 'user-1',
    });

    expect(result.plaintext_token).toMatch(/^fot_[0-9a-f]{16}_[0-9a-f]{48}$/);
    expect(result.prefix).toHaveLength(16);

    const [sql, params] = pgQueryOne.mock.calls[0];
    expect(sql).toMatch(/^INSERT INTO data_api_keys/);
    // params: [name, description, prefix, hash, rate_limit, expires_at, created_by]
    expect(params[2]).toHaveLength(16); // key_prefix
    expect(params[3]).toHaveLength(64); // sha256 hex length
    expect(params[3]).not.toMatch(/^\$2[aby]\$/); // не bcrypt
    expect(params[6]).toBe('user-1');
  });
});

describe('replaceKeyTables', () => {
  it('оборачивает DELETE+INSERT в withTransaction для атомарности', async () => {
    pgTx.mockImplementation(async (fn) => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
      return fn(client as never);
    });

    await dataApiKeyService.replaceKeyTables('key-1', [
      { table_name: 'employees', allowed_fields: ['id', 'full_name'] },
      { table_name: 'org_departments', allowed_fields: ['*'] },
    ]);

    expect(pgTx).toHaveBeenCalledOnce();
  });

  it('пустой entries — только DELETE, без INSERT', async () => {
    const clientQuery = vi.fn().mockResolvedValue({ rows: [] });
    pgTx.mockImplementation(async (fn) => fn({ query: clientQuery } as never));

    await dataApiKeyService.replaceKeyTables('key-1', []);

    expect(clientQuery).toHaveBeenCalledTimes(1);
    expect(clientQuery.mock.calls[0][0]).toMatch(/^DELETE FROM data_api_key_tables/);
  });

  it('вставляет по строке на таблицу; allowed_fields — одномерный массив (регрессия 2-D unnest)', async () => {
    const clientQuery = vi.fn().mockResolvedValue({ rows: [] });
    pgTx.mockImplementation(async (fn) => fn({ query: clientQuery } as never));

    // Разное число полей у таблиц ломало прежний unnest($::text[][]).
    await dataApiKeyService.replaceKeyTables('key-1', [
      { table_name: 'employees', allowed_fields: ['id', 'full_name', 'email'] },
      { table_name: 'org_departments', allowed_fields: ['id'] },
    ]);

    // 1 DELETE + по 1 INSERT на таблицу
    expect(clientQuery).toHaveBeenCalledTimes(3);
    expect(clientQuery.mock.calls[0][0]).toMatch(/^DELETE FROM data_api_key_tables/);

    const inserts = clientQuery.mock.calls.slice(1);
    for (const [sql] of inserts) {
      expect(sql).toMatch(/^INSERT INTO data_api_key_tables/);
    }
    // Каждый INSERT: [keyId, table_name, string[]] — поля плоским массивом, не 2-D.
    expect(inserts[0][1]).toEqual(['key-1', 'employees', ['id', 'full_name', 'email']]);
    expect(inserts[1][1]).toEqual(['key-1', 'org_departments', ['id']]);
    expect(Array.isArray(inserts[0][1][2])).toBe(true);
    expect(Array.isArray(inserts[0][1][2][0])).toBe(false);
  });
});

describe('revokeKey', () => {
  it('идемпотентный UPDATE с WHERE revoked_at IS NULL', async () => {
    pgExecute.mockResolvedValueOnce(1);
    await dataApiKeyService.revokeKey('key-1');
    const [sql, params] = pgExecute.mock.calls[0];
    expect(sql).toMatch(/revoked_at IS NULL/);
    expect(params[0]).toBe('key-1');
  });
});
