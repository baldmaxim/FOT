import { hostname } from 'node:os';
import * as Sentry from '@sentry/node';
import { query, queryOne } from '../config/postgres.js';

export const SIGUR_POLLING_STATE_KEY = 'sigur_presence_polling';
export const SIGUR_MONITOR_STATE_KEY = 'sigur_monitor';

const PROCESS_INSTANCE_ID = `${hostname()}:${process.pid}:${Date.now().toString(36)}`;

export const SIGUR_POLLING_LEASE_TTL_SECONDS = 180;
export const SIGUR_MONITOR_LEASE_TTL_SECONDS = 180;

// Если локальные часы расходятся с часами Postgres более чем на это значение —
// процесс отказывается держать lease. Иначе цикл polling будет писать checkpoint
// и запрашивать события Sigur из «будущего», в результате чего теряется поток.
const MAX_CLOCK_SKEW_MS = 60_000;
let lastClockSkewLogAt = 0;

export interface ISigurRuntimeStateRow {
  key: string;
  checkpoint_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  meta: Record<string, unknown>;
  updated_at: string;
}

interface ISigurRuntimeLeaseRow {
  state_key: string;
  state_checkpoint_at: string | null;
  state_lease_owner: string | null;
  state_lease_expires_at: string | null;
  state_heartbeat_at: string | null;
  state_meta: Record<string, unknown>;
  state_updated_at: string;
  acquired?: boolean;
  refreshed?: boolean;
}

const PG_RETRY_ATTEMPTS = 3;
const PG_RETRY_BASE_MS = 500;
const PG_RETRY_PATTERNS = [
  '502', '503', '504',
  'bad gateway', 'gateway timeout', 'service unavailable',
  'fetch failed', 'network', 'econnreset', 'etimedout', 'eai_again',
  'connection terminated',
];

function isTransientPgError(error: unknown): boolean {
  if (!error) return false;
  const e = error as { message?: string; code?: string };
  const haystack = `${e.message || ''} ${e.code || ''}`.toLowerCase();
  return PG_RETRY_PATTERNS.some(pattern => haystack.includes(pattern));
}

async function withPgRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= PG_RETRY_ATTEMPTS) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= PG_RETRY_ATTEMPTS || !isTransientPgError(error)) {
        throw error;
      }
      const delay = PG_RETRY_BASE_MS * Math.pow(2, attempt);
      const msg = (error as { message?: string }).message?.slice(0, 120) || 'unknown';
      console.warn(
        `[pg] retry ${attempt + 1}/${PG_RETRY_ATTEMPTS} ${label} after ${delay}ms: ${msg}`,
      );
      await new Promise(resolve => setTimeout(resolve, delay));
      attempt++;
    }
  }

  throw lastError;
}

const mapLeaseRowToState = (row: ISigurRuntimeLeaseRow): ISigurRuntimeStateRow => ({
  key: row.state_key || '',
  checkpoint_at: row.state_checkpoint_at ?? null,
  lease_owner: row.state_lease_owner ?? null,
  lease_expires_at: row.state_lease_expires_at ?? null,
  heartbeat_at: row.state_heartbeat_at ?? null,
  meta: row.state_meta || {},
  updated_at: row.state_updated_at || new Date(0).toISOString(),
});

export function getSigurRuntimeOwner(scope: string): string {
  return `${scope}:${PROCESS_INSTANCE_ID}`;
}

export async function getSigurRuntimeState(key: string): Promise<ISigurRuntimeStateRow | null> {
  return withPgRetry(`getSigurRuntimeState(${key})`, async () => {
    const row = await queryOne<ISigurRuntimeStateRow>(
      `SELECT key, checkpoint_at, lease_owner, lease_expires_at, heartbeat_at, meta, updated_at
       FROM sigur_runtime_state
       WHERE key = $1
       LIMIT 1`,
      [key],
    );
    return row;
  });
}

/**
 * Извлекает часы Postgres из ответа RPC try_acquire/heartbeat: lease_expires_at
 * выставляется как `NOW() + ttl_seconds`, поэтому `dbNow ≈ lease_expires_at - ttl`.
 */
function extractDbNowFromLeaseRow(
  row: ISigurRuntimeLeaseRow | null,
  ttlSeconds: number,
): number | null {
  const expiresIso = row?.state_lease_expires_at;
  if (!expiresIso) return null;
  const expiresMs = Date.parse(expiresIso);
  if (!Number.isFinite(expiresMs)) return null;
  return expiresMs - ttlSeconds * 1000;
}

function logClockSkew(skewMs: number, key: string, owner: string): void {
  // Не спамим Sentry — отчитываемся не чаще раза в 5 минут на процесс.
  const now = Date.now();
  console.error(
    `[runtime-state] CLOCK SKEW ${Math.round(skewMs / 1000)}s for "${key}" (owner=${owner}). ` +
    `Refusing lease — process clock is out of sync with Postgres.`,
  );
  if (now - lastClockSkewLogAt > 5 * 60_000) {
    lastClockSkewLogAt = now;
    Sentry.captureMessage('clock_skew_lease_refused', {
      level: 'error',
      extra: { skewMs, key, owner, localNow: now },
    });
  }
}

export async function tryAcquireSigurRuntimeLease(params: {
  key: string;
  owner: string;
  ttlSeconds: number;
  meta?: Record<string, unknown>;
}): Promise<{ acquired: boolean; row: ISigurRuntimeStateRow | null }> {
  const result = await withPgRetry(`tryAcquireSigurRuntimeLease(${params.key})`, async () => {
    const rows = await query<ISigurRuntimeLeaseRow>(
      'SELECT * FROM public.try_acquire_sigur_runtime_lease($1, $2, $3::int, $4::jsonb)',
      [params.key, params.owner, params.ttlSeconds, JSON.stringify(params.meta || {})],
    );
    const row = rows[0] || null;
    return {
      acquired: !!row?.acquired,
      rawRow: row,
      row: row ? mapLeaseRowToState(row) : null,
    };
  });

  // Защита от рассинхрона часов: если у нас есть lease, проверяем расхождение
  // между локальным временем и часами Postgres. При большом skew релизим lease
  // и не возвращаем его наверх — иначе polling будет писать «будущий» checkpoint.
  if (result.acquired && result.rawRow) {
    const dbNowMs = extractDbNowFromLeaseRow(result.rawRow, params.ttlSeconds);
    if (dbNowMs != null) {
      const skewMs = Math.abs(Date.now() - dbNowMs);
      if (skewMs > MAX_CLOCK_SKEW_MS) {
        logClockSkew(skewMs, params.key, params.owner);
        await releaseSigurRuntimeLease({ key: params.key, owner: params.owner })
          .catch(err => console.error('[runtime-state] release after skew failed:', (err as Error).message));
        return { acquired: false, row: null };
      }
    }
  }

  return { acquired: result.acquired, row: result.row };
}

export async function heartbeatSigurRuntimeLease(params: {
  key: string;
  owner: string;
  ttlSeconds: number;
  meta?: Record<string, unknown>;
}): Promise<boolean> {
  return withPgRetry(`heartbeatSigurRuntimeLease(${params.key})`, async () => {
    const rows = await query<ISigurRuntimeLeaseRow>(
      'SELECT * FROM public.heartbeat_sigur_runtime_lease($1, $2, $3::int, $4::jsonb)',
      [params.key, params.owner, params.ttlSeconds, JSON.stringify(params.meta || {})],
    );
    const row = rows[0] || null;
    return !!row?.refreshed;
  });
}

export async function mergeSigurRuntimeState(params: {
  key: string;
  checkpointAt?: Date | null;
  meta?: Record<string, unknown>;
  owner?: string | null;
}): Promise<ISigurRuntimeStateRow | null> {
  // Никогда не пишем checkpoint больше «локального сейчас + 60 сек».
  // Если процесс с рассинхроном часов всё-таки оказался здесь, страхуемся:
  // checkpoint в будущем заморозит окно polling и поток событий замолчит.
  let checkpointAt = params.checkpointAt;
  if (checkpointAt && checkpointAt.getTime() > Date.now() + MAX_CLOCK_SKEW_MS) {
    console.warn(
      `[runtime-state] capped future checkpoint ${checkpointAt.toISOString()} for "${params.key}" to local now`,
    );
    checkpointAt = new Date();
  }

  return withPgRetry(`mergeSigurRuntimeState(${params.key})`, async () => {
    const row = await queryOne<ISigurRuntimeStateRow>(
      'SELECT * FROM public.merge_sigur_runtime_state($1, $2::timestamptz, $3::jsonb, $4)',
      [
        params.key,
        checkpointAt?.toISOString() || null,
        JSON.stringify(params.meta || {}),
        params.owner || null,
      ],
    );
    return row;
  });
}

export async function releaseSigurRuntimeLease(params: {
  key: string;
  owner: string;
}): Promise<boolean> {
  return withPgRetry(`releaseSigurRuntimeLease(${params.key})`, async () => {
    const row = await queryOne<{ released: boolean }>(
      'SELECT public.release_sigur_runtime_lease($1, $2) AS released',
      [params.key, params.owner],
    );
    return !!row?.released;
  });
}

export function startSigurRuntimeLeaseHeartbeat(params: {
  key: string;
  owner: string;
  ttlSeconds: number;
  getMeta?: () => Record<string, unknown>;
  onError?: (error: Error) => void;
}): () => void {
  const intervalMs = Math.max(15_000, Math.floor((params.ttlSeconds * 1000) / 3));
  const timer = setInterval(() => {
    void heartbeatSigurRuntimeLease({
      key: params.key,
      owner: params.owner,
      ttlSeconds: params.ttlSeconds,
      meta: params.getMeta?.() || {},
    }).catch(error => {
      params.onError?.(error as Error);
    });
  }, intervalMs);

  return () => clearInterval(timer);
}
