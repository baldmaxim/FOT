import { describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

import { perUserConcurrency } from './perUserConcurrency.js';

/**
 * Ограничитель одновременных запросов пользователя. Появился после инцидента
 * 17.08.2026: вкладки со старым бандлом шлют массовую правку табеля как залп
 * одиночных PUT, и пул соединений БД исчерпывался (все запросы падали с 500).
 */

interface IFakeRes {
  res: Response;
  finish: () => void;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
}

const makeRes = (): IFakeRes => {
  const handlers: Record<string, Array<() => void>> = {};
  const res: Record<string, unknown> = {
    on: (event: string, cb: () => void) => {
      (handlers[event] ??= []).push(cb);
      return res;
    },
    setHeader: vi.fn(),
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  };
  return {
    res: res as unknown as Response,
    finish: () => (handlers.finish ?? []).forEach(cb => cb()),
    status: res.status as ReturnType<typeof vi.fn>,
    json: res.json as ReturnType<typeof vi.fn>,
  };
};

const makeReq = (userId: string | null): Request =>
  ({ user: userId ? { id: userId } : undefined } as unknown as Request);

const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };

describe('perUserConcurrency', () => {
  it('пропускает до limit запросов сразу, остальные ждут освобождения слота', async () => {
    const mw = perUserConcurrency({ limit: 2, maxQueue: 10, maxWaitMs: 1000 });
    const calls: IFakeRes[] = [];
    const next = vi.fn() as unknown as NextFunction;

    for (let i = 0; i < 3; i += 1) {
      const fake = makeRes();
      calls.push(fake);
      mw(makeReq('u1'), fake.res, next);
    }
    await flush();
    expect(next).toHaveBeenCalledTimes(2); // третий в очереди

    calls[0]!.finish();
    await flush();
    expect(next).toHaveBeenCalledTimes(3);
  });

  it('очередь считается отдельно для каждого пользователя', async () => {
    const mw = perUserConcurrency({ limit: 1, maxQueue: 10, maxWaitMs: 1000 });
    const next = vi.fn() as unknown as NextFunction;

    mw(makeReq('u1'), makeRes().res, next);
    mw(makeReq('u2'), makeRes().res, next);
    await flush();
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('переполнение очереди → 429 с Retry-After, обработчик не вызывается', async () => {
    const mw = perUserConcurrency({ limit: 1, maxQueue: 1, maxWaitMs: 1000 });
    const next = vi.fn() as unknown as NextFunction;

    mw(makeReq('u1'), makeRes().res, next);   // активный
    mw(makeReq('u1'), makeRes().res, next);   // в очереди
    const rejected = makeRes();
    mw(makeReq('u1'), rejected.res, next);    // очередь полна
    await flush();

    expect(next).toHaveBeenCalledTimes(1);
    expect(rejected.status).toHaveBeenCalledWith(429);
    expect(rejected.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'too_many_requests' }),
    );
  });

  it('ожидание дольше maxWaitMs → 429, слот отдаётся следующему', async () => {
    vi.useFakeTimers();
    try {
      const mw = perUserConcurrency({ limit: 1, maxQueue: 10, maxWaitMs: 50 });
      const next = vi.fn() as unknown as NextFunction;

      const active = makeRes();
      mw(makeReq('u1'), active.res, next);
      const waiting = makeRes();
      mw(makeReq('u1'), waiting.res, next);
      const alsoWaiting = makeRes();
      mw(makeReq('u1'), alsoWaiting.res, next);

      vi.advanceTimersByTime(60);
      expect(waiting.status).toHaveBeenCalledWith(429);
      expect(alsoWaiting.status).toHaveBeenCalledWith(429);

      active.finish();
      expect(next).toHaveBeenCalledTimes(1); // отменённые в очереди не запускаются
    } finally {
      vi.useRealTimers();
    }
  });

  it('запрос без пользователя проходит мимо ограничителя', async () => {
    const mw = perUserConcurrency({ limit: 1, maxQueue: 0, maxWaitMs: 1000 });
    const next = vi.fn() as unknown as NextFunction;
    mw(makeReq(null), makeRes().res, next);
    mw(makeReq(null), makeRes().res, next);
    await flush();
    expect(next).toHaveBeenCalledTimes(2);
  });
});
