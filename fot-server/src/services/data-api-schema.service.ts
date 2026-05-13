import { query } from '../config/postgres.js';

// Запрещённые таблицы — служебные, аудитные и инфраструктурные.
// Список захардкожен, чтобы админ через UI не мог по ошибке выдать к ним доступ.
const FORBIDDEN_TABLES = new Set<string>([
  'data_api_keys',
  'data_api_key_tables',
  'data_api_request_logs',
  'audit_logs',
  'user_sessions',
  'refresh_tokens',
  'push_subscriptions',
  'web_push_subscriptions',
]);

const FORBIDDEN_TABLE_PREFIXES = ['pg_', 'sql_'];

const FORBIDDEN_TABLE_PATTERNS: RegExp[] = [
  /^skud_events_\d/i,
  /_backup(_|$)/i,
];

const FORBIDDEN_FIELD_NAMES = new Set<string>([
  'totp_secret',
  'totp_secret_encrypted',
  'recovery_codes',
  'recovery_codes_encrypted',
  'password_hash',
  'password',
  'secret',
  'jwt',
  'token',
  'refresh_token',
  'access_token',
  'telegram_chat_id',
]);

const FORBIDDEN_FIELD_PATTERNS: RegExp[] = [
  /^encrypted_/i,
  /_encrypted$/i,
  /^secret_/i,
  /_secret$/i,
];

export interface SchemaColumn {
  name: string;
  data_type: string;
  is_nullable: boolean;
}

export interface SchemaTable {
  name: string;
  columns: SchemaColumn[];
}

interface RpcRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: boolean;
}

function isForbiddenTable(name: string): boolean {
  if (FORBIDDEN_TABLES.has(name)) return true;
  if (FORBIDDEN_TABLE_PREFIXES.some(prefix => name.startsWith(prefix))) return true;
  return FORBIDDEN_TABLE_PATTERNS.some(re => re.test(name));
}

function isForbiddenField(name: string): boolean {
  const lower = name.toLowerCase();
  if (FORBIDDEN_FIELD_NAMES.has(lower)) return true;
  return FORBIDDEN_FIELD_PATTERNS.some(re => re.test(lower));
}

let cache: { schema: SchemaTable[]; expiresAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

async function loadFullSchema(): Promise<SchemaTable[]> {
  let rows: RpcRow[];
  try {
    rows = await query<RpcRow>(
      'SELECT table_name, column_name, data_type, is_nullable FROM public.data_api_list_public_schema()',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load public schema: ${message}`);
  }

  const byTable = new Map<string, SchemaColumn[]>();
  for (const row of rows) {
    if (isForbiddenTable(row.table_name)) continue;
    if (isForbiddenField(row.column_name)) continue;
    const list = byTable.get(row.table_name) ?? [];
    list.push({
      name: row.column_name,
      data_type: row.data_type,
      is_nullable: row.is_nullable,
    });
    byTable.set(row.table_name, list);
  }

  return [...byTable.entries()]
    .filter(([, columns]) => columns.length > 0)
    .map(([name, columns]) => ({
      name,
      columns: columns.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const dataApiSchemaService = {
  async getFullSchema(forceRefresh = false): Promise<SchemaTable[]> {
    const now = Date.now();
    if (!forceRefresh && cache && cache.expiresAt > now) {
      return cache.schema;
    }
    const schema = await loadFullSchema();
    cache = { schema, expiresAt: now + CACHE_TTL_MS };
    return schema;
  },

  async getTable(tableName: string): Promise<SchemaTable | null> {
    const schema = await this.getFullSchema();
    return schema.find(t => t.name === tableName) ?? null;
  },

  isForbiddenTable,
  isForbiddenField,

  invalidateCache(): void {
    cache = null;
  },
};
