import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

import {
  createPayrollCalcQueue,
  payrollQueueServerTiming,
  runInPayrollCalcSlot,
  type PayrollCalcPriority,
} from './payroll-calc-slot.js';

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Дать отработать микрозадачам (передача слота, продолжения await). */
const flush = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

const never = new AbortController().signal;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createPayrollCalcQueue', () => {
  it('одна задача за раз: вторая стартует только после первой', async () => {
    const queue = createPayrollCalcQueue();
    const first = deferred<string>();
    const secondWork = vi.fn(async () => 'b');
    const a = queue.run('normal', never, () => first.promise);
    const b = queue.run('normal', never, secondWork);
    await flush();
    expect(secondWork).not.toHaveBeenCalled();
    expect(queue.size()).toBe(2);
    first.resolve('a');
    expect(await a).toMatchObject({ status: 'done', result: 'a', depth: 0 });
    expect(await b).toMatchObject({ status: 'done', result: 'b', depth: 1 });
    expect(queue.size()).toBe(0);
  });

  it('high — перед ожидающими normal/low, но после идущей задачи и ранее поставленного high', async () => {
    const queue = createPayrollCalcQueue();
    const order: string[] = [];
    const running = deferred();
    const task = (name: string) => async () => {
      order.push(name);
    };
    const runningDone = queue.run('low', never, async () => {
      order.push('running-low');
      await running.promise;
    });
    const enqueue = (name: string, priority: PayrollCalcPriority) => queue.run(priority, never, task(name));
    const all = [
      enqueue('normal-1', 'normal'),
      enqueue('low-1', 'low'),
      enqueue('high-1', 'high'),
      enqueue('normal-2', 'normal'),
      enqueue('high-2', 'high'),
    ];
    await flush();
    expect(order).toEqual(['running-low']);
    running.resolve();
    await Promise.all([runningDone, ...all]);
    expect(order).toEqual(['running-low', 'high-1', 'high-2', 'normal-1', 'normal-2', 'low-1']);
  });

  it('отменённый в ожидании удаляется из очереди и work не вызывает', async () => {
    const queue = createPayrollCalcQueue();
    const first = deferred();
    const cancelled = new AbortController();
    const cancelledWork = vi.fn(async () => 'never');
    const nextWork = vi.fn(async () => 'next');
    const a = queue.run('normal', never, () => first.promise);
    const b = queue.run('normal', cancelled.signal, cancelledWork);
    const c = queue.run('normal', never, nextWork);
    expect(queue.size()).toBe(3);
    cancelled.abort();
    expect(await b).toMatchObject({ status: 'aborted' });
    expect(queue.size()).toBe(2);
    first.resolve();
    await a;
    expect(await c).toMatchObject({ status: 'done', result: 'next' });
    expect(cancelledWork).not.toHaveBeenCalled();
  });

  it('отменённый до постановки — сразу aborted, без work и без слота', async () => {
    const queue = createPayrollCalcQueue();
    const cancelled = new AbortController();
    cancelled.abort();
    const work = vi.fn(async () => 1);
    expect(await queue.run('high', cancelled.signal, work)).toMatchObject({ status: 'aborted' });
    expect(work).not.toHaveBeenCalled();
    expect(queue.size()).toBe(0);
  });

  it('отмена во время расчёта: расчёт доходит до конца, ответ — aborted, слот освобождается', async () => {
    const queue = createPayrollCalcQueue();
    const cancelled = new AbortController();
    const work = deferred<number>();
    const a = queue.run('normal', cancelled.signal, () => work.promise);
    const nextWork = vi.fn(async () => 'next');
    const b = queue.run('normal', never, nextWork);
    await flush();
    cancelled.abort();
    await flush();
    expect(nextWork).not.toHaveBeenCalled();
    work.resolve(42);
    expect(await a).toMatchObject({ status: 'aborted' });
    expect(await b).toMatchObject({ status: 'done', result: 'next' });
  });

  it('ошибка расчёта освобождает слот и пробрасывается', async () => {
    const queue = createPayrollCalcQueue();
    const failing = queue.run('normal', never, async () => {
      throw new Error('boom');
    });
    const next = queue.run('normal', never, async () => 'ok');
    await expect(failing).rejects.toThrow('boom');
    expect(await next).toMatchObject({ status: 'done', result: 'ok' });
    expect(queue.size()).toBe(0);
  });
});

const makeRes = () => {
  const res = new EventEmitter() as EventEmitter & { writableFinished: boolean };
  res.writableFinished = false;
  return res;
};

const makeReq = (destroyed = false) => ({
  baseUrl: '/api/payroll',
  path: '/summary',
  socket: { destroyed },
}) as unknown as Request;

describe('runInPayrollCalcSlot', () => {
  it('успех: результат, слушатель закрытия снят', async () => {
    const queue = createPayrollCalcQueue();
    const res = makeRes();
    const outcome = await runInPayrollCalcSlot(makeReq(), res as unknown as Response, 'high', async () => 'data', queue);
    expect(outcome).toMatchObject({ status: 'done', result: 'data' });
    expect(res.listenerCount('close')).toBe(0);
  });

  it('ошибка: слушатель снят, ошибка наружу', async () => {
    const queue = createPayrollCalcQueue();
    const res = makeRes();
    await expect(runInPayrollCalcSlot(makeReq(), res as unknown as Response, 'normal', async () => {
      throw new Error('boom');
    }, queue)).rejects.toThrow('boom');
    expect(res.listenerCount('close')).toBe(0);
    expect(queue.size()).toBe(0);
  });

  it('клиент закрыл соединение в ожидании — aborted без расчёта, в лог', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const queue = createPayrollCalcQueue();
    const busy = deferred();
    const running = queue.run('normal', never, () => busy.promise);
    const res = makeRes();
    const work = vi.fn(async () => 'never');
    const waiting = runInPayrollCalcSlot(makeReq(), res as unknown as Response, 'high', work, queue);
    await flush();
    res.emit('close');
    expect(await waiting).toMatchObject({ status: 'aborted' });
    expect(work).not.toHaveBeenCalled();
    expect(res.listenerCount('close')).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[payroll-queue\] \/api\/payroll\/summary high .* aborted$/));
    busy.resolve();
    await running;
  });

  it('закрытие после отправки ответа отменой не считается', async () => {
    const queue = createPayrollCalcQueue();
    const busy = deferred();
    const running = queue.run('normal', never, () => busy.promise);
    const res = makeRes();
    res.writableFinished = true;
    const waiting = runInPayrollCalcSlot(makeReq(), res as unknown as Response, 'normal', async () => 'ok', queue);
    await flush();
    res.emit('close');
    busy.resolve();
    await running;
    expect(await waiting).toMatchObject({ status: 'done', result: 'ok' });
  });

  it('сокет уже закрыт — расчёт не запускается', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const work = vi.fn(async () => 'never');
    const res = makeRes();
    const outcome = await runInPayrollCalcSlot(makeReq(true), res as unknown as Response, 'normal', work, createPayrollCalcQueue());
    expect(outcome).toMatchObject({ status: 'aborted' });
    expect(work).not.toHaveBeenCalled();
    expect(res.listenerCount('close')).toBe(0);
  });
});

describe('payrollQueueServerTiming', () => {
  it('ожидание, приоритет и глубина', () => {
    expect(payrollQueueServerTiming('normal', { waitMs: 1234.56, depth: 2 }))
      .toBe('payroll_queue;dur=1234.6;desc="normal depth=2"');
  });
});
