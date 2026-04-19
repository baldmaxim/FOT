import { hostname } from 'node:os';
import { supabase } from '../config/database.js';

export const SIGUR_POLLING_STATE_KEY = 'sigur_presence_polling';
export const SIGUR_MONITOR_STATE_KEY = 'sigur_monitor';

const PROCESS_INSTANCE_ID = `${hostname()}:${process.pid}:${Date.now().toString(36)}`;

export const SIGUR_POLLING_LEASE_TTL_SECONDS = 180;
export const SIGUR_MONITOR_LEASE_TTL_SECONDS = 180;

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

export async function tryAcquireSigurRuntimeLease(params: {
  key: string;
  owner: string;
  ttlSeconds: number;
  meta?: Record<string, unknown>;
}): Promise<{ acquired: boolean; row: ISigurRuntimeStateRow | null }> {
  return withSupabaseRetry(`tryAcquireSigurRuntimeLease(${params.key})`, async () => {
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
      row: row ? mapLeaseRowToState(row) : null,
    };
  });
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
  return withSupabaseRetry(`mergeSigurRuntimeState(${params.key})`, async () => {
    const { data, error } = await supabase.rpc('merge_sigur_runtime_state', {
      p_key: params.key,
      p_checkpoint_at: params.checkpointAt?.toISOString() || null,
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
