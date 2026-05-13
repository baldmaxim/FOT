// PostgreSQL runtime: пул соединений + thin-helpers поверх node-postgres.
//
// Используется сервисами runtime-кода (local-auth.service.ts и далее по
// мере переезда с supabase-js). НЕ предназначен для миграционных скриптов —
// они уже ходят к pg напрямую с собственным Pool/Client (см.
// fot-server/scripts/yandex-migration/*.ts).
//
// Безопасность логирования:
// - DATABASE_URL никогда не логируется. Объект ошибки pg, если в нём
//   случайно окажется connectionString, тоже не пишется целиком — мы
//   ограничиваемся `err.message` и `err.code`.
// - Параметры запроса (`params`) не логируются — могут содержать
//   bcrypt-хеши паролей, токены и т. п.

import fs from 'node:fs';
import { Pool, types, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg';

import { env } from './env.js';

// Supabase REST отдавал `date`-колонки как ISO-строки `YYYY-MM-DD`.
// pg-node по умолчанию парсит их в JS Date — это ломает код в schedule/timesheet
// сервисах, которые делают `anchor.split('-')` или строковое сравнение
// `effectiveFrom > date`. Возвращаем поведение Supabase: keep date as string.
// 1082 = DATE OID в pg_type. Не трогаем 1114 (timestamp) и 1184 (timestamptz)
// — там у нас работа с Date уже отлажена.
types.setTypeParser(1082, (val: string) => val);

const parseBool = (raw: string | undefined, fallback: boolean): boolean => {
  if (raw === undefined || raw === '') return fallback;
  return raw.trim().toLowerCase() !== 'false';
};

const parseIntStrict = (raw: string, fieldName: string): number => {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${fieldName} должен быть положительным целым числом, получено: ${raw}`);
  }
  return n;
};

const buildSsl = (): PoolConfig['ssl'] => {
  if (!parseBool(env.DATABASE_SSL, true)) {
    return false;
  }
  if (env.DATABASE_SSL_CA_PATH) {
    return {
      rejectUnauthorized: true,
      ca: fs.readFileSync(env.DATABASE_SSL_CA_PATH, 'utf8'),
    };
  }
  return { rejectUnauthorized: true };
};

/**
 * Сборка PoolConfig из env с возможностью override (для тестов с
 * ephemeral-PG или ad-hoc connections без singleton'а).
 */
export const createPgPoolConfig = (overrides: Partial<PoolConfig> = {}): PoolConfig => {
  const base: PoolConfig = {
    connectionString: env.DATABASE_URL,
    max: parseIntStrict(env.DATABASE_POOL_MAX, 'DATABASE_POOL_MAX'),
    statement_timeout: parseIntStrict(env.DATABASE_STATEMENT_TIMEOUT_MS, 'DATABASE_STATEMENT_TIMEOUT_MS'),
    ssl: buildSsl(),
  };
  return { ...base, ...overrides };
};

let _pool: Pool | null = null;

/**
 * Lazy-init singleton Pool. Открывает соединения на первом запросе;
 * сам конструктор `new Pool()` соединений ещё не создаёт.
 *
 * Помимо использования внутренними helpers (query/queryOne/execute/
 * withTransaction), экспортирован для редких случаев: telemetry,
 * подписка на pool-events, ручной `client.connect()` через
 * `getPool().connect()`.
 */
export const getPool = (): Pool => {
  if (_pool) return _pool;
  _pool = new Pool(createPgPoolConfig());
  // pg's Pool emits 'error' для idle-clients. Без обработчика — uncaught.
  // Логируем только сообщение/код, чтобы не вытащить connection string или
  // значения параметров через детали ошибки.
  _pool.on('error', err => {
    const code = (err as { code?: string }).code ?? 'UNKNOWN';
    console.error(`[pg] idle client error: ${code} ${err.message}`);
  });
  return _pool;
};

// Alias под имя, под которым accessor значится во внешнем спеке API
// (рядом с query/queryOne/execute/withTransaction/...). Эквивалент
// getPool — вызов функции возвращает singleton Pool.
export { getPool as pool };

/** SELECT, возвращает массив строк. */
export const query = async <T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: readonly unknown[],
): Promise<T[]> => {
  const result = await getPool().query<T>(sql, params as unknown[] | undefined);
  return result.rows;
};

/** SELECT, возвращает первую строку или null. */
export const queryOne = async <T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: readonly unknown[],
): Promise<T | null> => {
  const result = await getPool().query<T>(sql, params as unknown[] | undefined);
  return result.rows[0] ?? null;
};

/** INSERT/UPDATE/DELETE без возврата строк. Возвращает rowCount. */
export const execute = async (sql: string, params?: readonly unknown[]): Promise<number> => {
  const result = await getPool().query(sql, params as unknown[] | undefined);
  return result.rowCount ?? 0;
};

/**
 * Транзакция. BEGIN/COMMIT/ROLLBACK автоматические; клиент возвращается
 * в пул даже при исключении.
 */
export const withTransaction = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ROLLBACK на уже-сломанном коннекте — игнорируем
    }
    throw err;
  } finally {
    client.release();
  }
};

/** Проверка живости коннекта. Возвращает true/false без бросания. */
export const checkDbConnection = async (): Promise<boolean> => {
  try {
    await getPool().query('SELECT 1');
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'UNKNOWN';
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pg] checkDbConnection failed: ${code} ${message}`);
    return false;
  }
};

/** Закрывает пул. Идемпотентно. Вызывать на graceful shutdown. */
export const closeDb = async (): Promise<void> => {
  if (!_pool) return;
  const p = _pool;
  _pool = null;
  await p.end();
};
