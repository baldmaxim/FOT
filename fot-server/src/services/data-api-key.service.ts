import crypto from 'node:crypto';
import { supabase } from '../config/database.js';

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

export const dataApiKeyService = {
  async createKey(input: CreateKeyInput): Promise<CreateKeyResult> {
    const { plaintext_token, prefix, secret } = generateRawToken();
    const { data, error } = await supabase
      .from('data_api_keys')
      .insert({
        name: input.name,
        description: input.description ?? null,
        key_prefix: prefix,
        key_hash: hashSecret(secret),
        rate_limit_per_minute: input.rate_limit_per_minute ?? 60,
        expires_at: input.expires_at ?? null,
        created_by: input.created_by,
      })
      .select('id')
      .single();

    if (error || !data) {
      throw new Error(`Failed to create API key: ${error?.message ?? 'unknown'}`);
    }

    return { id: data.id as string, plaintext_token, prefix };
  },

  async listKeys(): Promise<Array<Omit<DataApiKeyRow, 'key_hash'>>> {
    const { data, error } = await supabase
      .from('data_api_keys')
      .select('id, name, description, key_prefix, rate_limit_per_minute, created_by, created_at, expires_at, revoked_at, last_used_at')
      .order('created_at', { ascending: false });
    if (error) throw new Error(`Failed to list API keys: ${error.message}`);
    return (data ?? []) as Array<Omit<DataApiKeyRow, 'key_hash'>>;
  },

  async getKey(id: string): Promise<Omit<DataApiKeyRow, 'key_hash'> | null> {
    const { data, error } = await supabase
      .from('data_api_keys')
      .select('id, name, description, key_prefix, rate_limit_per_minute, created_by, created_at, expires_at, revoked_at, last_used_at')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`Failed to load API key: ${error.message}`);
    return (data ?? null) as Omit<DataApiKeyRow, 'key_hash'> | null;
  },

  async updateKey(id: string, patch: Partial<Pick<DataApiKeyRow, 'name' | 'description' | 'rate_limit_per_minute' | 'expires_at'>>): Promise<void> {
    const update: Record<string, unknown> = {};
    if (patch.name !== undefined) update.name = patch.name;
    if (patch.description !== undefined) update.description = patch.description;
    if (patch.rate_limit_per_minute !== undefined) update.rate_limit_per_minute = patch.rate_limit_per_minute;
    if (patch.expires_at !== undefined) update.expires_at = patch.expires_at;
    if (Object.keys(update).length === 0) return;

    const { error } = await supabase
      .from('data_api_keys')
      .update(update)
      .eq('id', id);
    if (error) throw new Error(`Failed to update API key: ${error.message}`);
  },

  async revokeKey(id: string): Promise<void> {
    const { error } = await supabase
      .from('data_api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id)
      .is('revoked_at', null);
    if (error) throw new Error(`Failed to revoke API key: ${error.message}`);
  },

  async getKeyTables(keyId: string): Promise<Array<{ table_name: string; allowed_fields: string[] }>> {
    const { data, error } = await supabase
      .from('data_api_key_tables')
      .select('table_name, allowed_fields')
      .eq('key_id', keyId)
      .order('table_name', { ascending: true });
    if (error) throw new Error(`Failed to load key tables: ${error.message}`);
    return (data ?? []) as Array<{ table_name: string; allowed_fields: string[] }>;
  },

  // Полная замена whitelist для ключа: удаляем всё и вставляем заново.
  // Порядок важен из-за UNIQUE(key_id, table_name) — Supabase не делает upsert по составному ключу простым путём.
  async replaceKeyTables(
    keyId: string,
    entries: Array<{ table_name: string; allowed_fields: string[] }>,
  ): Promise<void> {
    const { error: deleteError } = await supabase
      .from('data_api_key_tables')
      .delete()
      .eq('key_id', keyId);
    if (deleteError) throw new Error(`Failed to clear key tables: ${deleteError.message}`);

    if (entries.length === 0) return;

    const rows = entries.map(entry => ({
      key_id: keyId,
      table_name: entry.table_name,
      allowed_fields: entry.allowed_fields,
    }));
    const { error: insertError } = await supabase
      .from('data_api_key_tables')
      .insert(rows);
    if (insertError) throw new Error(`Failed to insert key tables: ${insertError.message}`);
  },

  async getRequestLogs(keyId: string, limit = 100): Promise<Array<{
    id: number; key_id: string | null; table_name: string | null; ip: string | null;
    status_code: number; latency_ms: number | null; query_params: unknown;
    error_message: string | null; created_at: string;
  }>> {
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    const { data, error } = await supabase
      .from('data_api_request_logs')
      .select('id, key_id, table_name, ip, status_code, latency_ms, query_params, error_message, created_at')
      .eq('key_id', keyId)
      .order('created_at', { ascending: false })
      .limit(safeLimit);
    if (error) throw new Error(`Failed to load request logs: ${error.message}`);
    return (data ?? []) as Array<{
      id: number; key_id: string | null; table_name: string | null; ip: string | null;
      status_code: number; latency_ms: number | null; query_params: unknown;
      error_message: string | null; created_at: string;
    }>;
  },
};
