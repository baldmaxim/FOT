import * as Sentry from '@sentry/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetPgFailureCaptureForTests, withPgRetry } from './sigur-runtime-state.service.js';

class PgError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

describe('withPgRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(Sentry.captureMessage).mockClear();
    vi.mocked(Sentry.captureException).mockClear();
    __resetPgFailureCaptureForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ретраит SQLSTATE 25006 и возвращает результат при успехе', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new PgError('cannot execute INSERT in a read-only transaction', '25006');
      return 'ok';
    });

    const promise = withPgRetry('test-25006', fn);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('после исчерпания ретраев на 25006 шлёт rate-limited warning и пробрасывает ошибку', async () => {
    const err = new PgError('cannot execute INSERT in a read-only transaction', '25006');
    const fn = vi.fn(async () => { throw err; });

    const promise = withPgRetry('test-25006-persistent', fn);
    // Подписываемся на rejection до advanceTimers, иначе vitest считает rejection unhandled.
    const expectation = expect(promise).rejects.toThrow('read-only transaction');
    await vi.runAllTimersAsync();
    await expectation;

    // 5 ретраев + первая попытка = 6 вызовов
    expect(fn).toHaveBeenCalledTimes(6);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'pg_transient_failure_persistent',
      expect.objectContaining({
        level: 'warning',
        extra: expect.objectContaining({ sqlstate: '25006' }),
      }),
    );
  });

  it('ретраит SQLSTATE 57P01 (admin_shutdown)', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 2) throw new PgError('terminating connection due to administrator command', '57P01');
      return 'ok';
    });

    const promise = withPgRetry('test-57p01', fn);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('не ретраит не-транзитную ошибку и не шлёт warning', async () => {
    const err = new PgError('there is no unique or exclusion constraint matching the ON CONFLICT specification', '42P10');
    const fn = vi.fn(async () => { throw err; });

    await expect(withPgRetry('test-42p10', fn)).rejects.toThrow('ON CONFLICT');

    expect(fn).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('rate-limit: вторая persistent-ошибка в течение интервала не дублирует Sentry-warning', async () => {
    const err = new PgError('cannot execute INSERT in a read-only transaction', '25006');
    const fn = vi.fn(async () => { throw err; });

    const p1 = withPgRetry('first', fn);
    const ex1 = expect(p1).rejects.toThrow();
    await vi.runAllTimersAsync();
    await ex1;
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);

    const p2 = withPgRetry('second', fn);
    const ex2 = expect(p2).rejects.toThrow();
    await vi.runAllTimersAsync();
    await ex2;
    // Прошло меньше 5 минут — capture не повторяется.
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
  });
});
