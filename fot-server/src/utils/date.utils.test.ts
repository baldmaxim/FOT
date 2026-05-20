import { describe, expect, it } from 'vitest';
import { moscowTodayIso } from './date.utils.js';

describe('moscowTodayIso', () => {
  it('returns Moscow calendar date in YYYY-MM-DD', () => {
    // 14:00 UTC = 17:00 MSK — обе зоны дают одно и то же число.
    const noonUtc = new Date('2026-05-20T14:00:00Z');
    expect(moscowTodayIso(noonUtc)).toBe('2026-05-20');
  });

  it('catches UTC↔MSK rollover at 22:00 UTC (01:00 next-day MSK)', () => {
    // 22:30 UTC = 01:30 MSK следующих суток. UTC slice вернул бы 2026-05-19,
    // moscowTodayIso должна вернуть 2026-05-20.
    const lateUtc = new Date('2026-05-19T22:30:00Z');
    expect(moscowTodayIso(lateUtc)).toBe('2026-05-20');
    expect(lateUtc.toISOString().slice(0, 10)).toBe('2026-05-19'); // контраст с прежним поведением
  });

  it('handles 00:30 UTC (03:30 MSK same day)', () => {
    const earlyUtc = new Date('2026-05-20T00:30:00Z');
    expect(moscowTodayIso(earlyUtc)).toBe('2026-05-20');
  });
});
