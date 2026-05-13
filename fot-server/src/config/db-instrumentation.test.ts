import { describe, expect, it } from 'vitest';
import { getDbInflight, withDbSlot } from './db-instrumentation.js';

describe('withDbSlot', () => {
  it('инкрементит inflight и декрементит после успеха', async () => {
    const before = getDbInflight();
    const promise = withDbSlot('test', async () => {
      expect(getDbInflight()).toBe(before + 1);
      return 'ok';
    });
    expect(getDbInflight()).toBe(before + 1);
    const result = await promise;
    expect(result).toBe('ok');
    expect(getDbInflight()).toBe(before);
  });

  it('декрементит inflight даже при throw', async () => {
    const before = getDbInflight();
    await expect(
      withDbSlot('test', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(getDbInflight()).toBe(before);
  });

  it('параллельные slots суммируются', async () => {
    const before = getDbInflight();
    let observed = 0;
    const tasks = Array.from({ length: 4 }, () =>
      withDbSlot('test', async () => {
        observed = Math.max(observed, getDbInflight());
        await new Promise((r) => setTimeout(r, 10));
      }),
    );
    await Promise.all(tasks);
    expect(observed).toBeGreaterThanOrEqual(before + 4);
    expect(getDbInflight()).toBe(before);
  });
});
