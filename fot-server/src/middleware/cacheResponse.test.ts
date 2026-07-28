import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { cacheResponse } from './cacheResponse.js';

interface IFakeRes {
  statusCode: number;
  headers: Record<string, string>;
  jsonBody?: object;
  finishCallbacks: Array<() => void>;
  closeCallbacks: Array<() => void>;
  setHeader(name: string, value: string): void;
  status(code: number): IFakeRes;
  json(body: object): IFakeRes;
  on(event: string, cb: () => void): IFakeRes;
}

function createFakeRes(): IFakeRes {
  const res: IFakeRes = {
    statusCode: 200,
    headers: {},
    finishCallbacks: [],
    closeCallbacks: [],
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.jsonBody = body;
      this.finishCallbacks.forEach((cb) => cb());
      return this;
    },
    on(event, cb) {
      if (event === 'finish') this.finishCallbacks.push(cb);
      if (event === 'close') this.closeCallbacks.push(cb);
      return this;
    },
  };
  return res;
}

const baseReq = {} as Request;

describe('cacheResponse middleware', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('кеширует первый успешный ответ и отдаёт HIT повторно', () => {
    const middleware = cacheResponse(() => 'k', 1000);
    const next1 = vi.fn();
    const res1 = createFakeRes() as unknown as Response & IFakeRes;
    middleware(baseReq, res1, next1 as NextFunction);
    expect(next1).toHaveBeenCalledTimes(1);
    expect(res1.headers['X-Cache-Status']).toBe('MISS');
    res1.json({ value: 1 });

    const next2 = vi.fn();
    const res2 = createFakeRes() as unknown as Response & IFakeRes;
    middleware(baseReq, res2, next2 as NextFunction);
    expect(next2).not.toHaveBeenCalled();
    expect(res2.jsonBody).toEqual({ value: 1 });
    expect(res2.headers['X-Cache-Status']).toBe('HIT');
  });

  it('single-flight: 5 параллельных cache miss → fetcher вызывается один раз', async () => {
    let fetchCount = 0;
    const middleware = cacheResponse(() => 'k', 1000);

    const requests = Array.from({ length: 5 }, () => {
      const res = createFakeRes() as unknown as Response & IFakeRes;
      const next = vi.fn(() => {
        fetchCount++;
        setTimeout(() => res.json({ value: 'computed' }), 10);
      });
      middleware(baseReq, res, next as NextFunction);
      return res;
    });

    await new Promise((r) => setTimeout(r, 30));

    expect(fetchCount).toBe(1);
    for (const res of requests) {
      expect(res.jsonBody).toEqual({ value: 'computed' });
    }
    const statuses = requests.map((r) => r.headers['X-Cache-Status']);
    expect(statuses.filter((s) => s === 'MISS')).toHaveLength(1);
    expect(statuses.filter((s) => s === 'COALESCED')).toHaveLength(4);
  });

  it('SWR: после истечения ttl отдаёт STALE и триггерит refresh ровно один раз', async () => {
    let refreshCalls = 0;
    const refresh = vi.fn(async () => {
      refreshCalls++;
      return { value: 'refreshed' };
    });
    const middleware = cacheResponse(() => 'k', 50, { staleMs: 1000, refresh });

    const r1 = createFakeRes() as unknown as Response & IFakeRes;
    middleware(baseReq, r1, vi.fn() as NextFunction);
    r1.json({ value: 'initial' });

    await new Promise((r) => setTimeout(r, 70));

    // Параллельно 5 stale-hit'ов
    const stales = Array.from({ length: 5 }, () => {
      const res = createFakeRes() as unknown as Response & IFakeRes;
      middleware(baseReq, res, vi.fn() as NextFunction);
      return res;
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(stales.every((r) => r.jsonBody && (r.jsonBody as { value: string }).value === 'initial')).toBe(true);
    expect(stales.every((r) => r.headers['X-Cache-Status'] === 'STALE')).toBe(true);
    expect(refreshCalls).toBe(1);
  });

  it('SWR: при ошибке refresh кеш-окно продлевается и stale остаётся доступен', async () => {
    const refresh = vi.fn(async () => {
      throw new Error('boom');
    });
    const middleware = cacheResponse(() => 'k', 50, { staleMs: 200, refresh });

    const r1 = createFakeRes() as unknown as Response & IFakeRes;
    middleware(baseReq, r1, vi.fn() as NextFunction);
    r1.json({ value: 'orig' });

    await new Promise((r) => setTimeout(r, 70));

    const r2 = createFakeRes() as unknown as Response & IFakeRes;
    middleware(baseReq, r2, vi.fn() as NextFunction);
    expect(r2.jsonBody).toEqual({ value: 'orig' });
    expect(r2.headers['X-Cache-Status']).toBe('STALE');

    await new Promise((r) => setTimeout(r, 50));

    // Несмотря на провалившийся refresh — следующий запрос всё ещё видит старое значение,
    // окно продлено на STALE_EXTEND_ON_FAILURE_MS (5 мин).
    const r3 = createFakeRes() as unknown as Response & IFakeRes;
    middleware(baseReq, r3, vi.fn() as NextFunction);
    expect(r3.jsonBody).toEqual({ value: 'orig' });
    expect(r3.headers['X-Cache-Status']).toBe('STALE');
  });

  it('5xx-ответы НЕ кешируются', () => {
    const middleware = cacheResponse(() => 'k', 1000);

    const r1 = createFakeRes() as unknown as Response & IFakeRes;
    middleware(baseReq, r1, vi.fn() as NextFunction);
    r1.statusCode = 500;
    r1.json({ error: 'fail' });

    const next2 = vi.fn();
    const r2 = createFakeRes() as unknown as Response & IFakeRes;
    middleware(baseReq, r2, next2 as NextFunction);
    expect(next2).toHaveBeenCalledTimes(1);
  });

  it('invalidate() сбрасывает запись и следующий запрос идёт в next()', () => {
    const middleware = cacheResponse(() => 'k', 1000);
    const r1 = createFakeRes() as unknown as Response & IFakeRes;
    middleware(baseReq, r1, vi.fn() as NextFunction);
    r1.json({ value: 1 });

    middleware.invalidate();

    const next2 = vi.fn();
    const r2 = createFakeRes() as unknown as Response & IFakeRes;
    middleware(baseReq, r2, next2 as NextFunction);
    expect(next2).toHaveBeenCalledTimes(1);
  });

  it('invalidate() во время in-flight: запрос старого поколения не воскрешает кеш', async () => {
    const middleware = cacheResponse(() => 'k', 1000);

    // GET#1 — MISS, handler «завис» и ещё не ответил.
    const next1 = vi.fn();
    const r1 = createFakeRes() as unknown as Response & IFakeRes;
    middleware(baseReq, r1, next1 as NextFunction);
    expect(r1.headers['X-Cache-Status']).toBe('MISS');

    // Мутация (DELETE) — write-through инвалидация.
    middleware.invalidate();

    // GET#2 не должен присоединяться к in-flight старого поколения.
    const next2 = vi.fn();
    const r2 = createFakeRes() as unknown as Response & IFakeRes;
    middleware(baseReq, r2, next2 as NextFunction);
    expect(r2.headers['X-Cache-Status']).toBe('MISS');
    expect(next2).toHaveBeenCalledTimes(1);

    // Свежий ответ приходит первым, следом — устаревший от GET#1.
    r2.json({ value: 'fresh' });
    r1.json({ value: 'stale' });
    await Promise.resolve();

    // GET#3 обязан увидеть свежее тело, а не воскрешённое старое.
    const next3 = vi.fn();
    const r3 = createFakeRes() as unknown as Response & IFakeRes;
    middleware(baseReq, r3, next3 as NextFunction);
    expect(next3).not.toHaveBeenCalled();
    expect(r3.headers['X-Cache-Status']).toBe('HIT');
    expect(r3.jsonBody).toEqual({ value: 'fresh' });
  });

  it('после invalidate() COALESCED-клиент старого поколения не зависает на close', async () => {
    const middleware = cacheResponse(() => 'k', 1000);

    const r1 = createFakeRes() as unknown as Response & IFakeRes;
    middleware(baseReq, r1, vi.fn() as NextFunction);

    // Клиент присоединился к in-flight ДО инвалидации.
    const nextC = vi.fn();
    const rc = createFakeRes() as unknown as Response & IFakeRes;
    middleware(baseReq, rc, nextC as NextFunction);
    expect(rc.headers['X-Cache-Status']).toBe('COALESCED');

    middleware.invalidate();

    const r2 = createFakeRes() as unknown as Response & IFakeRes;
    middleware(baseReq, r2, vi.fn() as NextFunction);
    expect(r2.headers['X-Cache-Status']).toBe('MISS');

    // GET#1 оборвался — pending старого поколения обязан резолвнуться,
    // иначе присоединённый клиент завис бы навсегда.
    r1.closeCallbacks.forEach((cb) => cb());
    await Promise.resolve();
    await Promise.resolve();

    expect(nextC).toHaveBeenCalledTimes(1);
  });

  it('после invalidate() COALESCED-клиент старого поколения освобождается по single-flight таймауту', async () => {
    vi.useFakeTimers();
    try {
      const middleware = cacheResponse(() => 'k', 1000);

      const r1 = createFakeRes() as unknown as Response & IFakeRes;
      middleware(baseReq, r1, vi.fn() as NextFunction);

      const nextC = vi.fn();
      const rc = createFakeRes() as unknown as Response & IFakeRes;
      middleware(baseReq, rc, nextC as NextFunction);
      expect(rc.headers['X-Cache-Status']).toBe('COALESCED');

      middleware.invalidate();

      const r2 = createFakeRes() as unknown as Response & IFakeRes;
      middleware(baseReq, r2, vi.fn() as NextFunction);
      expect(r2.headers['X-Cache-Status']).toBe('MISS');

      // GET#1 так и не ответил — срабатывает SINGLE_FLIGHT_TIMEOUT_MS (10 c).
      await vi.advanceTimersByTimeAsync(10_001);

      expect(nextC).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidateKey() точечный: не отменяет кеширование параллельного in-flight по другому ключу', async () => {
    const middleware = cacheResponse((req) => (req as unknown as { cacheKey: string }).cacheKey, 1000);
    const reqA = { cacheKey: 'A' } as unknown as Request;
    const reqB = { cacheKey: 'B' } as unknown as Request;

    const rA = createFakeRes() as unknown as Response & IFakeRes;
    middleware(reqA, rA, vi.fn() as NextFunction);
    const rB = createFakeRes() as unknown as Response & IFakeRes;
    middleware(reqB, rB, vi.fn() as NextFunction);

    middleware.invalidateKey('A');

    rA.json({ value: 'A-stale' });
    rB.json({ value: 'B-fresh' });
    await Promise.resolve();

    // B не задет инвалидацией A — его ответ закеширован.
    const nextB2 = vi.fn();
    const rB2 = createFakeRes() as unknown as Response & IFakeRes;
    middleware(reqB, rB2, nextB2 as NextFunction);
    expect(nextB2).not.toHaveBeenCalled();
    expect(rB2.headers['X-Cache-Status']).toBe('HIT');
    expect(rB2.jsonBody).toEqual({ value: 'B-fresh' });

    // A инвалидирован во время запроса — его устаревший ответ в кеш не попал.
    const nextA2 = vi.fn();
    const rA2 = createFakeRes() as unknown as Response & IFakeRes;
    middleware(reqA, rA2, nextA2 as NextFunction);
    expect(nextA2).toHaveBeenCalledTimes(1);
    expect(rA2.headers['X-Cache-Status']).toBe('MISS');
  });
});
