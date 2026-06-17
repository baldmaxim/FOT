import crypto from 'node:crypto';
import { execute, query, queryOne, withTransaction } from '../config/postgres.js';

// Формат токена: fot_<16-hex-prefix>_<48-hex-secret>.
// Префикс хранится в открытом виде (UNIQUE-индекс для быстрого lookup),
// секрет — только в виде sha256-хеша. Энтропии 24 байт достаточно, чтобы
// SHA-256 был приемлемой защитой при утечке БД (полный токен — 192 бит).
const PREFIX_BYTES = 8;
const SECRET_BYTES = 24;
const TOKEN_RE = /^fot_([0-9a-f]{16})_([0-9a-f]{48})$/;

export interface DataApiKeyRow {
  id: string;
  name: string;
  description: string | null;
  key_prefix: string;
  key_hash: string;
  rate_limit_per_minute: number;
  created_by: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface CreateKeyInput {
  name: string;
  description?: string | null;
  rate_limit_per_minute?: number;
  expires_at?: string | null;
  created_by: string;
}

export interface CreateKeyResult {
  id: string;
  plaintext_token: string;
  prefix: string;
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

export function generateRawToken(): { plaintext_token: string; prefix: string; secret: string } {
  const prefix = crypto.randomBytes(PREFIX_BYTES).toString('hex');
  const secret = crypto.randomBytes(SECRET_BYTES).toString('hex');
  return {
    plaintext_token: `fot_${prefix}_${secret}`,
    prefix,
    secret,
  };
}

export function parseToken(raw: string): { prefix: string; secret: string } | null {
  const match = TOKEN_RE.exec(raw.trim());
  if (!match) return null;
  return { prefix: match[1], secret: match[2] };
}

export function hashSecret(secret: string): string {
  return sha256Hex(secret);
}

const KEY_PUBLIC_COLS =
  'id, name, description, key_prefix, rate_limit_per_minute, created_by, created_at, expires_at, revoked_at, last_used_at';

export const dataApiKeyService = {
  async createKey(input: CreateKeyInput): Promise<CreateKeyResult> {
    const { plaintext_token, prefix, secret } = generateRawToken();
    let row: { id: string } | null;
    try {
      row = await queryOne<{ id: string }>(
        `INSERT INTO data_api_keys
           (name, description, key_prefix, key_hash, rate_limit_per_minute, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          input.name,
          input.description ?? null,
          prefix,
          hashSecret(secret),
          input.rate_limit_per_minute ?? 60,
          input.expires_at ?? null,
          input.created_by,
        ],
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      throw new Error(`Failed to create API key: ${msg}`);
    }

    if (!row) {
      throw new Error('Failed to create API key: unknown');
    }

    return { id: row.id, plaintext_token, prefix };
  },

  async listKeys(): Promise<Array<Omit<DataApiKeyRow, 'key_hash'>>> {
    try {
      return await query<Omit<DataApiKeyRow, 'key_hash'>>(
        `SELECT ${KEY_PUBLIC_COLS}
           FROM data_api_keys
          ORDER BY created_at DESC`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      throw new Error(`Failed to list API keys: ${msg}`);
    }
  },

  async getKey(id: string): Promise<Omit<DataApiKeyRow, 'key_hash'> | null> {
    try {
      return await queryOne<Omit<DataApiKeyRow, 'key_hash'>>(
        `SELECT ${KEY_PUBLIC_COLS}
           FROM data_api_keys
          WHERE id = $1`,
        [id],
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      throw new Error(`Failed to load API key: ${msg}`);
    }
  },

  async updateKey(
    id: string,
    patch: Partial<Pick<DataApiKeyRow, 'name' | 'description' | 'rate_limit_per_minute' | 'expires_at'>>,
  ): Promise<void> {
    const setClauses: string[] = [];
    const params: unknown[] = [];
    const addParam = (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    };

    if (patch.name !== undefined) setClauses.push(`name = ${addParam(patch.name)}`);
    if (patch.description !== undefined) setClauses.push(`description = ${addParam(patch.description)}`);
    if (patch.rate_limit_per_minute !== undefined)
      setClauses.push(`rate_limit_per_minute = ${addParam(patch.rate_limit_per_minute)}`);
    if (patch.expires_at !== undefined) setClauses.push(`expires_at = ${addParam(patch.expires_at)}`);

    if (setClauses.length === 0) return;

    const idPlaceholder = addParam(id);
    try {
      await execute(
        `UPDATE data_api_keys SET ${setClauses.join(', ')} WHERE id = ${idPlaceholder}`,
        params,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      throw new Error(`Failed to update API key: ${msg}`);
    }
  },

  async revokeKey(id: string): Promise<void> {
    try {
      await execute(
        `UPDATE data_api_keys SET revoked_at = now()
          WHERE id = $1 AND revoked_at IS NULL`,
        [id],
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      throw new Error(`Failed to revoke API key: ${msg}`);
    }
  },

  async getKeyTables(keyId: string): Promise<Array<{ table_name: string; allowed_fields: string[] }>> {
    try {
      return await query<{ table_name: string; allowed_fields: string[] }>(
        `SELECT table_name, allowed_fields
           FROM data_api_key_tables
          WHERE key_id = $1
          ORDER BY table_name ASC`,
        [keyId],
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      throw new Error(`Failed to load key tables: ${msg}`);
    }
  },

  // Полная замена whitelist для ключа: удаляем всё и вставляем заново в одной
  // транзакции (UNIQUE(key_id, table_name) и нет нативного upsert по композитному ключу).
  async replaceKeyTables(
    keyId: string,
    entries: Array<{ table_name: string; allowed_fields: string[] }>,
  ): Promise<void> {
    try {
      await withTransaction(async (client) => {
        await client.query('DELETE FROM data_api_key_tables WHERE key_id = $1', [keyId]);
        // Построчная вставка: node-pg корректно сериализует JS string[] в text[].
        // unnest($::text[][]) тут не подходит — он разворачивает 2-D массив в
        // скаляры (а не по под-массиву на строку) и требует прямоугольный массив.
        // Кол-во записей ограничено zod-схемой (max 200), цикл безопасен.
        for (const entry of entries) {
          await client.query(
            `INSERT INTO data_api_key_tables (key_id, table_name, allowed_fields)
             VALUES ($1, $2, $3::text[])`,
            [keyId, entry.table_name, entry.allowed_fields],
          );
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      throw new Error(`Failed to replace key tables: ${msg}`);
    }
  },

  async getRequestLogs(keyId: string, limit = 100): Promise<Array<{
    id: number; key_id: string | null; table_name: string | null; ip: string | null;
    status_code: number; latency_ms: number | null; query_params: unknown;
    error_message: string | null; created_at: string;
  }>> {
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    try {
      return await query<{
        id: number; key_id: string | null; table_name: string | null; ip: string | null;
        status_code: number; latency_ms: number | null; query_params: unknown;
        error_message: string | null; created_at: string;
      }>(
        `SELECT id, key_id, table_name, ip, status_code, latency_ms, query_params, error_message, created_at
           FROM data_api_request_logs
          WHERE key_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [keyId, safeLimit],
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      throw new Error(`Failed to load request logs: ${msg}`);
    }
  },
};
