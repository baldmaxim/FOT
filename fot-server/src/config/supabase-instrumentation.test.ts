import { describe, expect, it } from 'vitest';
import { getSupabaseInflight, withSupabaseSlot } from './supabase-instrumentation.js';

describe('withSupabaseSlot', () => {
  it('инкрементит inflight и декрементит после успеха', async () => {
    const before = getSupabaseInflight();
    const promise = withSupabaseSlot('test', async () => {
      expect(getSupabaseInflight()).toBe(before + 1);
      return 'ok';
    });
    expect(getSupabaseInflight()).toBe(before + 1);
    const result = await promise;
    expect(result).toBe('ok');
    expect(getSupabaseInflight()).toBe(before);
  });

  it('декрементит inflight даже при throw', async () => {
    const before = getSupabaseInflight();
    await expect(
      withSupabaseSlot('test', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(getSupabaseInflight()).toBe(before);
  });

  it('параллельные slots суммируются', async () => {
    const before = getSupabaseInflight();
    let observed = 0;
    const tasks = Array.from({ length: 4 }, () =>
      withSupabaseSlot('test', async () => {
        observed = Math.max(observed, getSupabaseInflight());
        await new Promise((r) => setTimeout(r, 10));
      }),
    );
    await Promise.all(tasks);
    expect(observed).toBeGreaterThanOrEqual(before + 4);
    expect(getSupabaseInflight()).toBe(before);
  });
});
