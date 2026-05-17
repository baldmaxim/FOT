/**
 * Generic in-memory stale-while-revalidate кэш для тяжёлых пересчётов
 * (presence / presence-by-object / Sigur-резолвер).
 *
 * Семантика:
 * - свежо (now <= expiresAt)              → значение из кэша;
 * - протухло, но в окне stale             → старое значение немедленно +
 *                                           фоновый пересчёт (без блокировки);
 * - записи нет / вышли за окно stale       → блокирующий await producer()
 *                                           (единственный медленный путь — холодный старт),
 *                                           с single-flight по ключу;
 * - ошибка фонового refresh                → stale-окно продлевается, процесс не падает.
 *
 * `ttlMs` — окно «свежести»; `staleMs` — полное окно жизни записи (>= ttlMs),
 * внутри (ttlMs..staleMs] отдаём stale + ревалидируем. Конвенция совпадает с
 * `middleware/cacheResponse.ts`.
 */

const STALE_EXTEND_ON_FAILURE_MS = 5 * 60_000;

interface IEntry<V> {
  value: V;
  expiresAt: number;
  staleUntilAt: number;
}

export interface ISwrCache<V> {
  /**
   * Вернуть кэшированное (свежее или stale) значение; при протухании —
   * ревалидировать в фоне. При отсутствии записи — блокирующе вычислить.
   */
  getOrRefresh(key: string, ttlMs: number, staleMs: number, producer: () => Promise<V>): Promise<V>;
  /**
   * Форсировать фоновый пересчёт ключа (re-warm после новых данных).
   * Не блокирует. Если refresh уже идёт — помечает «повторить после».
   */
  refreshNow(key: string, ttlMs: number, staleMs: number, producer: () => Promise<V>): void;
  /** Полная очистка (для write-through инвалидации). */
  clear(): void;
  /** Удалить конкретный ключ. */
  delete(key: string): void;
}

export function createSwrCache<V>(): ISwrCache<V> {
  const cache = new Map<string, IEntry<V>>();
  /** Блокирующий single-flight (холодный старт): второй вызов ждёт первый. */
  const inflight = new Map<string, Promise<V>>();
  /** Фоновая ревалидация идёт. */
  const refreshing = new Set<string>();
  /** refreshNow пришёл во время активной ревалидации → повторить по завершении. */
  const pending = new Set<string>();

  const store = (key: string, value: V, ttlMs: number, staleMs: number): void => {
    const now = Date.now();
    cache.set(key, { value, expiresAt: now + ttlMs, staleUntilAt: now + staleMs });
  };

  const runRefresh = (key: string, ttlMs: number, staleMs: number, producer: () => Promise<V>): void => {
    if (refreshing.has(key)) {
      pending.add(key);
      return;
    }
    refreshing.add(key);
    void Promise.resolve()
      .then(producer)
      .then((value) => {
        store(key, value, ttlMs, staleMs);
      })
      .catch(() => {
        // Фоновый сбой не должен ронять процесс: продлеваем stale-окно,
        // чтобы следующий запрос ещё раз отдал старое и попробовал снова.
        const existing = cache.get(key);
        if (existing) {
          existing.staleUntilAt = Date.now() + STALE_EXTEND_ON_FAILURE_MS;
        }
      })
      .finally(() => {
        refreshing.delete(key);
        if (pending.delete(key)) {
          runRefresh(key, ttlMs, staleMs, producer);
        }
      });
  };

  return {
    async getOrRefresh(key, ttlMs, staleMs, producer) {
      const now = Date.now();
      const entry = cache.get(key);

      if (entry && now <= entry.expiresAt) {
        return entry.value;
      }

      if (entry && now <= entry.staleUntilAt) {
        runRefresh(key, ttlMs, staleMs, producer);
        return entry.value;
      }

      // Холодный старт / вышли за окно stale — блокирующий single-flight.
      const existing = inflight.get(key);
      if (existing) return existing;

      const promise = (async () => {
        try {
          const value = await producer();
          store(key, value, ttlMs, staleMs);
          return value;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, promise);
      return promise;
    },

    refreshNow(key, ttlMs, staleMs, producer) {
      runRefresh(key, ttlMs, staleMs, producer);
    },

    clear() {
      cache.clear();
    },

    delete(key) {
      cache.delete(key);
    },
  };
}
