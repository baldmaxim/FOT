import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

import { httpInflight, getHttpInflight, __resetHttpInflight } from './httpInflight.js';

/**
 * Счётчик активных HTTP-запросов для диагностики graceful shutdown.
 * Критично: декремент ровно один раз — 'finish' и 'close' на успешном ответе
 * приходят оба, и двойной декремент увёл бы счётчик в минус.
 */

interface IFakeRes {
  res: Response;
  emit: (event: 'finish' | 'close') => void;
}

const makeRes = (): IFakeRes => {
  const handlers: Record<string, Array<() => void>> = {};
  const res: Record<string, unknown> = {
    on: (event: string, cb: () => void) => {
      (handlers[event] ??= []).push(cb);
      return res;
    },
  };
  return {
    res: res as unknown as Response,
    emit: (event) => (handlers[event] ?? []).forEach(cb => cb()),
  };
};

const req = {} as Request;

describe('httpInflight', () => {
  beforeEach(() => {
    __resetHttpInflight();
  });

  it('увеличивает счётчик на входе и всегда зовёт next()', () => {
    const next = vi.fn() as unknown as NextFunction;
    const { res } = makeRes();

    httpInflight(req, res, next);

    expect(getHttpInflight()).toBe(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('уменьшает счётчик на finish', () => {
    const fake = makeRes();
    httpInflight(req, fake.res, vi.fn() as unknown as NextFunction);

    fake.emit('finish');

    expect(getHttpInflight()).toBe(0);
  });

  it('уменьшает счётчик на close (клиент отвалился без ответа)', () => {
    const fake = makeRes();
    httpInflight(req, fake.res, vi.fn() as unknown as NextFunction);

    fake.emit('close');

    expect(getHttpInflight()).toBe(0);
  });

  it('не уходит в минус, если пришли и finish, и close', () => {
    const fake = makeRes();
    httpInflight(req, fake.res, vi.fn() as unknown as NextFunction);

    fake.emit('finish');
    fake.emit('close');

    expect(getHttpInflight()).toBe(0);
  });

  it('считает параллельные запросы независимо', () => {
    const a = makeRes();
    const b = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    httpInflight(req, a.res, next);
    httpInflight(req, b.res, next);
    expect(getHttpInflight()).toBe(2);

    a.emit('finish');
    a.emit('close');
    expect(getHttpInflight()).toBe(1);

    b.emit('close');
    expect(getHttpInflight()).toBe(0);
  });
});
