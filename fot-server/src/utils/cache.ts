import { LRUCache } from 'lru-cache';

export function createCache<V extends object>(opts: { max?: number; ttlMs: number }) {
  return new LRUCache<string, V>({
    max: opts.max ?? 500,
    ttl: opts.ttlMs,
  });
}
