import { Request, Response, NextFunction } from 'express';
import { LRUCache } from 'lru-cache';

export type CacheMiddleware = ((req: Request, res: Response, next: NextFunction) => void) & {
  invalidate: () => void;
  invalidateKey: (key: string) => void;
};

const registry = new Map<string, CacheMiddleware>();

/**
 * Middleware для кэширования JSON-ответов.
 * @param keyFn - функция для генерации ключа кэша из запроса
 * @param ttlMs - время жизни кэша в мс
 * @param max - максимальное количество записей в кэше
 */
export function cacheResponse(
  keyFn: (req: Request) => string,
  ttlMs: number,
  max = 200,
): CacheMiddleware {
  const cache = new LRUCache<string, object>({ max, ttl: ttlMs });

  const middleware = ((req: Request, res: Response, next: NextFunction) => {
    const key = keyFn(req);
    const cached = cache.get(key);
    if (cached) {
      res.json(cached);
      return;
    }

    const originalJson = res.json.bind(res);
    res.json = (body: object) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        cache.set(key, body);
      }
      return originalJson(body);
    };
    next();
  }) as CacheMiddleware;

  middleware.invalidate = () => cache.clear();
  middleware.invalidateKey = (key: string) => cache.delete(key);

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
  max = 200,
): CacheMiddleware {
  const m = cacheResponse(keyFn, ttlMs, max);
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
