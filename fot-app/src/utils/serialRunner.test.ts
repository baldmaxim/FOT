import { describe, expect, it, vi } from 'vitest';

import { createSerialRunner } from './serialRunner';

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

describe('createSerialRunner', () => {
  it('по одной, в порядке вызова', async () => {
    const run = createSerialRunner();
    const order: string[] = [];
    const first = deferred<string>();
    const a = run(async () => {
      order.push('a:start');
      const value = await first.promise;
      order.push('a:end');
      return value;
    });
    const b = run(async () => {
      order.push('b');
      return 'b';
    });
    await flush();
    expect(order).toEqual(['a:start']);
    first.resolve('a');
    expect(await a).toBe('a');
    expect(await b).toBe('b');
    expect(order).toEqual(['a:start', 'a:end', 'b']);
  });

  it('отменённая в ожидании сразу отклоняется и не запускается; следующая ждёт предыдущую', async () => {
    const run = createSerialRunner();
    const first = deferred();
    const cancelled = new AbortController();
    const cancelledTask = vi.fn(async () => 'never');
    const nextTask = vi.fn(async () => 'next');
    const a = run(() => first.promise);
    const b = run(cancelledTask, cancelled.signal);
    const c = run(nextTask);
    cancelled.abort();
    await expect(b).rejects.toMatchObject({ name: 'AbortError' });
    await flush();
    expect(nextTask).not.toHaveBeenCalled();
    first.resolve();
    await a;
    expect(await c).toBe('next');
    expect(cancelledTask).not.toHaveBeenCalled();
  });

  it('отменённая до вызова не встаёт в очередь', async () => {
    const run = createSerialRunner();
    const cancelled = new AbortController();
    cancelled.abort();
    const task = vi.fn(async () => 1);
    await expect(run(task, cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await run(async () => 2)).toBe(2);
    expect(task).not.toHaveBeenCalled();
  });

  it('ошибка задачи отдаётся ей и не останавливает очередь', async () => {
    const run = createSerialRunner();
    const failing = run(async () => {
      throw new Error('boom');
    });
    const next = run(async () => 'ok');
    await expect(failing).rejects.toThrow('boom');
    expect(await next).toBe('ok');
  });
});
