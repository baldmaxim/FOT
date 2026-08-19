import { Request, Response, NextFunction } from 'express';

import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Ограничитель одновременных запросов одного пользователя на маршрут.
 *
 * Зачем: старые вкладки шлют массовую правку табеля как N параллельных запросов
 * (Promise.all по ячейкам). По HTTP/2 они уходят одним залпом, каждый держит
 * соединение пула, пока ждёт advisory-lock — пул исчерпывается и запросы падают
 * по connectionTimeoutMillis. Очередь превращает залп в поток: клиент получает
 * медленные 200 вместо быстрых 500, пул остаётся живым для остальных страниц.
 *
 * Состояние in-memory, per-process — этого достаточно: PM2 держит один fork.
 * При переходе на cluster ограничитель станет per-worker (см. комментарий в
 * ecosystem.config.cjs).
 */

export interface IPerUserConcurrencyOptions {
  /** Сколько запросов одного пользователя обрабатывается одновременно. */
  limit: number;
  /** Максимальная длина очереди на пользователя; сверх — сразу 429. */
  maxQueue: number;
  /** Сколько ждать слот в очереди, мс; по истечении — 429. */
  maxWaitMs: number;
}

interface IUserState {
  active: number;
  queue: Array<{ resolve: () => void; timer: NodeJS.Timeout; cancelled: boolean }>;
}

const TOO_MANY_MESSAGE = 'Слишком много одновременных запросов. Повторите через несколько секунд.';

export function perUserConcurrency(options: IPerUserConcurrencyOptions) {
  const { limit, maxQueue, maxWaitMs } = options;
  const states = new Map<string, IUserState>();

  const stateFor = (key: string): IUserState => {
    let state = states.get(key);
    if (!state) {
      state = { active: 0, queue: [] };
      states.set(key, state);
    }
    return state;
  };

  const release = (key: string): void => {
    const state = states.get(key);
    if (!state) return;
    state.active -= 1;
    // Пропускаем следующего в очереди; отменённые (по таймауту) пропускаем.
    while (state.queue.length > 0) {
      const next = state.queue.shift();
      if (!next || next.cancelled) continue;
      clearTimeout(next.timer);
      state.active += 1;
      next.resolve();
      break;
    }
    // Пользователь ушёл — не держим запись в памяти.
    if (state.active <= 0 && state.queue.length === 0) states.delete(key);
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    const userId = (req as AuthenticatedRequest).user?.id;
    if (!userId) {
      next();
      return;
    }
    const state = stateFor(userId);

    const run = (): void => {
      let released = false;
      const releaseOnce = (): void => {
        if (released) return;
        released = true;
        release(userId);
      };
      // Слот освобождаем и при обрыве соединения — иначе очередь встанет.
      res.on('finish', releaseOnce);
      res.on('close', releaseOnce);
      next();
    };

    if (state.active < limit) {
      state.active += 1;
      run();
      return;
    }

    if (state.queue.length >= maxQueue) {
      res.setHeader('Retry-After', '2');
      res.status(429).json({ success: false, error: TOO_MANY_MESSAGE, code: 'too_many_requests' });
      return;
    }

    const entry: IUserState['queue'][number] = {
      cancelled: false,
      resolve: run,
      timer: setTimeout(() => {
        entry.cancelled = true;
        res.setHeader('Retry-After', '2');
        res.status(429).json({ success: false, error: TOO_MANY_MESSAGE, code: 'too_many_requests' });
      }, maxWaitMs),
    };
    entry.timer.unref?.();
    state.queue.push(entry);
  };
}
