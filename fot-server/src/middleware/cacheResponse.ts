import { Request, Response, NextFunction } from 'express';
import { LRUCache } from 'lru-cache';

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
) {
  const cache = new LRUCache<string, object>({ max, ttl: ttlMs });

  const middleware = (req: Request, res: Response, next: NextFunction) => {
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
  };

  /** Инвалидация всего кэша */
  middleware.invalidate = () => cache.clear();

  /** Инвалидация по ключу */
  middleware.invalidateKey = (key: string) => cache.delete(key);

  return middleware;
}
