import { describe, it, expect } from 'vitest';
import { shouldRunDailyRefresh } from './mts-business-refresh-all-daily-scheduler.service.js';

// МСК = UTC+3: 2026-07-06T20:00:00Z = 06.07 23:00 МСК.

describe('shouldRunDailyRefresh', () => {
  const cfg = { enabled: true, hourMsk: 23 };

  it('выключено — не запускаем никогда', () => {
    expect(shouldRunDailyRefresh({ enabled: false, hourMsk: 23 }, null, new Date('2026-07-06T20:30:00Z'))).toBe(false);
  });

  it('до целевого часа — не запускаем', () => {
    // 22:59 МСК
    expect(shouldRunDailyRefresh(cfg, null, new Date('2026-07-06T19:59:00Z'))).toBe(false);
  });

  it('ровно в целевой час — запускаем', () => {
    // 23:00 МСК
    expect(shouldRunDailyRefresh(cfg, null, new Date('2026-07-06T20:00:00Z'))).toBe(true);
  });

  it('после целевого часа (catchup после рестарта) — запускаем', () => {
    // 23:40 МСК, последний прогон вчера
    expect(shouldRunDailyRefresh(cfg, '2026-07-05', new Date('2026-07-06T20:40:00Z'))).toBe(true);
  });

  it('уже отработали сегодня — не запускаем', () => {
    expect(shouldRunDailyRefresh(cfg, '2026-07-06', new Date('2026-07-06T20:40:00Z'))).toBe(false);
  });

  it('после полуночи прогон за вчера не наверстывается (час < целевого)', () => {
    // 00:30 МСК 07.07: ymd уже 2026-07-07, час 0 < 23
    expect(shouldRunDailyRefresh(cfg, '2026-07-06', new Date('2026-07-06T21:30:00Z'))).toBe(false);
  });

  it('час 0 (полночь МСК) — запускается в любой час суток', () => {
    const midnightCfg = { enabled: true, hourMsk: 0 };
    // 00:05 МСК 07.07
    expect(shouldRunDailyRefresh(midnightCfg, '2026-07-06', new Date('2026-07-06T21:05:00Z'))).toBe(true);
    expect(shouldRunDailyRefresh(midnightCfg, '2026-07-07', new Date('2026-07-06T21:05:00Z'))).toBe(false);
  });
});
