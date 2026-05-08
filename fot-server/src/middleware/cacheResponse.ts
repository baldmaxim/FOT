import { Request, Response, NextFunction } from 'express';
import { LRUCache } from 'lru-cache';
import * as Sentry from '@sentry/node';

export interface ICacheOptions {
  max?: number;
  /**
   * Окно stale-while-revalidate (мс). По умолчанию = ttlMs (никакого SWR).
   * Если staleMs > ttlMs, в окне (ttlMs..staleMs] middleware отдаёт прежний value (X-Cache-Status: STALE)
   * и фоном вызывает refresh, чтобы пополнить кеш. При неудаче refresh окно продлевается на 5 минут.
   */
  staleMs?: number;
  /**
   * Фоновый refresher для SWR. Если не задан — SWR недоступен (поведение =
   * чисто HIT/MISS). Возвращает body, который попадёт в кеш как fresh-запись.
   */
  refresh?: (req: Request) => Promise<object>;
}

export type CacheMiddleware = ((req: Request, res: Response, next: NextFunction) => void) & {
  invalidate: () => void;
  invalidateKey: (key: string) => void;
};

interface IEntry {
  value: object;
  expiresAt: number;
  staleUntilAt: number;
}

interface IPending {
  promise: Promise<{ status: number; body: object } | null>;
  createdAt: number;
}

const SINGLE_FLIGHT_TIMEOUT_MS = 10_000;
const STALE_EXTEND_ON_FAILURE_MS = 5 * 60_000;

const registry = new Map<string, CacheMiddleware>();

function normalizeOptions(arg: number | ICacheOptions | undefined, ttlMs: number): Required<Pick<ICacheOptions, 'max' | 'staleMs'>> & { refresh?: ICacheOptions['refresh'] } {
  if (typeof arg === 'number') {
    return { max: arg, staleMs: ttlMs };
  }
  return {
    max: arg?.max ?? 200,
    staleMs: arg?.staleMs ?? ttlMs,
    refresh: arg?.refresh,
  };
}

export function cacheResponse(
  keyFn: (req: Request) => string,
  ttlMs: number,
  optionsArg?: number | ICacheOptions,
): CacheMiddleware {
  const { max, staleMs, refresh } = normalizeOptions(optionsArg, ttlMs);
  // LRU.ttl ставим = staleMs, потому что внутри окна stale запись ещё нужна;
  // freshness различаем через entry.expiresAt.
  const cache = new LRUCache<string, IEntry>({ max, ttl: staleMs });
  const inflight = new Map<string, IPending>();
  const refreshing = new Set<string>();

  const triggerBackgroundRefresh = (key: string, req: Request): void => {
    if (!refresh || refreshing.has(key)) return;
    refreshing.add(key);
    void Promise.resolve()
      .then(() => refresh(req))
      .then((body) => {
        cache.set(key, {
          value: body,
          expiresAt: Date.now() + ttlMs,
          staleUntilAt: Date.now() + staleMs,
        });
      })
      .catch((error) => {
        const existing = cache.get(key);
        if (existing) {
          cache.set(key, {
            ...existing,
            staleUntilAt: Date.now() + STALE_EXTEND_ON_FAILURE_MS,
          });
        }
        Sentry.captureMessage('cache_swr_refresh_failed', {
          level: 'warning',
          tags: { swr_extend: keyFn.name || 'unknown' },
          extra: { error: error instanceof Error ? error.message : String(error), key },
        });
      })
      .finally(() => {
        refreshing.delete(key);
      });
  };

  const middleware = ((req: Request, res: Response, next: NextFunction) => {
    const key = keyFn(req);
    const entry = cache.get(key);
    const now = Date.now();

    if (entry && now <= entry.expiresAt) {
      res.setHeader('X-Cache-Status', 'HIT');
      res.json(entry.value);
      return;
    }

    if (entry && now <= entry.staleUntilAt) {
      res.setHeader('X-Cache-Status', 'STALE');
      res.json(entry.value);
      if (refresh) triggerBackgroundRefresh(key, req);
      return;
    }

    const existingPending = inflight.get(key);
    if (existingPending) {
      res.setHeader('X-Cache-Status', 'COALESCED');
      void existingPending.promise.then((result) => {
        if (result) {
          res.status(result.status).json(result.body);
          return;
        }
        // Single-flight таймаут или провал — пробуем заново через next() (без middleware-кеша).
        runFresh(res, next, key);
      });
      return;
    }

    runFresh(res, next, key);
  }) as CacheMiddleware;

  function runFresh(res: Response, next: NextFunction, key: string): void {
    let resolveOuter!: (v: { status: number; body: object } | null) => void;
    const promise = new Promise<{ status: number; body: object } | null>((r) => {
      resolveOuter = r;
    });
    const pending: IPending = { promise, createdAt: Date.now() };
    inflight.set(key, pending);

    const timeoutId = setTimeout(() => {
      if (inflight.get(key) === pending) {
        inflight.delete(key);
        resolveOuter(null);
      }
    }, SINGLE_FLIGHT_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeoutId);
      if (inflight.get(key) === pending) inflight.delete(key);
    };

    const originalJson = res.json.bind(res);
    res.json = (body: object) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        cache.set(key, {
          value: body,
          expiresAt: Date.now() + ttlMs,
          staleUntilAt: Date.now() + staleMs,
        });
        resolveOuter({ status: res.statusCode, body });
      } else {
        resolveOuter(null);
      }
      cleanup();
      return originalJson(body);
    };

    res.on('close', () => {
      // Сценарий: клиент оборвал коннект до res.json. Пенди-промис должен резолвнуться,
      // иначе COALESCED-ждущие зависнут до SINGLE_FLIGHT_TIMEOUT_MS.
      if (inflight.get(key) === pending) {
        cleanup();
        resolveOuter(null);
      }
    });

    res.setHeader('X-Cache-Status', 'MISS');
    next();
  }

  middleware.invalidate = () => {
    cache.clear();
  };
  middleware.invalidateKey = (key: string) => {
    cache.delete(key);
  };

  return middleware;
}

/**
 * Регистрация именованного кэша. Позволяет инвалидировать его из любого места
 * через invalidateCache(name) без прямой ссылки на middleware.
 */
export function registerCache(
  name: string,
  keyFn: (req: Request) => string,
  ttlMs: number,
  optionsArg?: number | ICacheOptions,
): CacheMiddleware {
  const m = cacheResponse(keyFn, ttlMs, optionsArg);
  registry.set(name, m);
  return m;
}

/** Инвалидация именованного кэша целиком. */
export function invalidateCache(name: string): void {
  registry.get(name)?.invalidate();
}

/** Инвалидация нескольких именованных кэшей. */
export function invalidateCaches(...names: string[]): void {
  for (const name of names) registry.get(name)?.invalidate();
}
