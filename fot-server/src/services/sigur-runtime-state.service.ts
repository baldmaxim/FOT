import { hostname } from 'node:os';
import * as Sentry from '@sentry/node';
import { supabase } from '../config/database.js';

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

interface ISigurRuntimeLeaseRow extends ISigurRuntimeStateRow {
  state_key?: string;
  state_checkpoint_at?: string | null;
  state_lease_owner?: string | null;
  state_lease_expires_at?: string | null;
  state_heartbeat_at?: string | null;
  state_meta?: Record<string, unknown>;
  state_updated_at?: string;
  acquired?: boolean;
  refreshed?: boolean;
}

const normalizeRpcRow = <T>(data: T | T[] | null): T | null => {
  if (Array.isArray(data)) {
    return data[0] || null;
  }
  return data || null;
};

const SUPABASE_RETRY_ATTEMPTS = 3;
const SUPABASE_RETRY_BASE_MS = 500;
const SUPABASE_RETRY_PATTERNS = [
  '502', '503', '504',
  'bad gateway', 'gateway timeout', 'service unavailable',
  'fetch failed', 'network', 'econnreset', 'etimedout', 'eai_again',
];

function isTransientSupabaseError(error: { message?: string; code?: string } | null): boolean {
  if (!error) return false;
  const haystack = `${error.message || ''} ${error.code || ''}`.toLowerCase();
  return SUPABASE_RETRY_PATTERNS.some(pattern => haystack.includes(pattern));
}

async function withSupabaseRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= SUPABASE_RETRY_ATTEMPTS) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const err = error as { message?: string; code?: string } | null;
      if (attempt >= SUPABASE_RETRY_ATTEMPTS || !isTransientSupabaseError(err)) {
        throw error;
      }
      const delay = SUPABASE_RETRY_BASE_MS * Math.pow(2, attempt);
      console.warn(
        `[supabase] retry ${attempt + 1}/${SUPABASE_RETRY_ATTEMPTS} ${label} after ${delay}ms: ${err?.message?.slice(0, 120) || 'unknown'}`,
      );
      await new Promise(resolve => setTimeout(resolve, delay));
      attempt++;
    }
  }

  throw lastError;
}

const mapLeaseRowToState = (row: ISigurRuntimeLeaseRow): ISigurRuntimeStateRow => ({
  key: row.state_key || row.key || '',
  checkpoint_at: row.state_checkpoint_at ?? row.checkpoint_at ?? null,
  lease_owner: row.state_lease_owner ?? row.lease_owner ?? null,
  lease_expires_at: row.state_lease_expires_at ?? row.lease_expires_at ?? null,
  heartbeat_at: row.state_heartbeat_at ?? row.heartbeat_at ?? null,
  meta: row.state_meta || row.meta || {},
  updated_at: row.state_updated_at || row.updated_at || new Date(0).toISOString(),
});

export function getSigurRuntimeOwner(scope: string): string {
  return `${scope}:${PROCESS_INSTANCE_ID}`;
}

export async function getSigurRuntimeState(key: string): Promise<ISigurRuntimeStateRow | null> {
  return withSupabaseRetry(`getSigurRuntimeState(${key})`, async () => {
    const { data, error } = await supabase
      .from('sigur_runtime_state')
      .select('*')
      .eq('key', key)
      .limit(1);

    if (error) {
      throw new Error(`Failed to read Sigur runtime state "${key}": ${error.message}`);
    }

    const row = Array.isArray(data) ? data[0] || null : null;
    return (row || null) as ISigurRuntimeStateRow | null;
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
  const expiresIso = row?.state_lease_expires_at ?? row?.lease_expires_at;
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
  const result = await withSupabaseRetry(`tryAcquireSigurRuntimeLease(${params.key})`, async () => {
    const { data, error } = await supabase.rpc('try_acquire_sigur_runtime_lease', {
      p_key: params.key,
      p_owner: params.owner,
      p_ttl_seconds: params.ttlSeconds,
      p_meta: params.meta || {},
    });

    if (error) {
      throw new Error(`Failed to acquire Sigur runtime lease "${params.key}": ${error.message}`);
    }

    const row = normalizeRpcRow(data as ISigurRuntimeLeaseRow[] | ISigurRuntimeLeaseRow | null);
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
  return withSupabaseRetry(`heartbeatSigurRuntimeLease(${params.key})`, async () => {
    const { data, error } = await supabase.rpc('heartbeat_sigur_runtime_lease', {
      p_key: params.key,
      p_owner: params.owner,
      p_ttl_seconds: params.ttlSeconds,
      p_meta: params.meta || {},
    });

    if (error) {
      throw new Error(`Failed to heartbeat Sigur runtime lease "${params.key}": ${error.message}`);
    }

    const row = normalizeRpcRow(data as ISigurRuntimeLeaseRow[] | ISigurRuntimeLeaseRow | null);
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

  return withSupabaseRetry(`mergeSigurRuntimeState(${params.key})`, async () => {
    const { data, error } = await supabase.rpc('merge_sigur_runtime_state', {
      p_key: params.key,
      p_checkpoint_at: checkpointAt?.toISOString() || null,
      p_meta: params.meta || {},
      p_owner: params.owner || null,
    });

    if (error) {
      throw new Error(`Failed to merge Sigur runtime state "${params.key}": ${error.message}`);
    }

    return normalizeRpcRow(data as ISigurRuntimeStateRow[] | ISigurRuntimeStateRow | null);
  });
}

export async function releaseSigurRuntimeLease(params: {
  key: string;
  owner: string;
}): Promise<boolean> {
  return withSupabaseRetry(`releaseSigurRuntimeLease(${params.key})`, async () => {
    const { data, error } = await supabase.rpc('release_sigur_runtime_lease', {
      p_key: params.key,
      p_owner: params.owner,
    });

    if (error) {
      throw new Error(`Failed to release Sigur runtime lease "${params.key}": ${error.message}`);
    }

    return !!data;
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
