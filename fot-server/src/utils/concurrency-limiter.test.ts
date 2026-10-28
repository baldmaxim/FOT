import { describe, expect, it } from 'vitest';

import { createConcurrencyLimiter } from './concurrency-limiter.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 1));

describe('createConcurrencyLimiter', () => {
  it('одновременно не больше трёх, результаты — по задачам', async () => {
    const limit = createConcurrencyLimiter(3);
    let inFlight = 0;
    let maxInFlight = 0;
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) => limit(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick();
      inFlight -= 1;
      return index * 2;
    })));
    expect(maxInFlight).toBe(3);
    expect(results).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
  });

  it('упавшая задача освобождает слот — очередь досчитывается', async () => {
    const limit = createConcurrencyLimiter(1);
    const done: number[] = [];
    const settled = await Promise.allSettled([1, 2, 3].map(index => limit(async () => {
      await tick();
      if (index === 1) throw new Error('бригада 1');
      done.push(index);
      return index;
    })));
    expect(settled.map(item => item.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
    expect(done).toEqual([2, 3]);
  });

  it('новый вызов не обгоняет ожидающего, когда слот освобождается', async () => {
    const limit = createConcurrencyLimiter(1);
    let inFlight = 0;
    let maxInFlight = 0;
    const job = () => limit(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick();
      inFlight -= 1;
    });
    const first = job();
    const second = job();
    await first;
    await Promise.all([second, job()]);
    expect(maxInFlight).toBe(1);
  });
});
